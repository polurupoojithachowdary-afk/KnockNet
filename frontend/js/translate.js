import { authenticatedFetch } from './api.js';
import { recordingToWav } from './audio.js';

export const DEFAULT_LANGUAGES = [
  { code: 'te', name: 'Telugu' }, { code: 'en', name: 'English' },
  { code: 'hi', name: 'Hindi' }, { code: 'ta', name: 'Tamil' },
  { code: 'es', name: 'Spanish' }, { code: 'fr', name: 'French' }
];

/** Push-to-talk: microphone -> PCM WAV -> backend Whisper -> Riva translation. */
export class TranslateManager {
  constructor(options = {}) {
    this.onSubtitle = options.onSubtitle || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onError = options.onError || console.error;
    this.sendToPeer = options.sendToPeer || (() => {});
    this.languages = [...DEFAULT_LANGUAGES];
    this.sourceLang = 'te';
    this.targetLang = 'en';
    this.configured = false;
    this.recording = false;
    this.processing = false;
    this.destroyed = false;
    this.mediaRecorder = null;
    this.recordingTimeout = null;
    this.audioChunks = [];
  }

  async init() {
    try {
      const res = await authenticatedFetch('/api/translate/languages');
      const data = await res.json();
      this.configured = res.ok && data.success && data.configured === true;
      if (this.configured && data.languages?.length) this.languages = data.languages;
    } catch (error) {
      this.configured = false;
      console.warn('Translation availability check failed:', error.message);
    }
    return this;
  }

  setSourceLanguage(code) { this.sourceLang = code; }
  setTargetLanguage(code) { this.targetLang = code; }

  startRecording(localStream) {
    if (this.recording || this.processing || this.destroyed) return;
    if (!this.configured) return this.onError('Voice translation is currently unavailable.');
    const tracks = localStream?.getAudioTracks().filter(t => t.readyState === 'live' && t.enabled);
    if (!tracks?.length) return this.onError('Enable your microphone before translating.');
    if (!window.MediaRecorder) return this.onError('Audio recording is not supported in this browser.');
    try {
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']
        .find(type => MediaRecorder.isTypeSupported(type));
      this.audioChunks = [];
      this.recordingLanguages = { source: this.sourceLang, target: this.targetLang };
      this.mediaRecorder = new MediaRecorder(new MediaStream(tracks), mimeType ? { mimeType } : {});
      this.mediaRecorder.ondataavailable = event => {
        if (event.data.size) this.audioChunks.push(event.data);
      };
      this.mediaRecorder.onstop = () => {
        clearTimeout(this.recordingTimeout);
        this.recording = false;
        if (!this.destroyed) this.processRecording();
      };
      this.mediaRecorder.onerror = () => {
        clearTimeout(this.recordingTimeout);
        this.recording = false;
        this.onStateChange({ recording: false, processing: false });
        this.onError('Microphone recording failed. Please try again.');
      };
      this.mediaRecorder.start();
      this.recording = true;
      this.onStateChange({ recording: true });
      // Leave room for browser scheduling and encoder padding under the server's 30s limit.
      this.recordingTimeout = setTimeout(() => this.stopRecording(), 28000);
    } catch (error) {
      this.onError('Could not record your microphone: ' + error.message);
    }
  }

  stopRecording() {
    if (!this.recording) return;
    clearTimeout(this.recordingTimeout);
    this.recording = false;
    this.processing = true;
    this.onStateChange({ recording: false, processing: true });
    if (this.mediaRecorder?.state !== 'inactive') this.mediaRecorder.stop();
  }

  async translateText(text, sourceLang, targetLang) {
    const res = await authenticatedFetch('/api/translate/text', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sourceLang, targetLang })
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.message || 'Translation is unavailable.');
    return data.translated;
  }

  async processRecording() {
    this.processing = true;
    this.onStateChange({ recording: false, processing: true });
    try {
      const recording = new Blob(this.audioChunks, { type: this.mediaRecorder.mimeType });
      if (!recording.size) throw new Error('Hold the button while speaking, then release it.');
      const wav = await recordingToWav(recording);
      const form = new FormData();
      form.append('audio', wav, 'recording.wav');
      form.append('sourceLang', this.recordingLanguages.source);
      form.append('targetLang', this.recordingLanguages.target);
      const res = await authenticatedFetch('/api/translate', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || 'Translation is unavailable.');
      if (!data.translated?.trim()) throw new Error('No speech detected. Try speaking closer to the microphone.');
      if (!this.destroyed) this.emitTranslation(data.original, data.translated, data.targetLanguage);
    } catch (error) {
      if (!this.destroyed) this.onError(error.message);
    } finally {
      this.processing = false;
      this.audioChunks = [];
      if (!this.destroyed) this.onStateChange({ processing: false });
    }
  }

  emitTranslation(original, translated, targetLanguage) {
    this.onSubtitle({ original, translated, targetLanguage });
    this.speak(translated, targetLanguage);
    this.sendToPeer({ type: 'translation-subtitle', original, translated, targetLanguage });
  }

  speak(text, languageCode = 'en') {
    if (!window.speechSynthesis || !text) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = languageCode;
    const voice = window.speechSynthesis.getVoices().find(v => v.lang.startsWith(languageCode));
    if (voice) utterance.voice = voice;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.recordingTimeout);
    if (this.mediaRecorder?.state === 'recording') this.mediaRecorder.stop();
    window.speechSynthesis?.cancel();
    this.recording = false;
  }
}

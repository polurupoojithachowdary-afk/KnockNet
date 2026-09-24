import { authenticatedFetch } from './api.js';

/**
 * Knocknet Push-to-Talk Voice Translation Module
 *
 * Records audio while the user holds the translate button, sends the
 * complete utterance to the backend for NVIDIA ASR + NMT, then displays
 * the translated subtitle and speaks it via the browser SpeechSynthesis API.
 *
 * Everything is plug-and-play from the user's perspective — no API keys,
 * no setup, just hold the button and speak.
 */
export class TranslateManager {
  constructor(options = {}) {
    this.onSubtitle = options.onSubtitle || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onError = options.onError || console.error;
    this.sendToPeer = options.sendToPeer || (() => {});

    this.enabled = false;
    this.recording = false;
    this.sourceLang = 'en';
    this.targetLang = 'hi';
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.languages = [];
    this.configured = false;
  }

  /**
   * Fetches available languages from the backend and checks if
   * the NVIDIA API is configured on the server.
   */
  async init() {
    try {
      const res = await authenticatedFetch('/api/translate/languages');
      const data = await res.json();
      if (data.success) {
        this.languages = data.languages || [];
        this.configured = data.configured;
      }
    } catch (e) {
      console.warn('Translation service unavailable:', e.message);
      this.configured = false;
    }
    return this;
  }

  /** Toggle the translation feature on or off. */
  toggle() {
    this.enabled = !this.enabled;
    this.onStateChange({ enabled: this.enabled });
    return this.enabled;
  }

  setSourceLanguage(code) {
    this.sourceLang = code;
  }

  setTargetLanguage(code) {
    this.targetLang = code;
  }

  /**
   * Start recording audio from the local microphone stream.
   * Called when the user presses the translate button.
   */
  startRecording(localStream) {
    if (this.recording || !localStream) return;

    const audioTracks = localStream.getAudioTracks();
    if (!audioTracks.length) {
      this.onError('No microphone available for translation');
      return;
    }

    // Create a stream with only the audio track for the MediaRecorder
    const audioOnlyStream = new MediaStream(audioTracks);

    this.audioChunks = [];
    try {
      // Prefer webm/opus for smaller payloads; fall back to whatever is supported
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';

      this.mediaRecorder = mimeType
        ? new MediaRecorder(audioOnlyStream, { mimeType })
        : new MediaRecorder(audioOnlyStream);

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this.processRecording();
      };

      this.mediaRecorder.start();
      this.recording = true;
      this.onStateChange({ recording: true });
    } catch (e) {
      this.onError('Could not start recording: ' + e.message);
    }
  }

  /**
   * Stop recording and trigger the translation pipeline.
   * Called when the user releases the translate button.
   */
  stopRecording() {
    if (!this.recording || !this.mediaRecorder) return;

    try {
      this.mediaRecorder.stop();
    } catch (e) {
      // Recorder may already be inactive
    }
    this.recording = false;
    this.onStateChange({ recording: false, processing: true });
  }

  /**
   * Sends the recorded audio blob to the backend translation endpoint,
   * displays the subtitle, and speaks the translated text.
   */
  async processRecording() {
    if (!this.audioChunks.length) {
      this.onStateChange({ processing: false });
      return;
    }

    const audioBlob = new Blob(this.audioChunks, {
      type: this.mediaRecorder?.mimeType || 'audio/webm'
    });

    // Sanity check: ignore very short recordings (< 0.5s of audio is likely noise)
    if (audioBlob.size < 1000) {
      this.onStateChange({ processing: false });
      return;
    }

    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');
    formData.append('sourceLang', this.sourceLang);
    formData.append('targetLang', this.targetLang);

    try {
      const res = await authenticatedFetch('/api/translate', {
        method: 'POST',
        body: formData
        // Note: Do NOT set Content-Type header — browser sets it with boundary
      });

      const data = await res.json();

      if (!data.success) {
        this.onError(data.message || 'Translation failed');
        this.onStateChange({ processing: false });
        return;
      }

      if (data.translated && data.translated.trim()) {
        // Show subtitle on screen
        this.onSubtitle({
          original: data.original,
          translated: data.translated,
          targetLanguage: data.targetLanguage
        });

        // Speak the translated text via browser TTS
        this.speak(data.translated, data.targetLanguage);

        // Send to peer via WebRTC DataChannel so they see the subtitle
        this.sendToPeer({
          type: 'translation',
          original: data.original,
          translated: data.translated,
          targetLanguage: data.targetLanguage
        });
      }
    } catch (e) {
      this.onError('Translation request failed: ' + e.message);
    } finally {
      this.onStateChange({ processing: false });
    }
  }

  /**
   * Speak text using the browser's built-in SpeechSynthesis API.
   * Free, instant, supports 50+ languages, no API call needed.
   */
  speak(text, languageCode) {
    if (!window.speechSynthesis || !text) return;

    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = this.mapToSpeechSynthesisLang(languageCode);
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    // Try to find a voice that matches the target language
    const voices = window.speechSynthesis.getVoices();
    const matchingVoice = voices.find(v => v.lang.startsWith(languageCode)) ||
                          voices.find(v => v.lang.startsWith(languageCode.split('-')[0]));
    if (matchingVoice) {
      utterance.voice = matchingVoice;
    }

    window.speechSynthesis.speak(utterance);
  }

  /** Map our language codes to BCP-47 for SpeechSynthesis. */
  mapToSpeechSynthesisLang(code) {
    const map = {
      'en': 'en-US', 'hi': 'hi-IN', 'te': 'te-IN', 'ta': 'ta-IN',
      'bn': 'bn-IN', 'mr': 'mr-IN', 'gu': 'gu-IN', 'kn': 'kn-IN',
      'ml': 'ml-IN', 'pa': 'pa-IN', 'ur': 'ur-PK', 'es': 'es-ES',
      'fr': 'fr-FR', 'de': 'de-DE', 'pt': 'pt-BR', 'it': 'it-IT',
      'ru': 'ru-RU', 'ja': 'ja-JP', 'ko': 'ko-KR', 'zh': 'zh-CN',
      'ar': 'ar-SA', 'tr': 'tr-TR', 'vi': 'vi-VN', 'th': 'th-TH',
      'id': 'id-ID', 'ms': 'ms-MY', 'nl': 'nl-NL', 'pl': 'pl-PL',
      'sv': 'sv-SE', 'da': 'da-DK', 'fi': 'fi-FI', 'no': 'nb-NO',
      'uk': 'uk-UA', 'he': 'he-IL', 'ro': 'ro-RO', 'cs': 'cs-CZ'
    };
    return map[code] || code;
  }

  /** Handle incoming translation messages from peers (via DataChannel). */
  handlePeerTranslation(data) {
    if (data.type === 'translation') {
      this.onSubtitle({
        original: data.original,
        translated: data.translated,
        targetLanguage: data.targetLanguage,
        fromPeer: true
      });

      // Optionally speak peer translations too
      this.speak(data.translated, data.targetLanguage);
    }
  }

  destroy() {
    if (this.mediaRecorder && this.recording) {
      try { this.mediaRecorder.stop(); } catch (e) {}
    }
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    this.enabled = false;
    this.recording = false;
  }
}

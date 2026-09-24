import { authenticatedFetch } from './api.js';

/**
 * Knocknet Push-to-Talk Voice Translation Module
 *
 * Powered by NVIDIA Riva Neural Machine Translation (riva-translate-4b-instruct-v2)
 * & OpenAI Whisper Large v3 ASR via NVIDIA NIM API.
 *
 * Supports Telugu (te) to English (en), Hindi, Tamil, Spanish, and 30+ languages.
 * Supports on-device SpeechRecognition (Chrome/Edge) with backend & direct NVIDIA fallbacks.
 */

export const DEFAULT_LANGUAGES = [
  { code: 'te', name: 'Telugu' },
  { code: 'en', name: 'English' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ta', name: 'Tamil' },
  { code: 'bn', name: 'Bengali' },
  { code: 'mr', name: 'Marathi' },
  { code: 'gu', name: 'Gujarati' },
  { code: 'kn', name: 'Kannada' },
  { code: 'ml', name: 'Malayalam' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'ja', name: 'Japanese' },
  { code: 'zh', name: 'Chinese' },
  { code: 'ar', name: 'Arabic' },
  { code: 'ru', name: 'Russian' }
];

const NVIDIA_DIRECT_KEY = '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';

export class TranslateManager {
  constructor(options = {}) {
    this.onSubtitle = options.onSubtitle || (() => {});
    this.onStateChange = options.onStateChange || (() => {});
    this.onError = options.onError || console.error;
    this.sendToPeer = options.sendToPeer || (() => {});

    this.enabled = false;
    this.recording = false;
    this.sourceLang = 'te';
    this.targetLang = 'en';
    this.mediaRecorder = null;
    this.audioChunks = [];
    this.languages = [...DEFAULT_LANGUAGES];
    this.configured = true;

    this.speechRecognition = null;
    this.recognizedSpeechText = '';
  }

  /**
   * Fetches available languages from the backend and checks if
   * the NVIDIA API is configured on the server.
   */
  async init() {
    try {
      const res = await authenticatedFetch('/api/translate/languages');
      const data = await res.json();
      if (data.success && Array.isArray(data.languages) && data.languages.length > 0) {
        this.languages = data.languages;
        this.configured = data.configured !== false;
      }
    } catch (e) {
      console.warn('Backend translation service not reachable, using client NVIDIA fallback:', e.message);
      this.configured = true;
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
   * Creates and starts on-device speech recognition if supported by browser.
   */
  _startSpeechRecognition() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return;

    try {
      this.recognizedSpeechText = '';
      this.speechRecognition = new SpeechRec();
      this.speechRecognition.continuous = true;
      this.speechRecognition.interimResults = true;
      this.speechRecognition.lang = this.mapToSpeechRecognitionLang(this.sourceLang);

      this.speechRecognition.onresult = (event) => {
        let transcript = '';
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript + ' ';
        }
        this.recognizedSpeechText = transcript.trim();
      };

      this.speechRecognition.onerror = (e) => {
        console.warn('Speech recognition notice:', e.error);
      };

      this.speechRecognition.start();
    } catch (e) {
      console.warn('Could not start webkitSpeechRecognition:', e.message);
      this.speechRecognition = null;
    }
  }

  _stopSpeechRecognition() {
    if (this.speechRecognition) {
      try {
        this.speechRecognition.stop();
      } catch (e) {}
    }
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

    // Start speech recognition in parallel
    this._startSpeechRecognition();

    const audioOnlyStream = new MediaStream(audioTracks);
    this.audioChunks = [];

    try {
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
    if (!this.recording) return;

    this._stopSpeechRecognition();

    if (this.mediaRecorder) {
      try {
        this.mediaRecorder.stop();
      } catch (e) {}
    }
    this.recording = false;
    this.onStateChange({ recording: false, processing: true });
  }

  /**
   * Translates text using NVIDIA Riva Translate 4B Instruct v2.
   * Attempts backend /api/translate/text first, falls back to direct NVIDIA API.
   */
  async translateText(text, srcLang, tgtLang) {
    // 1. Try Spring Boot backend
    try {
      const res = await authenticatedFetch('/api/translate/text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          sourceLang: srcLang,
          targetLang: tgtLang
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data.success && data.translated) {
          return data.translated.trim();
        }
      }
    } catch (e) {
      // Backend not running (e.g. standalone Vercel preview or demo mode)
    }

    // 2. Direct NVIDIA NIM API call using Riva Translate 4B Instruct v2
    const pairTag = `${srcLang.toLowerCase().split('-')[0]}-${tgtLang.toLowerCase().split('-')[0]}`;
    const nvidiaRes = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NVIDIA_DIRECT_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'nvidia/riva-translate-4b-instruct-v2',
        messages: [
          { role: 'system', content: pairTag },
          { role: 'user', content: text }
        ],
        temperature: 0.1,
        max_tokens: 512
      })
    });

    if (!nvidiaRes.ok) {
      throw new Error(`NVIDIA translation failed: ${nvidiaRes.status}`);
    }

    const nvidiaData = await nvidiaRes.json();
    const content = nvidiaData?.choices?.[0]?.message?.content;
    return content ? content.trim() : '';
  }

  /**
   * Sends the recorded utterance to the translation pipeline,
   * displays the subtitle, and speaks the translated text.
   */
  async processRecording() {
    const speechText = this.recognizedSpeechText?.trim();

    try {
      // Scenario A: We captured recognized text via Web Speech API
      if (speechText) {
        const translated = await this.translateText(speechText, this.sourceLang, this.targetLang);

        if (translated) {
          this.emitTranslation(speechText, translated, this.targetLang);
          return;
        }
      }

      // Scenario B: Fall back to sending raw audio to backend
      if (!this.audioChunks.length) {
        this.onStateChange({ processing: false });
        return;
      }

      const audioBlob = new Blob(this.audioChunks, {
        type: this.mediaRecorder?.mimeType || 'audio/webm'
      });

      if (audioBlob.size < 1000) {
        this.onStateChange({ processing: false });
        return;
      }

      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');
      formData.append('sourceLang', this.sourceLang);
      formData.append('targetLang', this.targetLang);

      const res = await authenticatedFetch('/api/translate', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.message || 'Translation failed');
      }

      if (data.translated && data.translated.trim()) {
        this.emitTranslation(data.original, data.translated, data.targetLanguage);
      }
    } catch (e) {
      console.error('Translation error:', e);
      this.onError('Translation notice: ' + e.message);
    } finally {
      this.onStateChange({ processing: false });
    }
  }

  /**
   * Handles subtitle display, speech synthesis, and WebRTC peer broadcast.
   */
  emitTranslation(original, translated, targetLanguage) {
    this.onSubtitle({
      original,
      translated,
      targetLanguage
    });

    // Speak translated text via browser SpeechSynthesis
    this.speak(translated, targetLanguage);

    // Send to peer via WebRTC DataChannel
    this.sendToPeer({
      type: 'translation',
      original,
      translated,
      targetLanguage
    });
  }

  /**
   * Speak text using the browser's built-in SpeechSynthesis API.
   */
  speak(text, languageCode) {
    if (!window.speechSynthesis || !text) return;

    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = this.mapToSpeechSynthesisLang(languageCode);
    utterance.rate = 0.95;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    const voices = window.speechSynthesis.getVoices();
    const matchingVoice = voices.find(v => v.lang.startsWith(languageCode)) ||
                          voices.find(v => v.lang.startsWith(languageCode.split('-')[0]));
    if (matchingVoice) {
      utterance.voice = matchingVoice;
    }

    window.speechSynthesis.speak(utterance);
  }

  mapToSpeechRecognitionLang(code) {
    const map = {
      'te': 'te-IN',
      'en': 'en-US',
      'hi': 'hi-IN',
      'ta': 'ta-IN',
      'bn': 'bn-IN',
      'mr': 'mr-IN',
      'gu': 'gu-IN',
      'kn': 'kn-IN',
      'ml': 'ml-IN',
      'es': 'es-ES',
      'fr': 'fr-FR',
      'de': 'de-DE',
      'ja': 'ja-JP',
      'zh': 'zh-CN',
      'ar': 'ar-SA',
      'ru': 'ru-RU'
    };
    return map[code] || code;
  }

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

      this.speak(data.translated, data.targetLanguage);
    }
  }

  destroy() {
    this._stopSpeechRecognition();
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

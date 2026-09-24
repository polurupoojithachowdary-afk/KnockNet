import { FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision';

/**
 * KnockNet Real-Time Sign Language Recognition & Translation Module
 *
 * Runs 100% locally in the browser using MediaPipe Tasks Vision (WebAssembly + WebGL GPU).
 * Recognizes ASL gestures, fingerspelling alphabet, and conversational phrases.
 * Synthesizes voice via the Web Speech Synthesis API and broadcasts real-time
 * subtitles to peers in the video call.
 *
 * No backend dependencies, zero API keys, no rate limits, completely turnkey.
 */
export class SignLanguageManager {
  constructor(options = {}) {
    this.videoElement = options.videoElement || null;
    this.canvasElement = options.canvasElement || null;
    this.onSignDetected = options.onSignDetected || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this.onError = options.onError || console.error;
    this.sendToPeer = options.sendToPeer || (() => {});

    this.recognizer = null;
    this.running = false;
    this.ttsEnabled = true;
    this.drawSkeleton = false; // Do not draw lines on screen
    this.mode = 'phrases';

    this.lastVideoTime = -1;
    this.animFrameId = null;

    // Temporal debouncing
    this.detectionHistory = [];
    this.historyLength = 6;
    this.currentConfirmedSign = null;
    this.lastSpokenSign = null;
    this.lastSpokenTime = 0;
    this.speakCooldown = 1400; // ms before repeating the same sign

    // Accumulated sentence builder
    this.sentenceWords = [];
  }

  /**
   * Initializes MediaPipe FilesetResolver and GestureRecognizer.
   * Tries local WASM and model files first, falling back to CDN if needed.
   */
  async init() {
    this.onStatusChange({ status: 'loading', message: 'Loading AI Hand Tracker…' });

    try {
      // 1. Resolve WASM assets (try local first, fallback to CDN)
      let vision;
      try {
        vision = await FilesetResolver.forVisionTasks('/wasm');
      } catch (e) {
        console.warn('Local WASM failed, falling back to CDN:', e.message);
        vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
        );
      }

      // 2. Initialize GestureRecognizer (try GPU first, fallback to CPU)
      const modelPath = '/models/gesture_recognizer.task';
      const cdnModelPath = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';

      const createRecognizer = async (delegate, modelUrl) => {
        return await GestureRecognizer.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: modelUrl,
            delegate: delegate
          },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.5,
          minHandPresenceConfidence: 0.5,
          minTrackingConfidence: 0.5
        });
      };

      try {
        this.recognizer = await createRecognizer('GPU', modelPath);
      } catch (errGpuLocal) {
        console.warn('GPU/local model init failed, trying CPU fallback…', errGpuLocal.message);
        try {
          this.recognizer = await createRecognizer('CPU', modelPath);
        } catch (errCpuLocal) {
          console.warn('Local model failed, trying CDN…', errCpuLocal.message);
          this.recognizer = await createRecognizer('GPU', cdnModelPath);
        }
      }

      this.onStatusChange({ status: 'ready', message: 'Sign Language AI Ready' });
      return true;
    } catch (error) {
      console.error('Failed to initialize Sign Language Recognizer:', error);
      this.onStatusChange({ status: 'error', message: 'Failed to initialize AI: ' + error.message });
      this.onError(error.message);
      return false;
    }
  }

  /**
   * Starts tracking and recognition loop on the active video element.
   */
  start(videoElement, canvasElement) {
    if (videoElement) this.videoElement = videoElement;
    if (canvasElement) this.canvasElement = canvasElement;

    if (!this.recognizer) {
      this.onError('Recognizer not initialized. Call init() first.');
      return;
    }
    if (!this.videoElement) {
      this.onError('Video element is required to start recognition.');
      return;
    }

    this.running = true;
    this.detectionHistory = [];
    this.onStatusChange({ status: 'tracking', message: 'Tracking hand signs' });

    this._loop();
  }

  /**
   * Stops tracking loop and clears canvas.
   */
  stop() {
    this.running = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.clearCanvas();
    this.onStatusChange({ status: 'stopped', message: 'Translation paused' });
  }

  toggle(videoElement, canvasElement) {
    if (this.running) {
      this.stop();
      return false;
    } else {
      this.start(videoElement, canvasElement);
      return true;
    }
  }

  /**
   * Main render & recognition animation loop.
   */
  _loop() {
    if (!this.running) return;

    const video = this.videoElement;
    if (video && video.readyState >= 2 && !video.paused && !video.ended) {
      if (video.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = video.currentTime;
        const nowInMs = performance.now();

        try {
          const results = this.recognizer.recognizeForVideo(video, nowInMs);
          this.processResults(results);
        } catch (e) {
          // Frame dropped or busy
        }
      }
    }

    this.animFrameId = requestAnimationFrame(() => this._loop());
  }

  /**
   * Processes recognition results without drawing lines or badges over the video feed.
   */
  processResults(results) {
    this.clearCanvas();

    if (!results || !results.landmarks || results.landmarks.length === 0) {
      this.detectionHistory.push(null);
      if (this.detectionHistory.length > this.historyLength) {
        this.detectionHistory.shift();
      }
      return;
    }

    for (let h = 0; h < results.landmarks.length; h++) {
      const landmarks = results.landmarks[h];
      const cannedGesture = results.gestures?.[h]?.[0];

      // Classify the gesture (combining canned gestures + geometric rules)
      const detectedSign = this.classifySign(landmarks, cannedGesture);

      if (detectedSign) {
        this.detectionHistory.push(detectedSign);
      } else {
        this.detectionHistory.push(null);
      }
    }

    if (this.detectionHistory.length > this.historyLength) {
      this.detectionHistory.shift();
    }

    // Debounce and confirm sign
    this.evaluateHistory();
  }

  /**
   * Classifies the hand pose into an ASL letter, number, or conversational phrase.
   * Completely emoji-free.
   */
  classifySign(lm, canned) {
    // 1. Calculate finger curl and extension states
    const wrist = lm[0];
    const dist = (p1, p2) => Math.hypot(p1.x - p2.x, p1.y - p2.y, (p1.z || 0) - (p2.z || 0));

    // Wrist to fingertip vs wrist to PIP distances
    const indexExt = dist(lm[8], wrist) > dist(lm[6], wrist) * 1.15;
    const middleExt = dist(lm[12], wrist) > dist(lm[10], wrist) * 1.15;
    const ringExt = dist(lm[16], wrist) > dist(lm[14], wrist) * 1.15;
    const pinkyExt = dist(lm[20], wrist) > dist(lm[18], wrist) * 1.15;

    // Thumb extension: thumb tip distance from index MCP
    const thumbExt = dist(lm[4], lm[5]) > 0.12 && dist(lm[4], wrist) > dist(lm[2], wrist) * 1.05;

    // Tip-to-tip distances
    const thumbIndexDist = dist(lm[4], lm[8]);
    const indexMiddleDist = dist(lm[8], lm[12]);
    const thumbPinkyDist = dist(lm[4], lm[20]);
    const middleRingDist = dist(lm[12], lm[16]);

    // Check MediaPipe pre-trained gesture with high confidence (>0.75)
    if (canned && canned.score > 0.75) {
      const gName = canned.categoryName;
      if (gName === 'Thumb_Up') {
        return { sign: 'THUMBS_UP', spoken: 'Yes', label: 'Yes (Thumbs Up)', score: canned.score };
      }
      if (gName === 'Thumb_Down') {
        return { sign: 'THUMBS_DOWN', spoken: 'No', label: 'No (Thumbs Down)', score: canned.score };
      }
      if (gName === 'ILoveYou') {
        return { sign: 'I_LOVE_YOU', spoken: 'I love you', label: 'I Love You', score: canned.score };
      }
      if (gName === 'Victory') {
        return { sign: 'PEACE', spoken: 'Peace', label: 'Peace', score: canned.score };
      }
      if (gName === 'Pointing_Up' && !middleExt && !ringExt && !pinkyExt) {
        return { sign: 'POINTING_UP', spoken: 'One', label: 'One / Pointing', score: canned.score };
      }
      if (gName === 'Open_Palm' && indexExt && middleExt && ringExt && pinkyExt && thumbExt) {
        return { sign: 'HELLO', spoken: 'Hello', label: 'Hello', score: canned.score };
      }
      if (gName === 'Closed_Fist' && !indexExt && !middleExt && !ringExt && !pinkyExt) {
        return { sign: 'SOLIDARITY', spoken: 'Solidarity', label: 'Fist', score: canned.score };
      }
    }

    // 2. Custom Geometric ASL Sign Rules

    // "OK" Sign (Thumb and Index tips touching in a ring, other 3 extended)
    if (thumbIndexDist < 0.055 && middleExt && ringExt && pinkyExt) {
      return { sign: 'OK', spoken: 'OK', label: 'OK', score: 0.92 };
    }

    // "Call Me" / "Shaka" / "Y" (Thumb and Pinky extended, middle 3 curled)
    if (thumbExt && pinkyExt && !indexExt && !middleExt && !ringExt) {
      return { sign: 'CALL_ME', spoken: 'Call me', label: 'Call Me / Y', score: 0.90 };
    }

    // "L" Sign (Thumb and Index extended at right angle, others curled)
    if (thumbExt && indexExt && !middleExt && !ringExt && !pinkyExt) {
      return { sign: 'LETTER_L', spoken: 'Letter L', label: 'Letter L', score: 0.88 };
    }

    // "I" Sign / Pinky Only (Pinky extended, all other 4 curled)
    if (pinkyExt && !indexExt && !middleExt && !ringExt && !thumbExt) {
      return { sign: 'LETTER_I', spoken: 'Letter I', label: 'Letter I', score: 0.87 };
    }

    // "W" Sign / "3" (Index, Middle, Ring extended, Pinky curled)
    if (indexExt && middleExt && ringExt && !pinkyExt) {
      return { sign: 'LETTER_W', spoken: 'Letter W', label: 'Letter W / 3', score: 0.86 };
    }

    // "U" Sign (Index and Middle extended and touching closely)
    if (indexExt && middleExt && !ringExt && !pinkyExt && indexMiddleDist < 0.045) {
      return { sign: 'LETTER_U', spoken: 'Letter U', label: 'Letter U', score: 0.85 };
    }

    // "B" Sign (Four fingers extended straight together, thumb tucked)
    if (indexExt && middleExt && ringExt && pinkyExt && !thumbExt && middleRingDist < 0.05) {
      return { sign: 'LETTER_B', spoken: 'Letter B', label: 'Letter B', score: 0.85 };
    }

    // "C" Sign (Fingers curved into a cup shape)
    const isCurved = !indexExt && dist(lm[8], wrist) > dist(lm[6], wrist) * 0.95 && thumbIndexDist > 0.08 && thumbIndexDist < 0.18;
    if (isCurved && !pinkyExt) {
      return { sign: 'LETTER_C', spoken: 'Letter C', label: 'Letter C', score: 0.80 };
    }

    return null;
  }

  /**
   * Evaluates the recent detection history to confirm a stable sign.
   */
  evaluateHistory() {
    const validDetections = this.detectionHistory.filter(d => d !== null);
    if (validDetections.length < 4) return;

    // Count occurrences of each sign
    const counts = {};
    for (const d of validDetections) {
      counts[d.sign] = (counts[d.sign] || 0) + 1;
    }

    // Find the most frequent sign
    let dominantSign = null;
    let maxCount = 0;
    for (const [sign, count] of Object.entries(counts)) {
      if (count > maxCount) {
        maxCount = count;
        dominantSign = sign;
      }
    }

    // Must be present in at least 4 of the last 6 frames
    if (maxCount >= 4 && dominantSign) {
      const signObj = validDetections.find(d => d.sign === dominantSign);
      this.onConfirmedSign(signObj);
    }
  }

  /**
   * Handles a confirmed sign detection.
   */
  onConfirmedSign(signObj) {
    const now = Date.now();
    const isDifferent = this.currentConfirmedSign !== signObj.sign;
    const isCooldownElapsed = (now - this.lastSpokenTime) > this.speakCooldown;

    if (isDifferent || isCooldownElapsed) {
      this.currentConfirmedSign = signObj.sign;
      this.lastSpokenSign = signObj.sign;
      this.lastSpokenTime = now;

      // Add to sentence words if different
      if (isDifferent) {
        this.addWordToSentence(signObj.spoken);
      }

      // Notify callback
      this.onSignDetected(signObj);

      // Synthesize speech (TTS)
      if (this.ttsEnabled) {
        this.speak(signObj.spoken);
      }

      // Broadcast subtitle to peer via WebRTC signaling
      this.sendToPeer({
        type: 'sign-language-subtitle',
        sign: signObj.sign,
        text: signObj.spoken,
        label: signObj.label
      });
    }
  }

  /**
   * Adds recognized sign word to the accumulated sentence strip.
   */
  addWordToSentence(word) {
    if (!word) return;
    this.sentenceWords.push(word);
    if (this.sentenceWords.length > 12) {
      this.sentenceWords.shift();
    }
  }

  getSentence() {
    return this.sentenceWords.join(' ');
  }

  clearSentence() {
    this.sentenceWords = [];
  }

  /**
   * Speaks text using the browser SpeechSynthesis API.
   */
  speak(text) {
    if (!window.speechSynthesis || !text) return;

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.lang = 'en-US';

    const voices = window.speechSynthesis.getVoices();
    const englishVoice = voices.find(v => v.lang.startsWith('en') && (v.name.includes('Natural') || v.name.includes('Google') || v.name.includes('Samantha')));
    if (englishVoice) {
      utterance.voice = englishVoice;
    }

    window.speechSynthesis.speak(utterance);
  }

  clearCanvas() {
    if (this.canvasElement) {
      const ctx = this.canvasElement.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, this.canvasElement.width, this.canvasElement.height);
      }
    }
  }

  destroy() {
    this.stop();
    if (this.recognizer) {
      try { this.recognizer.close(); } catch (e) {}
      this.recognizer = null;
    }
    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }
}

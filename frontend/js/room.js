import { authenticatedFetch } from './api.js';
import { auth, authReady, displayNameFor, signInWithGoogle } from './auth.js';
import { WebRTCManager } from './webrtc.js';
import { TranslateManager } from './translate.js';
import { SignLanguageManager } from './sign-language.js';

/**
 * Knocknet Conference Room Controller
 * Bridges WebRTC media events with dynamic grid presentation, audio meters, and session controls.
 */
document.addEventListener('DOMContentLoaded', async () => {
  const authGate = document.getElementById('auth-gate');
  const authGateMessage = document.getElementById('auth-gate-message');
  const authGateButton = document.getElementById('btn-room-auth');

  const btnRoomDemo = document.getElementById('btn-room-demo');
  if (btnRoomDemo) {
    btnRoomDemo.addEventListener('click', () => {
      sessionStorage.setItem('knocknet_demo', 'true');
      sessionStorage.setItem('knocknet_roomId', 'demo-room-888');
      window.location.href = '/room.html?demo=true';
    });
  }

  const isDemo = new URLSearchParams(window.location.search).get('demo') === 'true' ||
                 sessionStorage.getItem('knocknet_demo') === 'true';

  let user = null;
  if (isDemo) {
    user = {
      uid: 'demo-user-1',
      displayName: 'Preetham',
      email: 'preetham@knocknet.local',
      getIdToken: async () => 'mock-jwt-token'
    };
    sessionStorage.setItem('knocknet_roomId', 'demo-room-888');
    authGate.classList.remove('active');
  } else {
    await authReady;
    user = auth?.currentUser;
    if (!user) {
      authGate.classList.add('active');
      user = await new Promise((resolve) => {
        authGateButton.addEventListener('click', async () => {
          authGateButton.disabled = true;
          authGateMessage.textContent = 'Verifying your identity…';
          try {
            resolve(await signInWithGoogle());
          } catch (error) {
            authGateMessage.textContent = error.message || 'Sign-in failed. Try again.';
            authGateButton.disabled = false;
          }
        });
      });
      authGate.classList.remove('active');
    }
  }

  const inviteCode = new URLSearchParams(window.location.hash.slice(1)).get('invite');
  if (inviteCode) {
    authGate.classList.add('active');
    authGateMessage.textContent = 'Validating the invitation…';
    authGateButton.hidden = true;
    try {
      const response = await authenticatedFetch('/api/rooms/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: inviteCode })
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.message || 'Invitation rejected');
      sessionStorage.setItem('knocknet_roomId', result.roomId);
      history.replaceState(null, '', '/room.html');
    } catch (error) {
      authGateMessage.textContent = error.message || 'This invitation is invalid or expired.';
      setTimeout(() => { window.location.href = '/'; }, 2200);
      return;
    }
    authGate.classList.remove('active');
  }

  const roomId = sessionStorage.getItem('knocknet_roomId');
  if (!roomId) {
    window.location.href = '/';
    return;
  }

  const displayName = displayNameFor(user);

  // DOM Elements
  const headerCodeVal = document.getElementById('header-code-val');
  const chipRoomCode = document.getElementById('chip-room-code');
  const callTimerDisplay = document.getElementById('call-timer-display');
  const participantCountText = document.getElementById('participant-count-text');
  const videoStage = document.getElementById('video-stage');

  const tileLocal = document.getElementById('tile-local');
  const localVideo = document.getElementById('local-video');
  const localDisplayName = document.getElementById('local-display-name');
  const localAvatarInitials = document.getElementById('local-avatar-initials');
  const localAudioMeter = document.getElementById('local-audio-meter');
  const localRole = document.getElementById('local-role');

  const btnToggleMic = document.getElementById('btn-toggle-mic');
  const btnToggleCam = document.getElementById('btn-toggle-cam');
  const btnToggleScreen = document.getElementById('btn-toggle-screen');
  const btnOpenInvite = document.getElementById('btn-open-invite');
  const btnLeaveCall = document.getElementById('btn-leave-call');

  const inviteModal = document.getElementById('invite-modal');
  const btnCloseInvite = document.getElementById('btn-close-invite');
  const modalCodeDisplay = document.getElementById('modal-code-display');
  const btnCopyCodeOnly = document.getElementById('btn-copy-code-only');
  const modalLinkInput = document.getElementById('modal-link-input');
  const btnModalCopyLink = document.getElementById('btn-modal-copy-link');
  const btnRefreshCode = document.getElementById('btn-refresh-code');

  const roomToast = document.getElementById('room-toast');

  let audioContext = null;

  function getAudioContext() {
    if (!audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) audioContext = new AudioContextClass();
    }
    return audioContext;
  }

  function playParticipantJoinedSound() {
    const context = getAudioContext();
    if (!context) return;

    const play = () => {
      const startAt = context.currentTime + 0.02;
      [659.25, 880].forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const noteStart = startAt + (index * 0.12);
        const noteEnd = noteStart + 0.24;

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, noteStart);
        gain.gain.setValueAtTime(0.0001, noteStart);
        gain.gain.exponentialRampToValueAtTime(0.055, noteStart + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(noteStart);
        oscillator.stop(noteEnd + 0.02);
      });
    };

    if (context.state === 'suspended') {
      context.resume().then(play).catch(() => {});
    } else {
      play();
    }
  }

  document.addEventListener('pointerdown', () => {
    const context = getAudioContext();
    if (context?.state === 'suspended') context.resume().catch(() => {});
  }, { once: true, capture: true });

  // Set Local Display Name & Initials
  localDisplayName.textContent = displayName;
  localAvatarInitials.textContent = displayName.substring(0, 2).toUpperCase();

  let maxParticipants = 6;
  let activeCode = '------';
  let isHost = false;

  // 1. Fetch Room Metadata from Spring Boot REST API
  if (isDemo) {
    activeCode = 'DEMO-88';
    maxParticipants = 6;
    isHost = true;
    headerCodeVal.textContent = activeCode;
    modalCodeDisplay.textContent = activeCode;
    modalLinkInput.value = `${window.location.origin}/room.html?demo=true`;
    localRole.textContent = 'Host';
    btnRefreshCode.hidden = false;
  } else {
    try {
      const res = await authenticatedFetch(`/api/rooms/${roomId}`);
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message || 'Room access denied');
      activeCode = data.code;
      maxParticipants = data.maxParticipants || 6;
      isHost = Boolean(data.isHost);
      headerCodeVal.textContent = activeCode;
      modalCodeDisplay.textContent = activeCode;
      modalLinkInput.value = `${window.location.origin}/room.html#invite=${encodeURIComponent(activeCode)}`;
      localRole.textContent = isHost ? 'Host' : 'Verified';
      btnRefreshCode.hidden = !isHost;
    } catch (e) {
      authGate.classList.add('active');
      authGateButton.hidden = true;
      authGateMessage.textContent = e.message || 'Room access denied';
      setTimeout(() => { window.location.href = '/'; }, 2200);
      return;
    }
  }

  // 2. Call Timer
  let callSeconds = 0;
  setInterval(() => {
    callSeconds++;
    const hrs = String(Math.floor(callSeconds / 3600)).padStart(2, '0');
    const mins = String(Math.floor((callSeconds % 3600) / 60)).padStart(2, '0');
    const secs = String(callSeconds % 60).padStart(2, '0');
    callTimerDisplay.textContent = `${hrs}:${mins}:${secs}`;
  }, 1000);

  // 3. Initialize WebRTC Manager
  const rtc = new WebRTCManager({
    roomId: roomId,
    displayName: displayName,
    tokenProvider: () => user.getIdToken(),
    onRemoteStream: handleRemoteStream,
    onPeerLeft: handlePeerLeft,
    onPeerStateChange: handlePeerStateChange,
    onSpeaking: handleSpeakingState,
    onTotalCountChange: handleCountChange,
    onError: (err) => showToast(err),
    onSignalingStateChange: (state) => {
      if (state === 'disconnected') showToast('Signaling interrupted. Reconnecting securely…');
    },
    onSignalingCustomMessage: (msg) => {
      handleIncomingCustomSignaling(msg);
    }
  });

  // Acquire local media & attach
  const stream = await rtc.initLocalMedia();
  localVideo.srcObject = stream;

  // Connect to Signaling Server
  rtc.connectSignaling();

  // 4. Remote Stream Arrival
  function handleRemoteStream(peerId, remoteStream, peerDisplayName) {
    let tile = document.getElementById(`tile-${peerId}`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.id = `tile-${peerId}`;
      const avatarText = escapeHtml((peerDisplayName || 'P').substring(0, 2).toUpperCase());

      tile.innerHTML = `
        <video autoplay playsinline></video>
        <div class="avatar-placeholder">
          <div class="avatar-circle">${avatarText}</div>
          <div class="camera-state-label">Camera off</div>
        </div>
        <div class="tile-overlay">
          <div class="participant-name-tag">
            <span>${escapeHtml(peerDisplayName || 'Peer')}</span>
          </div>
          <div class="participant-media-state">
            <div class="audio-level-meter">
              <div class="audio-meter-bar" style="height: 4px;"></div>
              <div class="audio-meter-bar" style="height: 7px;"></div>
              <div class="audio-meter-bar" style="height: 10px;"></div>
            </div>
            <svg class="mute-indicator-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <line x1="1" y1="1" x2="23" y2="23"></line>
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path>
              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
              <line x1="12" y1="19" x2="12" y2="23"></line>
              <line x1="8" y1="23" x2="16" y2="23"></line>
            </svg>
          </div>
        </div>
      `;
      tile.querySelector('.audio-level-meter').id = `meter-${peerId}`;
      videoStage.appendChild(tile);
      updateGridLayout();
      playParticipantJoinedSound();
      showToast(`${peerDisplayName || 'A participant'} joined`);
    }

    const videoEl = tile.querySelector('video');
    if (videoEl.srcObject !== remoteStream) {
      videoEl.srcObject = remoteStream;
    }
  }

  function handlePeerLeft(peerId) {
    const tile = document.getElementById(`tile-${peerId}`);
    if (tile) {
      tile.remove();
      updateGridLayout();
      showToast('A participant left');
    }
  }

  function handlePeerStateChange(peerId, state) {
    const tile = document.getElementById(`tile-${peerId}`);
    if (!tile) return;

    if (state.videoMuted !== undefined) {
      tile.classList.toggle('video-off', state.videoMuted);
    }
    if (state.audioMuted !== undefined) {
      tile.classList.toggle('audio-muted', state.audioMuted);
    }
  }

  function handleSpeakingState(targetId, level, isSpeaking) {
    const tile = targetId === 'local' ? tileLocal : document.getElementById(`tile-${targetId}`);
    if (!tile) return;

    tile.classList.toggle('speaking', isSpeaking);

    // Update meter bars
    const meter = targetId === 'local' ? localAudioMeter : document.getElementById(`meter-${targetId}`);
    if (meter) {
      const bars = meter.querySelectorAll('.audio-meter-bar');
      const h1 = Math.min(Math.max(level * 0.25, 3), 12);
      const h2 = Math.min(Math.max(level * 0.35, 3), 14);
      const h3 = Math.min(Math.max(level * 0.45, 3), 16);
      if (bars[0]) bars[0].style.height = `${h1}px`;
      if (bars[1]) bars[1].style.height = `${h2}px`;
      if (bars[2]) bars[2].style.height = `${h3}px`;
    }
  }

  function handleCountChange(count) {
    const total = count || (videoStage.querySelectorAll('.video-tile').length);
    participantCountText.textContent = `${total} of ${maxParticipants} ${total === 1 ? 'participant' : 'participants'}`;
  }

  // 5. Dynamic Grid Resizing
  function updateGridLayout() {
    const totalTiles = videoStage.querySelectorAll('.video-tile').length;
    videoStage.className = 'video-stage';

    if (totalTiles <= 1) {
      videoStage.classList.add('grid-1');
    } else if (totalTiles === 2) {
      videoStage.classList.add('grid-2');
    } else if (totalTiles <= 4) {
      videoStage.classList.add('grid-4');
    } else if (totalTiles <= 6) {
      videoStage.classList.add('grid-6');
    } else {
      videoStage.classList.add('grid-many');
    }
    handleCountChange(totalTiles);
  }

  // 6. Media Controls
  btnToggleMic.addEventListener('click', () => {
    const enabled = rtc.toggleAudio();
    btnToggleMic.classList.toggle('danger-off', !enabled);
    tileLocal.classList.toggle('audio-muted', !enabled);
    btnToggleMic.setAttribute('aria-label', enabled ? 'Mute microphone' : 'Unmute microphone');
    btnToggleMic.title = enabled ? 'Mute microphone' : 'Unmute microphone';
    showToast(enabled ? 'Microphone active' : 'Microphone muted');
  });

  btnToggleCam.addEventListener('click', () => {
    const enabled = rtc.toggleVideo();
    btnToggleCam.classList.toggle('danger-off', !enabled);
    tileLocal.classList.toggle('video-off', !enabled);
    btnToggleCam.setAttribute('aria-label', enabled ? 'Turn off camera' : 'Turn on camera');
    btnToggleCam.title = enabled ? 'Turn off camera' : 'Turn on camera';
    showToast(enabled ? 'Camera active' : 'Camera disabled');
  });

  btnToggleScreen.addEventListener('click', async () => {
    const res = await rtc.toggleScreenShare();
    if (res.isSharing) {
      btnToggleScreen.classList.add('active');
      showToast('Screen sharing started');
      // Local preview screen feed
      localVideo.srcObject = res.stream;
    } else {
      btnToggleScreen.classList.remove('active');
      showToast('Screen sharing stopped');
      localVideo.srcObject = rtc.localStream;
    }
  });

  // 7. Invite Modal & Code Management
  chipRoomCode.addEventListener('click', () => {
    navigator.clipboard.writeText(activeCode);
    showToast('Invitation code copied');
  });

  btnOpenInvite.addEventListener('click', () => {
    inviteModal.classList.add('active');
  });

  btnCloseInvite.addEventListener('click', () => {
    inviteModal.classList.remove('active');
  });

  inviteModal.addEventListener('click', (e) => {
    if (e.target === inviteModal) inviteModal.classList.remove('active');
  });

  btnCopyCodeOnly.addEventListener('click', () => {
    navigator.clipboard.writeText(activeCode);
    showToast('Invitation code copied');
  });

  btnModalCopyLink.addEventListener('click', () => {
    navigator.clipboard.writeText(modalLinkInput.value);
    showToast('Short-lived invite link copied');
  });

  btnRefreshCode.addEventListener('click', async () => {
    btnRefreshCode.disabled = true;
    btnRefreshCode.textContent = 'Generating...';
    try {
      const res = await authenticatedFetch(`/api/rooms/${roomId}/refresh-code`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        activeCode = data.code;
        headerCodeVal.textContent = activeCode;
        modalCodeDisplay.textContent = activeCode;
        modalLinkInput.value = `${window.location.origin}/room.html#invite=${encodeURIComponent(activeCode)}`;
        showToast('A new 60-second invitation is ready');
      }
    } catch (e) {
      showToast('Could not create a new invitation: ' + e.message);
    } finally {
      btnRefreshCode.disabled = false;
      btnRefreshCode.textContent = 'Create a new invitation';
    }
  });

  // 8. Leave Conference Call
  btnLeaveCall.addEventListener('click', () => {
    if (confirm('Leave this meeting?')) {
      signManager?.destroy();
      translator.destroy();
      rtc.leave();
      window.location.href = '/';
    }
  });

  window.addEventListener('beforeunload', () => {
    signManager?.destroy();
    translator.destroy();
    rtc.leave();
  });

  // 9. Voice Translation Setup
  const btnToggleTranslate = document.getElementById('btn-toggle-translate');
  const translatePanel = document.getElementById('translate-panel');
  const btnCloseTranslate = document.getElementById('btn-close-translate');
  const selectSourceLang = document.getElementById('select-source-lang');
  const selectTargetLang = document.getElementById('select-target-lang');
  const btnPushToTalk = document.getElementById('btn-push-to-talk');
  const pushToTalkLabel = document.getElementById('push-to-talk-label');
  const subtitleOverlay = document.getElementById('translate-subtitle');
  const subtitleOriginal = document.getElementById('subtitle-original');
  const subtitleTranslated = document.getElementById('subtitle-translated');

  let subtitleTimeout = null;

  const translator = new TranslateManager({
    onSubtitle: ({ original, translated }) => {
      subtitleOriginal.textContent = original || '';
      subtitleTranslated.textContent = translated || '';
      subtitleOverlay.hidden = false;
      clearTimeout(subtitleTimeout);
      subtitleTimeout = setTimeout(() => {
        subtitleOverlay.hidden = true;
      }, 8000);
    },
    onStateChange: (state) => {
      if (state.recording !== undefined) {
        btnPushToTalk.classList.toggle('recording', state.recording);
        pushToTalkLabel.textContent = state.recording ? 'Listening…' : 'Hold to translate';
      }
      if (state.processing !== undefined) {
        btnPushToTalk.classList.toggle('processing', state.processing);
        if (state.processing) {
          pushToTalkLabel.textContent = 'Translating…';
          btnPushToTalk.disabled = true;
        } else {
          pushToTalkLabel.textContent = 'Hold to translate';
          btnPushToTalk.disabled = false;
        }
      }
    },
    onError: (msg) => showToast(msg),
    sendToPeer: (data) => {
      // Send via signaling as a lightweight data message
      // (DataChannel integration can be added later for lower latency)
      rtc.sendSignalingMessage({
        type: 'translation-subtitle',
        roomId: roomId,
        ...data
      });
    }
  });

  // Initialize: fetch languages from backend
  translator.init().then(() => {
    if (translator.languages.length > 0) {
      // Populate source language dropdown
      selectSourceLang.innerHTML = '';
      translator.languages.forEach(lang => {
        const opt = document.createElement('option');
        opt.value = lang.code;
        opt.textContent = lang.name;
        if (lang.code === 'en') opt.selected = true;
        selectSourceLang.appendChild(opt);
      });

      // Populate target language dropdown (exclude source)
      selectTargetLang.innerHTML = '';
      translator.languages.forEach(lang => {
        const opt = document.createElement('option');
        opt.value = lang.code;
        opt.textContent = lang.name;
        if (lang.code === 'hi') opt.selected = true;
        selectTargetLang.appendChild(opt);
      });
    }

    if (!translator.configured) {
      btnToggleTranslate.title = 'Voice translation not configured on server';
    }
  });

  // Toggle translate panel
  btnToggleTranslate.addEventListener('click', () => {
    const willShow = translatePanel.hidden;
    translatePanel.hidden = !willShow;
    btnToggleTranslate.classList.toggle('active', willShow);
    if (willShow && !translator.configured) {
      showToast('Voice translation requires NVIDIA_API_KEY on the server');
    }
  });

  btnCloseTranslate.addEventListener('click', () => {
    translatePanel.hidden = true;
    btnToggleTranslate.classList.remove('active');
  });

  // Language selection
  selectSourceLang.addEventListener('change', () => {
    translator.setSourceLanguage(selectSourceLang.value);
  });

  selectTargetLang.addEventListener('change', () => {
    translator.setTargetLanguage(selectTargetLang.value);
  });

  // Push-to-talk: hold to record, release to translate
  function startTranslateRecording(e) {
    e.preventDefault();
    if (!translator.configured) {
      showToast('Translation service not available');
      return;
    }
    translator.startRecording(rtc.localStream);
  }

  function stopTranslateRecording(e) {
    e.preventDefault();
    translator.stopRecording();
  }

  // Mouse events
  btnPushToTalk.addEventListener('mousedown', startTranslateRecording);
  btnPushToTalk.addEventListener('mouseup', stopTranslateRecording);
  btnPushToTalk.addEventListener('mouseleave', () => {
    if (translator.recording) translator.stopRecording();
  });

  // Touch events (mobile)
  btnPushToTalk.addEventListener('touchstart', startTranslateRecording);
  btnPushToTalk.addEventListener('touchend', stopTranslateRecording);
  btnPushToTalk.addEventListener('touchcancel', () => {
    if (translator.recording) translator.stopRecording();
  });

  // 10. Incoming Signaling Subtitles (Voice & Sign Language)
  function handleIncomingCustomSignaling(msg) {
    if (msg.type === 'sign-language-subtitle') {
      const senderName = msg.sender || rtc.peerData.get(msg.from)?.displayName || 'Participant';
      subtitleOriginal.textContent = `Sign Language (${senderName})`;
      subtitleTranslated.textContent = msg.text || '';
      subtitleOverlay.hidden = false;
      clearTimeout(subtitleTimeout);
      subtitleTimeout = setTimeout(() => {
        subtitleOverlay.hidden = true;
      }, 6000);

      // Speak peer's translated sign if TTS is enabled
      if (signManager && signManager.ttsEnabled && msg.text) {
        signManager.speak(msg.text);
      }
    } else if (msg.type === 'translation-subtitle') {
      const senderName = msg.sender || rtc.peerData.get(msg.from)?.displayName || 'Participant';
      subtitleOriginal.textContent = `Voice Translation (${senderName})`;
      subtitleTranslated.textContent = msg.translated || '';
      subtitleOverlay.hidden = false;
      clearTimeout(subtitleTimeout);
      subtitleTimeout = setTimeout(() => {
        subtitleOverlay.hidden = true;
      }, 8000);
    }
  }

  // 11. Sign Language Recognition & Translation Setup
  const btnToggleSign = document.getElementById('btn-toggle-sign');
  const signPanel = document.getElementById('sign-panel');
  const btnCloseSign = document.getElementById('btn-close-sign');
  const signCanvas = document.getElementById('sign-canvas');
  const signStatusText = document.getElementById('sign-status-text');
  const signLiveCard = document.getElementById('sign-live-card');
  const signLiveBadge = document.getElementById('sign-live-badge');
  const signLiveLabel = document.getElementById('sign-live-label');
  const signLiveSpeech = document.getElementById('sign-live-speech');
  const signSentenceText = document.getElementById('sign-sentence-text');
  const btnClearSentence = document.getElementById('btn-clear-sentence');
  const checkSignTts = document.getElementById('check-sign-tts');

  const signManager = new SignLanguageManager({
    videoElement: localVideo,
    canvasElement: signCanvas,
    onSignDetected: (signObj) => {
      if (signLiveBadge) signLiveBadge.textContent = 'DETECTED';
      if (signLiveLabel) signLiveLabel.textContent = signObj.label;
      if (signLiveSpeech) signLiveSpeech.textContent = `"${signObj.spoken}"`;
      if (signSentenceText) signSentenceText.textContent = signManager.getSentence() || '—';

      if (signLiveCard) {
        signLiveCard.classList.add('pulse');
        setTimeout(() => signLiveCard.classList.remove('pulse'), 300);
      }

      // Display live subtitle for local user
      subtitleOriginal.textContent = 'Sign Language (You)';
      subtitleTranslated.textContent = signObj.spoken;
      subtitleOverlay.hidden = false;
      clearTimeout(subtitleTimeout);
      subtitleTimeout = setTimeout(() => {
        subtitleOverlay.hidden = true;
      }, 5000);
    },
    onStatusChange: (status) => {
      if (signStatusText) signStatusText.textContent = status.message;
    },
    onError: (err) => showToast(err),
    sendToPeer: (data) => {
      rtc.sendSignalingMessage({
        type: 'sign-language-subtitle',
        sender: displayName,
        roomId: roomId,
        ...data
      });
    }
  });

  // Pre-initialize AI model in background
  signManager.init().catch(e => console.warn('Sign Language init warning:', e));

  // Toggle button
  btnToggleSign.addEventListener('click', async () => {
    const willShow = signPanel.hidden;
    signPanel.hidden = !willShow;
    btnToggleSign.classList.toggle('active', willShow);

    // Close voice translate panel if open to avoid visual overlap
    if (willShow && !translatePanel.hidden) {
      translatePanel.hidden = true;
      btnToggleTranslate.classList.remove('active');
    }

    if (willShow) {
      if (!signManager.recognizer) {
        showToast('Initializing hand tracking AI…');
        await signManager.init();
      }
      signManager.start(localVideo, signCanvas);
      showToast('Sign language active. Show hand to camera!');
    } else {
      signManager.stop();
    }
  });

  btnCloseSign.addEventListener('click', () => {
    signPanel.hidden = true;
    btnToggleSign.classList.remove('active');
    signManager.stop();
  });

  if (checkSignTts) {
    checkSignTts.addEventListener('change', () => {
      signManager.ttsEnabled = checkSignTts.checked;
    });
  }

  if (btnClearSentence) {
    btnClearSentence.addEventListener('click', () => {
      signManager.clearSentence();
      if (signSentenceText) signSentenceText.textContent = 'Sentence cleared';
    });
  }

  function showToast(text) {
    roomToast.textContent = text;
    roomToast.classList.add('show');
    setTimeout(() => {
      roomToast.classList.remove('show');
    }, 2800);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  updateGridLayout();
});

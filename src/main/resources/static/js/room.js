/**
 * Knocknet Conference Room Controller
 * Bridges WebRTC media events with dynamic grid presentation, audio meters, and session controls.
 */
document.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const roomId = urlParams.get('id');

  if (!roomId) {
    alert('No conference session ID specified. Redirecting to landing.');
    window.location.href = '/';
    return;
  }

  // Retrieve or generate callsign
  let displayName = sessionStorage.getItem('knocknet_displayName');
  if (!displayName) {
    displayName = 'Guest-' + Math.floor(100 + Math.random() * 900);
  }

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

  // Set Local Display Name & Initials
  localDisplayName.textContent = displayName;
  localAvatarInitials.textContent = displayName.substring(0, 2).toUpperCase();

  let maxParticipants = 6;
  let activeCode = '------';

  // 1. Fetch Room Metadata from Spring Boot REST API
  try {
    const res = await fetch(`/api/rooms/${roomId}`);
    if (res.ok) {
      const data = await res.json();
      activeCode = data.code;
      maxParticipants = data.maxParticipants || 6;
      headerCodeVal.textContent = activeCode;
      modalCodeDisplay.textContent = activeCode;
      modalLinkInput.value = window.location.href;
    }
  } catch (e) {
    console.warn('Could not fetch room metadata:', e);
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
    onRemoteStream: handleRemoteStream,
    onPeerLeft: handlePeerLeft,
    onPeerStateChange: handlePeerStateChange,
    onSpeaking: handleSpeakingState,
    onTotalCountChange: handleCountChange,
    onError: (err) => showToast('WebRTC: ' + err)
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

      tile.innerHTML = `
        <video autoplay playsinline></video>
        <div class="avatar-placeholder">
          <div class="avatar-circle">${(peerDisplayName || 'P').substring(0, 2).toUpperCase()}</div>
          <div style="font-family: var(--font-mono); font-size: 0.75rem; color: var(--secondary-muted);">VIDEO MUTED</div>
        </div>
        <div class="tile-overlay">
          <div class="participant-name-tag">
            <span>${escapeHtml(peerDisplayName || 'Peer')}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            <div class="audio-level-meter" id="meter-${peerId}">
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
      videoStage.appendChild(tile);
      updateGridLayout();
      showToast(`${peerDisplayName || 'A peer'} entered conference`);
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
    participantCountText.textContent = `${total} / ${maxParticipants} PEERS`;
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
    showToast(enabled ? 'Microphone active' : 'Microphone muted');
  });

  btnToggleCam.addEventListener('click', () => {
    const enabled = rtc.toggleVideo();
    btnToggleCam.classList.toggle('danger-off', !enabled);
    tileLocal.classList.toggle('video-off', !enabled);
    showToast(enabled ? 'Camera active' : 'Camera disabled');
  });

  btnToggleScreen.addEventListener('click', async () => {
    const res = await rtc.toggleScreenShare();
    if (res.isSharing) {
      btnToggleScreen.classList.add('active');
      showToast('Screen broadcasting initiated');
      // Local preview screen feed
      localVideo.srcObject = res.stream;
    } else {
      btnToggleScreen.classList.remove('active');
      showToast('Screen broadcast ended');
      localVideo.srcObject = rtc.localStream;
    }
  });

  // 7. Invite Modal & Code Management
  chipRoomCode.addEventListener('click', () => {
    navigator.clipboard.writeText(activeCode);
    showToast('Token ' + activeCode + ' copied to clipboard');
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
    showToast('Access code copied');
  });

  btnModalCopyLink.addEventListener('click', () => {
    navigator.clipboard.writeText(modalLinkInput.value);
    showToast('Direct join link copied');
  });

  btnRefreshCode.addEventListener('click', async () => {
    btnRefreshCode.disabled = true;
    btnRefreshCode.textContent = 'Generating...';
    try {
      const res = await fetch(`/api/rooms/${roomId}/refresh-code`, { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        activeCode = data.code;
        headerCodeVal.textContent = activeCode;
        modalCodeDisplay.textContent = activeCode;
        showToast('Fresh 60-second token generated: ' + activeCode);
      }
    } catch (e) {
      showToast('Failed to refresh token: ' + e.message);
    } finally {
      btnRefreshCode.disabled = false;
      btnRefreshCode.textContent = 'REGENERATE FRESH 60s TOKEN';
    }
  });

  // 8. Leave Conference Call
  btnLeaveCall.addEventListener('click', () => {
    if (confirm('Leave current conference session?')) {
      rtc.leave();
      window.location.href = '/';
    }
  });

  window.addEventListener('beforeunload', () => {
    rtc.leave();
  });

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

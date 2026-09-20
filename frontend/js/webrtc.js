import { websocketUrl } from './config.js';

/**
 * Knocknet WebRTC Mesh Engine
 * Orchestrates multi-peer RTCPeerConnection mesh, ICE candidate exchange,
 * local audio metering, and track swapping (camera/screen).
 */
export class WebRTCManager {
  constructor(options = {}) {
    this.roomId = options.roomId;
    this.userId = options.userId || ('user-' + Math.random().toString(36).substring(2, 9));
    this.displayName = options.displayName || 'Guest';
    this.tokenProvider = options.tokenProvider;
    
    // Callbacks
    this.onRemoteStream = options.onRemoteStream || (() => {});
    this.onPeerLeft = options.onPeerLeft || (() => {});
    this.onPeerStateChange = options.onPeerStateChange || (() => {});
    this.onSpeaking = options.onSpeaking || (() => {});
    this.onTotalCountChange = options.onTotalCountChange || (() => {});
    this.onError = options.onError || console.error;
    this.onSignalingStateChange = options.onSignalingStateChange || (() => {});

    // State
    this.localStream = null;
    this.screenStream = null;
    this.isScreenSharing = false;
    this.ws = null;
    this.peerConnections = new Map(); // peerId -> RTCPeerConnection
    this.peerData = new Map(); // peerId -> { displayName }
    this.audioContext = null;
    this.localAnalyser = null;
    this.meterInterval = null;
    this.reconnectTimer = null;
    this.reconnectDelay = 1000;
    this.shouldReconnect = true;
    this.heartbeatInterval = null;

    // Standard public STUN configuration
    this.iceConfig = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    };
  }

  /**
   * Initializes local camera and microphone media stream and audio analyzer.
   */
  async initLocalMedia() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: { echoCancellation: true, noiseSuppression: true }
      });

      this.setupLocalAudioMeter();
      return this.localStream;
    } catch (err) {
      console.warn('Could not acquire audio/video stream:', err);
      // Fallback: try audio-only or create synthetic blank stream for testing
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.setupLocalAudioMeter();
        return this.localStream;
      } catch (err2) {
        console.warn('Audio-only fallback also failed, using dummy media track');
        this.localStream = this.createDummyStream();
        return this.localStream;
      }
    }
  }

  createDummyStream() {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0f151e';
    ctx.fillRect(0, 0, 640, 480);
    const videoStream = canvas.captureStream(10);

    // Audio context dummy oscillator
    const ctxAudio = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctxAudio.createOscillator();
    const dst = ctxAudio.createMediaStreamDestination();
    osc.connect(dst);
    osc.start();
    const audioTrack = dst.stream.getAudioTracks()[0];
    audioTrack.enabled = false;

    const stream = new MediaStream([videoStream.getVideoTracks()[0], audioTrack]);
    return stream;
  }

  setupLocalAudioMeter() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx || !this.localStream.getAudioTracks().length) return;

      this.audioContext = new AudioCtx();
      if (this.audioContext.state === 'suspended') {
        const resume = () => {
          this.audioContext.resume();
          window.removeEventListener('click', resume);
        };
        window.addEventListener('click', resume);
      }

      const source = this.audioContext.createMediaStreamSource(this.localStream);
      this.localAnalyser = this.audioContext.createAnalyser();
      this.localAnalyser.fftSize = 64;
      source.connect(this.localAnalyser);

      const buffer = new Uint8Array(this.localAnalyser.frequencyBinCount);
      this.meterInterval = setInterval(() => {
        if (!this.localStream.getAudioTracks()[0]?.enabled) {
          this.onSpeaking('local', 0, false);
          return;
        }
        this.localAnalyser.getByteFrequencyData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) sum += buffer[i];
        const avg = sum / buffer.length;
        const isSpeaking = avg > 18;
        this.onSpeaking('local', avg, isSpeaking);
      }, 100);
    } catch (e) {
      console.warn('Audio metering init error:', e);
    }
  }

  /**
   * Connects to Spring Boot WebSocket signaling endpoint.
   */
  async connectSignaling() {
    if (typeof this.tokenProvider !== 'function') {
      this.onError('Authentication is not configured');
      return;
    }

    let token;
    try {
      token = await this.tokenProvider();
    } catch (error) {
      this.onError('Authentication expired. Sign in again.');
      return;
    }

    this.onSignalingStateChange('connecting');
    this.ws = new WebSocket(websocketUrl('/signal'));

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      this.onSignalingStateChange('connected');
      this.sendSignalingMessage({
        type: 'join',
        roomId: this.roomId,
        token
      });
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = setInterval(() => {
        this.sendSignalingMessage({ type: 'ping' });
      }, 30000);
    };

    this.ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        await this.handleSignalingMessage(msg);
      } catch (err) {
        console.error('Signaling processing error:', err, event.data);
      }
    };

    this.ws.onclose = () => {
      clearInterval(this.heartbeatInterval);
      this.onSignalingStateChange('disconnected');
      if (this.shouldReconnect) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connectSignaling(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      }
    };

    this.ws.onerror = (err) => {
      console.error('Signaling WebSocket error:', err);
      this.onError('Signaling connection error');
    };
  }

  sendSignalingMessage(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  async handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'room-joined': {
        // We received the list of existing participants in the room
        console.log('Joined room. Existing peers:', msg.users);
        if (Array.isArray(msg.users)) {
          for (const user of msg.users) {
            this.peerData.set(user.userId, { displayName: user.displayName });
            // As the newly joined participant, we initiate the offer to each existing peer
            await this.initiatePeerConnection(user.userId, true);
          }
          this.onTotalCountChange(msg.users.length + 1);
        }
        break;
      }

      case 'user-joined': {
        // A new user joined after us
        console.log('New peer joined room:', msg.userId, msg.displayName);
        this.peerData.set(msg.userId, { displayName: msg.displayName });
        // Prepare peer connection to receive their offer
        await this.initiatePeerConnection(msg.userId, false);
        this.onTotalCountChange(this.peerConnections.size + 1);
        break;
      }

      case 'offer': {
        console.log('Received offer from peer:', msg.from);
        let pc = this.peerConnections.get(msg.from);
        if (!pc) {
          pc = await this.initiatePeerConnection(msg.from, false);
        }
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        this.sendSignalingMessage({
          type: 'answer',
          roomId: this.roomId,
          target: msg.from,
          sdp: pc.localDescription
        });
        break;
      }

      case 'answer': {
        console.log('Received answer from peer:', msg.from);
        const pc = this.peerConnections.get(msg.from);
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        }
        break;
      }

      case 'ice-candidate': {
        const pc = this.peerConnections.get(msg.from);
        if (pc && msg.candidate) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch (e) {
            console.warn('Error adding ICE candidate:', e);
          }
        }
        break;
      }

      case 'media-state': {
        this.onPeerStateChange(msg.from, msg);
        break;
      }

      case 'user-left': {
        console.log('Peer left room:', msg.userId);
        this.closePeer(msg.userId);
        this.onPeerLeft(msg.userId);
        this.onTotalCountChange(this.peerConnections.size + 1);
        break;
      }

      case 'error': {
        if (['UNAUTHENTICATED', 'NOT_ADMITTED', 'DUPLICATE_SESSION'].includes(msg.code)) {
          this.shouldReconnect = false;
        }
        this.onError(msg.message || 'Room error');
        break;
      }
    }
  }

  /**
   * Sets up RTCPeerConnection for a remote peer.
   * isInitiator = true will create and send the SDP offer.
   */
  async initiatePeerConnection(peerId, isInitiator) {
    if (this.peerConnections.has(peerId)) {
      return this.peerConnections.get(peerId);
    }

    const pc = new RTCPeerConnection(this.iceConfig);
    this.peerConnections.set(peerId, pc);

    // Add local tracks to peer connection
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // ICE candidates listener
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignalingMessage({
          type: 'ice-candidate',
          roomId: this.roomId,
          target: peerId,
          candidate: event.candidate
        });
      }
    };

    // Remote track arrival
    pc.ontrack = (event) => {
      console.log('Received remote track from peer:', peerId, event.track.kind);
      const remoteStream = event.streams[0] || new MediaStream([event.track]);
      const meta = this.peerData.get(peerId) || { displayName: 'Peer' };
      this.onRemoteStream(peerId, remoteStream, meta.displayName);
    };

    pc.onconnectionstatechange = () => {
      console.log(`Peer ${peerId} connection state:`, pc.connectionState);
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this.closePeer(peerId);
        this.onPeerLeft(peerId);
      }
    };

    if (isInitiator) {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.sendSignalingMessage({
          type: 'offer',
          roomId: this.roomId,
          target: peerId,
          sdp: pc.localDescription
        });
      } catch (err) {
        console.error('Error creating offer for peer:', peerId, err);
      }
    }

    return pc;
  }

  closePeer(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(peerId);
    }
    this.peerData.delete(peerId);
  }

  /**
   * Media Controls: Mic Mute / Unmute
   */
  toggleAudio() {
    if (!this.localStream) return false;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (!audioTrack) return false;

    audioTrack.enabled = !audioTrack.enabled;
    this.sendSignalingMessage({
      type: 'media-state',
      roomId: this.roomId,
      audioMuted: !audioTrack.enabled
    });
    return audioTrack.enabled;
  }

  /**
   * Media Controls: Camera Start / Stop
   */
  toggleVideo() {
    if (!this.localStream) return false;
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (!videoTrack) return false;

    videoTrack.enabled = !videoTrack.enabled;
    this.sendSignalingMessage({
      type: 'media-state',
      roomId: this.roomId,
      videoMuted: !videoTrack.enabled
    });
    return videoTrack.enabled;
  }

  /**
   * Screen Sharing Toggle via RTCRtpSender.replaceTrack
   */
  async toggleScreenShare() {
    if (this.isScreenSharing) {
      // Revert back to webcam track
      return this.stopScreenShare();
    } else {
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: { cursor: 'always' },
          audio: false
        });

        const screenTrack = this.screenStream.getVideoTracks()[0];
        
        // Replace video track on all active peer connections
        for (const [_, pc] of this.peerConnections) {
          const senders = pc.getSenders();
          const videoSender = senders.find(s => s.track && s.track.kind === 'video');
          if (videoSender) {
            await videoSender.replaceTrack(screenTrack);
          }
        }

        // When user clicks the browser's native "Stop Sharing" floating button
        screenTrack.onended = () => {
          this.stopScreenShare();
        };

        this.isScreenSharing = true;
        return { isSharing: true, stream: this.screenStream };
      } catch (err) {
        console.warn('Screen share canceled or failed:', err);
        return { isSharing: false, error: err };
      }
    }
  }

  async stopScreenShare() {
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
    }

    const webcamVideoTrack = this.localStream ? this.localStream.getVideoTracks()[0] : null;
    if (webcamVideoTrack) {
      for (const [_, pc] of this.peerConnections) {
        const senders = pc.getSenders();
        const videoSender = senders.find(s => s.track && s.track.kind === 'video');
        if (videoSender) {
          await videoSender.replaceTrack(webcamVideoTrack);
        }
      }
    }

    this.isScreenSharing = false;
    return { isSharing: false, stream: this.localStream };
  }

  /**
   * Disconnect cleanly from call
   */
  leave() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.meterInterval) clearInterval(this.meterInterval);
    if (this.audioContext) {
      try { this.audioContext.close(); } catch (e) {}
    }

    this.sendSignalingMessage({
      type: 'leave',
      roomId: this.roomId,
      userId: this.userId
    });

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
    }

    for (const [_, pc] of this.peerConnections) {
      pc.close();
    }
    this.peerConnections.clear();

    if (this.ws) {
      this.ws.close();
    }
  }
}

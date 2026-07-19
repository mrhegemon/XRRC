(function exposeNetwork(root) {
  'use strict';

  const PLAYER_COLORS = [
    '#457b9d',
    '#2a9d8f',
    '#e9c46a',
    '#f4a261',
    '#a8dadc',
    '#8338ec',
    '#06d6a0',
    '#fb5607',
  ];

  class NetworkManager extends EventTarget {
    constructor() {
      super();
      this.localId = null;
      this.hostId = null;
      this.isHost = false;
      this._ws = null;
      this._wsUrl = null;
      this._peers = new Map();
      this._colorIndex = 0;
      this._reconnectTimer = null;
      this._reconnectAttempt = 0;
      this._intentionalClose = false;
      this._iceConfig = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ],
      };
    }

    connect(wsUrl) {
      this.disconnect();
      this._wsUrl = wsUrl;
      this._intentionalClose = false;
      this.hostId = null;
      this.isHost = false;
      this._openSocket();
    }

    disconnect() {
      this._intentionalClose = true;
      root.clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      for (const id of [...this._peers.keys()]) this._removePeer(id);
      if (this._ws) {
        this._ws.onclose = null;
        this._ws.close();
        this._ws = null;
      }
      this.localId = null;
      this.hostId = null;
      this.isHost = false;
    }

    broadcastState(state) {
      const data = JSON.stringify(state);
      this._peers.forEach(({ dc }) => {
        if (dc && dc.readyState === 'open' && dc.bufferedAmount < 64 * 1024) {
          dc.send(data);
        }
      });
    }

    broadcastRace(race) {
      const data = JSON.stringify({ race });
      this._peers.forEach(({ raceDc }) => {
        if (raceDc && raceDc.readyState === 'open') raceDc.send(data);
      });
    }

    get peerCount() {
      return this._peers.size;
    }

    _openSocket() {
      this._emitStatus('connecting', 'Joining private relay');
      this._ws = new WebSocket(this._wsUrl);
      this._ws.onopen = () => {
        this._reconnectAttempt = 0;
        this._emitStatus('ready', 'Relay connected');
      };
      this._ws.onmessage = ({ data }) => {
        let message;
        try {
          message = JSON.parse(data);
        } catch {
          this._emitStatus('error', 'Relay sent an invalid message');
          return;
        }
        this._onSignal(message).catch((error) => {
          console.error('[net] Signaling error:', error);
          this._emitStatus('error', 'Peer handshake failed');
        });
      };
      this._ws.onclose = () => {
        this._ws = null;
        if (!this._intentionalClose) this._scheduleReconnect();
      };
      this._ws.onerror = () => {
        this._emitStatus('error', 'Relay is unreachable');
      };
    }

    _scheduleReconnect() {
      for (const id of [...this._peers.keys()]) this._removePeer(id);
      const delay = Math.min(15000, 1000 * (2 ** this._reconnectAttempt));
      this._reconnectAttempt += 1;
      this._emitStatus('connecting', `Retrying relay in ${Math.ceil(delay / 1000)}s`);
      this._reconnectTimer = root.setTimeout(() => this._openSocket(), delay);
    }

    _send(message) {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify(message));
      }
    }

    async _onSignal(message) {
      switch (message.type) {
        case 'welcome':
          this.localId = message.id;
          this.hostId = message.host || message.peers[0] || message.id;
          this.isHost = this.localId === this.hostId;
          for (const peerId of message.peers) await this._createOffer(peerId);
          this.dispatchEvent(new CustomEvent('ready', {
            detail: { id: this.localId },
          }));
          break;
        case 'peer-joined':
          break;
        case 'peer-left':
          this._removePeer(message.id);
          break;
        case 'host-changed':
          this.hostId = message.id;
          this.isHost = this.localId === this.hostId;
          this.dispatchEvent(new CustomEvent('host-change', {
            detail: { id: this.hostId, isHost: this.isHost },
          }));
          break;
        case 'offer':
          await this._handleOffer(message.from, message.sdp);
          break;
        case 'answer':
          await this._handleAnswer(message.from, message.sdp);
          break;
        case 'ice':
          await this._handleIce(message.from, message.candidate);
          break;
        case 'error':
          this._emitStatus('error', message.code.replaceAll('-', ' '));
          break;
        default:
          break;
      }
    }

    _nextColor() {
      const color = PLAYER_COLORS[this._colorIndex % PLAYER_COLORS.length];
      this._colorIndex += 1;
      return color;
    }

    _createPeerRecord(peerId) {
      if (!this._peers.has(peerId)) {
        this._peers.set(peerId, {
          pc: null,
          dc: null,
          raceDc: null,
          color: this._nextColor(),
          announced: false,
        });
      }
      return this._peers.get(peerId);
    }

    _buildPeerConnection(peerId) {
      const record = this._createPeerRecord(peerId);
      if (record.pc) record.pc.close();
      const pc = new RTCPeerConnection(this._iceConfig);
      record.pc = pc;

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) this._send({ type: 'ice', to: peerId, candidate });
      };
      pc.onconnectionstatechange = () => {
        if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
          this._removePeer(peerId);
        }
      };
      return pc;
    }

    async _createOffer(peerId) {
      const pc = this._buildPeerConnection(peerId);
      const record = this._peers.get(peerId);
      const dc = pc.createDataChannel('rc-game', {
        ordered: false,
        maxRetransmits: 0,
      });
      record.dc = dc;
      this._setupDataChannel(dc, peerId);
      const raceDc = pc.createDataChannel('rc-race');
      record.raceDc = raceDc;
      this._setupRaceChannel(raceDc, peerId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._send({ type: 'offer', to: peerId, sdp: pc.localDescription });
    }

    async _handleOffer(peerId, sdp) {
      const pc = this._buildPeerConnection(peerId);
      pc.ondatachannel = ({ channel }) => {
        const record = this._createPeerRecord(peerId);
        if (channel.label === 'rc-race') {
          record.raceDc = channel;
          this._setupRaceChannel(channel, peerId);
        } else {
          record.dc = channel;
          this._setupDataChannel(channel, peerId);
        }
      };
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this._send({ type: 'answer', to: peerId, sdp: pc.localDescription });
    }

    async _handleAnswer(peerId, sdp) {
      const record = this._peers.get(peerId);
      if (record && record.pc) {
        await record.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      }
    }

    async _handleIce(peerId, candidate) {
      const record = this._peers.get(peerId);
      if (!record || !record.pc || !candidate) return;
      try {
        await record.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.warn('[net] ICE candidate error:', error);
      }
    }

    _setupDataChannel(dc, peerId) {
      dc.bufferedAmountLowThreshold = 16 * 1024;
      const announcePeer = () => {
        const record = this._peers.get(peerId);
        if (!record || record.announced) return;
        record.announced = true;
        this.dispatchEvent(new CustomEvent('peer-join', {
          detail: { id: peerId, color: record.color },
        }));
      };
      dc.onopen = announcePeer;
      dc.onmessage = ({ data }) => {
        let state;
        try {
          state = JSON.parse(data);
        } catch {
          return;
        }
        this.dispatchEvent(new CustomEvent('peer-state', {
          detail: { id: peerId, state },
        }));
      };
      dc.onclose = () => this._removePeer(peerId);
      dc.onerror = (error) => console.warn('[net] Data channel error:', error);
      if (dc.readyState === 'open') announcePeer();
    }

    _setupRaceChannel(dc, peerId) {
      dc.onmessage = ({ data }) => {
        try {
          const message = JSON.parse(data);
          if (!message || typeof message.race !== 'object') return;
          this.dispatchEvent(new CustomEvent('peer-race', {
            detail: { id: peerId, race: message.race },
          }));
        } catch {
          this._emitStatus('error', 'Peer sent invalid race data');
        }
      };
      dc.onerror = (error) => console.warn('[net] Race channel error:', error);
    }

    _removePeer(peerId) {
      const record = this._peers.get(peerId);
      if (!record) return;
      if (record.dc && record.dc.readyState !== 'closed') record.dc.close();
      if (record.raceDc && record.raceDc.readyState !== 'closed') record.raceDc.close();
      if (record.pc && record.pc.connectionState !== 'closed') record.pc.close();
      this._peers.delete(peerId);
      if (record.announced) {
        this.dispatchEvent(new CustomEvent('peer-leave', {
          detail: { id: peerId },
        }));
      }
    }

    _emitStatus(state, message) {
      this.dispatchEvent(new CustomEvent('status', {
        detail: { state, message },
      }));
    }
  }

  root.NetworkManager = NetworkManager;
})(window);

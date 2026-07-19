(function exposeAudio(root) {
  'use strict';

  const AudioContextClass = root.AudioContext || root.webkitAudioContext;

  function readPreference(key, fallback) {
    try {
      const value = root.localStorage.getItem(key);
      return value === null ? fallback : value === 'true';
    } catch {
      return fallback;
    }
  }

  function writePreference(key, value) {
    try {
      root.localStorage.setItem(key, String(value));
    } catch {
      // Audio still works when storage is unavailable.
    }
  }

  class AudioManager extends EventTarget {
    constructor() {
      super();
      this.sfxEnabled = readPreference('xrrc-sfx', true);
      this.musicEnabled = readPreference('xrrc-music', true);
      this.context = null;
      this.masterGain = null;
      this.engineGain = null;
      this.engineOscillator = null;
      this.engineFilter = null;
      this.skidGain = null;
      this.skidSource = null;
      this.musicGain = null;
      this.musicTimer = null;
      this.musicStep = 0;

      document.addEventListener('visibilitychange', () => {
        if (!this.context) return;
        if (document.hidden) {
          this.context.suspend();
        } else if (this.sfxEnabled || this.musicEnabled) {
          this.context.resume();
        }
      });
    }

    get available() {
      return Boolean(AudioContextClass);
    }

    async unlock() {
      if (!AudioContextClass) return false;
      if (!this.context) this._createGraph();
      if (this.context.state === 'suspended') await this.context.resume();
      return true;
    }

    async start() {
      if (!(await this.unlock())) return;
      if (this.sfxEnabled) this._ensureEngine();
      if (this.musicEnabled) this._startMusic();
    }

    async setSfxEnabled(enabled) {
      this.sfxEnabled = Boolean(enabled);
      writePreference('xrrc-sfx', this.sfxEnabled);
      if (this.sfxEnabled) {
        await this.unlock();
        this._ensureEngine();
        this.playCue('toggle');
      } else if (this.engineGain && this.context) {
        this.engineGain.gain.setTargetAtTime(0, this.context.currentTime, 0.03);
        this.skidGain.gain.setTargetAtTime(0, this.context.currentTime, 0.03);
      }
      this._emitChange();
    }

    async setMusicEnabled(enabled) {
      this.musicEnabled = Boolean(enabled);
      writePreference('xrrc-music', this.musicEnabled);
      if (this.musicEnabled) {
        await this.unlock();
        this._startMusic();
      } else {
        this._stopMusic();
      }
      this._emitChange();
    }

    update({ speed = 0, throttle = 0, steering = 0 } = {}) {
      if (!this.context || !this.engineGain || !this.sfxEnabled) return;
      const now = this.context.currentTime;
      const normalizedSpeed = Math.min(1, Math.abs(speed) / 1.7);
      const engineLevel = 0.025 + normalizedSpeed * 0.075 + Math.abs(throttle) * 0.02;
      const frequency = 68 + normalizedSpeed * 190 + Math.abs(throttle) * 22;
      const skidLevel = (
        Math.abs(steering) > 0.55 && normalizedSpeed > 0.35
          ? (normalizedSpeed - 0.3) * 0.08
          : 0
      );

      this.engineGain.gain.setTargetAtTime(engineLevel, now, 0.045);
      this.engineOscillator.frequency.setTargetAtTime(frequency, now, 0.04);
      this.engineFilter.frequency.setTargetAtTime(300 + frequency * 3.4, now, 0.06);
      this.skidGain.gain.setTargetAtTime(skidLevel, now, 0.04);
    }

    playCue(name) {
      if (!this.context || !this.sfxEnabled) return;
      const cues = {
        countdown: [440, 0.07, 'square', 0.055],
        go: [660, 0.16, 'sawtooth', 0.075],
        copy: [740, 0.08, 'sine', 0.045],
        reset: [260, 0.12, 'triangle', 0.055],
        toggle: [520, 0.06, 'sine', 0.035],
        sector: [560, 0.08, 'triangle', 0.045],
        finish: [740, 0.22, 'sawtooth', 0.07],
        boost: [180, 0.2, 'sawtooth', 0.07],
      };

      if (name === 'impact') {
        this._noiseBurst(0.11, 0.16);
        this._tone(115, 0.1, 'square', 0.07);
        return;
      }

      const cue = cues[name];
      if (!cue) return;
      this._tone(...cue);
      if (name === 'go') {
        this._tone(880, 0.13, 'triangle', 0.045, 0.035);
      } else if (name === 'sector') {
        this._tone(700, 0.07, 'sine', 0.035, 0.045);
      } else if (name === 'finish') {
        this._tone(920, 0.25, 'triangle', 0.055, 0.08);
      } else if (name === 'boost') {
        this._noiseBurst(0.16, 0.08);
        this._tone(320, 0.18, 'sawtooth', 0.045, 0.04);
      }
    }

    _createGraph() {
      this.context = new AudioContextClass();
      this.masterGain = this.context.createGain();
      this.masterGain.gain.value = 0.72;
      this.masterGain.connect(this.context.destination);

      this.musicGain = this.context.createGain();
      this.musicGain.gain.value = 0.13;
      this.musicGain.connect(this.masterGain);
    }

    _ensureEngine() {
      if (this.engineOscillator) return;

      this.engineOscillator = this.context.createOscillator();
      this.engineOscillator.type = 'sawtooth';
      this.engineOscillator.frequency.value = 68;
      this.engineFilter = this.context.createBiquadFilter();
      this.engineFilter.type = 'lowpass';
      this.engineFilter.frequency.value = 520;
      this.engineFilter.Q.value = 2.2;
      this.engineGain = this.context.createGain();
      this.engineGain.gain.value = 0;
      this.engineOscillator.connect(this.engineFilter);
      this.engineFilter.connect(this.engineGain);
      this.engineGain.connect(this.masterGain);
      this.engineOscillator.start();

      const noiseBuffer = this.context.createBuffer(
        1,
        this.context.sampleRate,
        this.context.sampleRate
      );
      const noise = noiseBuffer.getChannelData(0);
      for (let index = 0; index < noise.length; index += 1) {
        noise[index] = Math.random() * 2 - 1;
      }
      const skidFilter = this.context.createBiquadFilter();
      skidFilter.type = 'bandpass';
      skidFilter.frequency.value = 1800;
      skidFilter.Q.value = 0.7;
      this.skidGain = this.context.createGain();
      this.skidGain.gain.value = 0;
      this.skidSource = this.context.createBufferSource();
      this.skidSource.buffer = noiseBuffer;
      this.skidSource.loop = true;
      this.skidSource.connect(skidFilter);
      skidFilter.connect(this.skidGain);
      this.skidGain.connect(this.masterGain);
      this.skidSource.start();
    }

    _tone(frequency, duration, type, volume, delay = 0) {
      const start = this.context.currentTime + delay;
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(this.masterGain);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.02);
    }

    _noiseBurst(duration, volume) {
      const frameCount = Math.ceil(this.context.sampleRate * duration);
      const buffer = this.context.createBuffer(1, frameCount, this.context.sampleRate);
      const samples = buffer.getChannelData(0);
      for (let index = 0; index < samples.length; index += 1) {
        samples[index] = (Math.random() * 2 - 1) * (1 - index / samples.length);
      }
      const source = this.context.createBufferSource();
      const filter = this.context.createBiquadFilter();
      const gain = this.context.createGain();
      filter.type = 'lowpass';
      filter.frequency.value = 720;
      gain.gain.value = volume;
      source.buffer = buffer;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.masterGain);
      source.start();
    }

    _startMusic() {
      if (this.musicTimer || !this.context) return;
      const notes = [110, 147, 165, 147, 110, 147, 196, 165];
      const tick = () => {
        if (!this.musicEnabled || !this.context || document.hidden) return;
        const note = notes[this.musicStep % notes.length];
        this._musicNote(note, this.musicStep % 4 === 0 ? 0.09 : 0.055);
        if (this.musicStep % 2 === 1) {
          this._musicNote(note * 2, 0.025, 0.055, 'triangle');
        }
        this.musicStep += 1;
      };
      tick();
      this.musicTimer = root.setInterval(tick, 280);
    }

    _musicNote(frequency, volume, delay = 0, type = 'square') {
      const start = this.context.currentTime + delay;
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.2);
      oscillator.connect(gain);
      gain.connect(this.musicGain);
      oscillator.start(start);
      oscillator.stop(start + 0.22);
    }

    _stopMusic() {
      if (this.musicTimer) root.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }

    _emitChange() {
      this.dispatchEvent(new CustomEvent('change', {
        detail: {
          available: this.available,
          musicEnabled: this.musicEnabled,
          sfxEnabled: this.sfxEnabled,
        },
      }));
    }
  }

  root.XRRCAudioManager = AudioManager;
})(window);

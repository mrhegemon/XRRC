(function exposeControls(root) {
  'use strict';

  const Input = root.XRRCControlsCore;

  class Controls {
    constructor() {
      this._keys = new Set();
      this._touch = { lift: 0, throttle: 0, steering: 0 };
      this._touchButtonPointers = new Map();
      this._pointerId = null;
      this._preferredGamepadIndex = null;
      this._activeGamepad = null;
      this._gamepadResetPressed = false;
      this._gamepadPausePressed = false;
      this._xrResetPressed = false;
      this._xrPausePressed = false;
      this._inputMode = null;
      this._setupKeyboard();
      this._setupJoystick();
      this._setupTouchButtons();
      this._setupGamepads();
      this._startLoop();
    }

    _setupKeyboard() {
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !event.repeat && !event.target.closest('dialog')) {
          event.preventDefault();
          document.dispatchEvent(new CustomEvent('game-pause'));
        }
        if (
          event.target.matches('input, textarea, select, button') ||
          event.target.closest('dialog')
        ) {
          return;
        }
        if (event.key.startsWith('Arrow') || event.key === ' ') event.preventDefault();
        this._keys.add(event.key.toLowerCase());
        if (event.key.toLowerCase() === 'r' && !event.repeat) {
          document.dispatchEvent(new CustomEvent('car-reset'));
        }
      });

      document.addEventListener('keyup', (event) => {
        this._keys.delete(event.key.toLowerCase());
      });

      root.addEventListener('blur', () => this._resetInput());
    }

    _setupJoystick() {
      const zone = document.getElementById('joystick');
      const knob = document.getElementById('joystick-knob');
      if (!zone || !knob) return;

      const update = (event) => {
        if (event.pointerId !== this._pointerId) return;
        const bounds = zone.getBoundingClientRect();
        const knobBounds = knob.getBoundingClientRect();
        const dx = event.clientX - (bounds.left + bounds.width / 2);
        const dy = event.clientY - (bounds.top + bounds.height / 2);
        const maxRadius = Math.max(1, (bounds.width - knobBounds.width) / 2 - 2);
        const input = Input.normalizeRadialInput(dx, dy, maxRadius);
        knob.style.transform = `translate3d(${input.knobX}px, ${input.knobY}px, 0)`;
        this._touch.throttle = input.throttle;
        this._touch.steering = input.steering;
      };

      zone.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        if (this._pointerId !== null) return;
        this._pointerId = event.pointerId;
        zone.setPointerCapture(event.pointerId);
        update(event);
      });
      zone.addEventListener('pointermove', update);

      const end = (event) => {
        if (event.pointerId !== this._pointerId) return;
        this._pointerId = null;
        this._touch.throttle = 0;
        this._touch.steering = 0;
        knob.style.transform = 'translate3d(0, 0, 0)';
      };
      zone.addEventListener('pointerup', end);
      zone.addEventListener('pointercancel', end);
      zone.addEventListener('lostpointercapture', end);
    }

    _setupTouchButtons() {
      const buttons = document.querySelectorAll('[data-touch-axis][data-touch-value]');
      let clickSequence = 0;
      const activate = (id, button, axis, value) => {
        this._touchButtonPointers.set(id, { axis, button, value });
        button.classList.add('is-pressed');
      };
      const release = (id) => {
        const binding = this._touchButtonPointers.get(id);
        if (!binding) return;
        this._touchButtonPointers.delete(id);
        const stillPressed = Array.from(this._touchButtonPointers.values())
          .some(({ button }) => button === binding.button);
        if (!stillPressed) binding.button.classList.remove('is-pressed');
      };
      const endPointer = (event) => {
        release(event.pointerId);
      };
      buttons.forEach((button) => {
        const axis = button.dataset.touchAxis;
        const value = Number(button.dataset.touchValue);
        if (!['lift', 'steering', 'throttle'].includes(axis) || !Number.isFinite(value)) {
          throw new TypeError('Invalid touch-control binding');
        }
        button.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          button.setPointerCapture(event.pointerId);
          activate(event.pointerId, button, axis, value);
        });
        button.addEventListener('pointerup', endPointer);
        button.addEventListener('pointercancel', endPointer);
        button.addEventListener('lostpointercapture', endPointer);
        button.addEventListener('keydown', (event) => {
          if (!['Enter', ' '].includes(event.key) || event.repeat) return;
          event.preventDefault();
          button.dataset.keyboardHandled = 'true';
          activate(`key:${axis}:${value}`, button, axis, value);
        });
        button.addEventListener('keyup', (event) => {
          if (!['Enter', ' '].includes(event.key)) return;
          event.preventDefault();
          release(`key:${axis}:${value}`);
          delete button.dataset.keyboardHandled;
        });
        button.addEventListener('click', (event) => {
          if (event.detail !== 0) return;
          if (button.dataset.keyboardHandled === 'true') {
            delete button.dataset.keyboardHandled;
            return;
          }
          const id = `click:${clickSequence}`;
          clickSequence += 1;
          activate(id, button, axis, value);
          root.setTimeout(() => release(id), 260);
        });
      });
    }

    _readTouchAxes() {
      const discrete = { lift: 0, steering: 0, throttle: 0 };
      for (const binding of this._touchButtonPointers.values()) {
        discrete[binding.axis] += binding.value;
      }
      return {
        lift: discrete.lift ? Input.clamp(discrete.lift) : this._touch.lift,
        steering: discrete.steering ? Input.clamp(discrete.steering) : this._touch.steering,
        throttle: discrete.throttle ? Input.clamp(discrete.throttle) : this._touch.throttle,
      };
    }

    _setupGamepads() {
      root.addEventListener('gamepadconnected', ({ gamepad }) => {
        this._preferredGamepadIndex = gamepad.index;
        this._activeGamepad = gamepad;
        this._emitControllerStatus(true, gamepad);
      });
      root.addEventListener('gamepaddisconnected', ({ gamepad }) => {
        if (this._preferredGamepadIndex === gamepad.index) {
          this._preferredGamepadIndex = null;
          this._activeGamepad = null;
        }
        this._emitControllerStatus(false, gamepad);
      });
      document.addEventListener('car-impact', ({ detail }) => {
        this.pulse(detail && detail.strength, detail && detail.duration);
      });
      document.addEventListener('car-boost', () => this.pulse(0.72, 150));
    }

    _readGamepad() {
      if (!navigator.getGamepads) {
        return { lift: 0, throttle: 0, steering: 0, resetPressed: false };
      }
      const nextGamepad = Input.findActiveGamepad(
        navigator.getGamepads(),
        this._preferredGamepadIndex
      );
      if (nextGamepad && nextGamepad.index !== this._activeGamepad?.index) {
        this._emitControllerStatus(true, nextGamepad);
      }
      this._activeGamepad = nextGamepad;
      const axes = Input.readGamepadAxes(this._activeGamepad);
      if (axes.resetPressed && !this._gamepadResetPressed) {
        document.dispatchEvent(new CustomEvent('car-reset'));
        this.pulse(0.45, 80);
      }
      if (axes.pausePressed && !this._gamepadPausePressed) {
        document.dispatchEvent(new CustomEvent('game-pause'));
      }
      this._gamepadResetPressed = axes.resetPressed;
      this._gamepadPausePressed = axes.pausePressed;
      return axes;
    }

    async pulse(strength = 0.5, duration = 70) {
      const gamepad = this._activeGamepad;
      if (!gamepad) return false;
      const actuator = gamepad.vibrationActuator || (gamepad.hapticActuators || [])[0];
      if (!actuator || typeof actuator.playEffect !== 'function') return false;
      try {
        await actuator.playEffect('dual-rumble', {
          duration,
          startDelay: 0,
          strongMagnitude: Math.min(1, strength),
          weakMagnitude: Math.min(1, strength * 0.65),
        });
        return true;
      } catch {
        return false;
      }
    }

    _emitControllerStatus(connected, gamepad) {
      const detail = {
        connected,
        label: Input.getGamepadLabel(gamepad),
      };
      root.XRRC_CONTROLLER_STATUS = detail;
      document.dispatchEvent(new CustomEvent('controller-status', { detail }));
    }

    _resetInput() {
      this._keys.clear();
      this._pointerId = null;
      this._touch.lift = 0;
      this._touch.throttle = 0;
      this._touch.steering = 0;
      for (const { button } of this._touchButtonPointers.values()) {
        button.classList.remove('is-pressed');
      }
      this._touchButtonPointers.clear();
      const knob = document.getElementById('joystick-knob');
      if (knob) knob.style.transform = 'translate3d(0, 0, 0)';
    }

    _emitInputMode(mode) {
      if (!mode || mode === this._inputMode) return;
      this._inputMode = mode;
      root.XRRC_INPUT_MODE = mode;
      document.dispatchEvent(new CustomEvent('input-mode', { detail: { mode } }));
    }

    _startLoop() {
      const dispatch = () => {
        const gamepad = this._readGamepad();
        const keyboard = Input.readKeyboardAxes(this._keys);
        const touch = this._readTouchAxes();
        const xr = root.XRRC_XR_INPUT;
        const xrResetPressed = Boolean(xr && xr.resetPressed);
        const xrPausePressed = Boolean(xr && xr.pausePressed);
        if (xrResetPressed && !this._xrResetPressed) {
          document.dispatchEvent(new CustomEvent('car-reset'));
        }
        this._xrResetPressed = xrResetPressed;
        if (xrPausePressed && !this._xrPausePressed) {
          document.dispatchEvent(new CustomEvent('game-pause'));
        }
        this._xrPausePressed = xrPausePressed;
        const axes = Input.mixAxes({
          xr,
          keyboard,
          touch,
          gamepad,
          demo: root.XRRC_DEMO_INPUT,
        });
        const isActive = (source) => source && (
          Math.abs(source.lift || 0) > 0.001 ||
          Math.abs(source.steering || 0) > 0.001 ||
          Math.abs(source.throttle || 0) > 0.001
        );
        const activeMode = [
          ['xr', xr],
          ['keyboard', keyboard],
          ['touch', touch],
          ['gamepad', gamepad],
        ].find(([, source]) => isActive(source))?.[0];
        this._emitInputMode(
          activeMode ||
          (document.documentElement.classList.contains('force-touch')
            ? 'touch'
            : this._inputMode || 'keyboard')
        );
        document.dispatchEvent(new CustomEvent('car-input', { detail: axes }));
        root.requestAnimationFrame(dispatch);
      };
      root.requestAnimationFrame(dispatch);
    }
  }

  root.addEventListener('DOMContentLoaded', () => {
    root.controls = new Controls();
  });
})(window);

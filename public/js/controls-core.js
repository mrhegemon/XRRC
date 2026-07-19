(function exposeControlsCore(root, factory) {
  'use strict';

  const controls = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = controls;
  } else {
    root.XRRCControlsCore = controls;
  }
})(typeof window === 'undefined' ? globalThis : window, function createControlsCore() {
  'use strict';

  const DEFAULT_DEADZONE = 0.14;

  function clamp(value, minimum = -1, maximum = 1) {
    return Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : 0));
  }

  function applyDeadzone(value, deadzone = DEFAULT_DEADZONE) {
    const normalized = clamp(value);
    const magnitude = Math.abs(normalized);
    if (magnitude <= deadzone) return 0;
    return Math.sign(normalized) * ((magnitude - deadzone) / (1 - deadzone));
  }

  function buttonValue(button) {
    if (typeof button === 'number') return clamp(button, 0, 1);
    if (!button) return 0;
    if (Number.isFinite(button.value)) return clamp(button.value, 0, 1);
    return button.pressed ? 1 : 0;
  }

  function readKeyboardAxes(keys) {
    const has = (key) => keys && typeof keys.has === 'function' && keys.has(key);
    const forward = Number(has('arrowup') || has('w'));
    const reverse = Number(has('arrowdown') || has('s'));
    const left = Number(has('arrowleft') || has('a'));
    const right = Number(has('arrowright') || has('d'));
    const rise = Number(has(' ') || has('e'));
    const descend = Number(has('shift') || has('q'));
    return {
      lift: rise - descend,
      steering: right - left,
      throttle: forward - reverse,
      pausePressed: has('escape'),
      resetPressed: has('r'),
    };
  }

  function readGamepadAxes(gamepad, deadzone = DEFAULT_DEADZONE) {
    if (!gamepad) {
      return {
        lift: 0,
        throttle: 0,
        steering: 0,
        pausePressed: false,
        resetPressed: false,
      };
    }
    const buttons = gamepad.buttons || [];
    const axes = gamepad.axes || [];
    const dpadLeft = buttonValue(buttons[14]);
    const dpadRight = buttonValue(buttons[15]);
    const dpadUp = buttonValue(buttons[12]);
    const dpadDown = buttonValue(buttons[13]);
    const stickSteering = applyDeadzone(axes[0], deadzone);
    const stickThrottle = -applyDeadzone(axes[1], deadzone);
    const rightTrigger = buttonValue(buttons[7]);
    const leftTrigger = buttonValue(buttons[6]);
    const rightBumper = buttonValue(buttons[5]);
    const leftBumper = buttonValue(buttons[4]);
    const faceThrottle = buttonValue(buttons[0]);
    const faceBrake = buttonValue(buttons[2]);
    const triggerThrottle = rightTrigger - leftTrigger;
    const digitalThrottle = dpadUp - dpadDown || faceThrottle - faceBrake;

    return {
      lift: clamp(rightBumper - leftBumper),
      steering: clamp(dpadRight - dpadLeft || stickSteering),
      throttle: clamp(
        Math.abs(triggerThrottle) > 0.02
          ? triggerThrottle
          : digitalThrottle || stickThrottle
      ),
      pausePressed: Boolean(buttons[9] && buttons[9].pressed),
      resetPressed: Boolean(buttons[1] && buttons[1].pressed),
    };
  }

  function readXRInputSources(inputSources, deadzone = DEFAULT_DEADZONE) {
    const sources = Array.from(inputSources || []);
    const left = sources.find((source) => source.handedness === 'left' && source.gamepad);
    const right = sources.find((source) => source.handedness === 'right' && source.gamepad);
    const stickSource = left || right;
    const axes = stickSource ? stickSource.gamepad.axes || [] : [];
    const axisOffset = axes.length >= 4 ? 2 : 0;
    const rightTrigger = right ? buttonValue((right.gamepad.buttons || [])[0]) : 0;
    const leftTrigger = left ? buttonValue((left.gamepad.buttons || [])[0]) : 0;
    const rightSqueeze = right ? buttonValue((right.gamepad.buttons || [])[1]) : 0;
    const leftSqueeze = left ? buttonValue((left.gamepad.buttons || [])[1]) : 0;
    const stickThrottle = -applyDeadzone(axes[axisOffset + 1], deadzone);
    const resetButton = right && (right.gamepad.buttons || [])[5];
    const pauseButton = left && (left.gamepad.buttons || [])[5];
    return {
      lift: clamp(rightSqueeze - leftSqueeze),
      steering: applyDeadzone(axes[axisOffset], deadzone),
      throttle: clamp(
        Math.abs(rightTrigger - leftTrigger) > 0.02
          ? rightTrigger - leftTrigger
          : stickThrottle
      ),
      pausePressed: Boolean(pauseButton && pauseButton.pressed),
      resetPressed: Boolean(resetButton && resetButton.pressed),
    };
  }

  function mixAxes({ xr, keyboard, touch, gamepad, demo } = {}) {
    if (
      demo &&
      (
        Number.isFinite(demo.throttle) ||
        Number.isFinite(demo.steering) ||
        Number.isFinite(demo.lift)
      )
    ) {
      return {
        lift: clamp(demo.lift),
        throttle: clamp(demo.throttle),
        steering: clamp(demo.steering),
      };
    }
    const sources = [xr, keyboard, touch, gamepad].filter(Boolean);
    const firstActive = (axis) => {
      const source = sources.find((candidate) => Math.abs(candidate[axis] || 0) > 0.001);
      return source ? source[axis] : 0;
    };
    return {
      lift: clamp(firstActive('lift')),
      throttle: clamp(firstActive('throttle')),
      steering: clamp(firstActive('steering')),
    };
  }

  function normalizeRadialInput(dx, dy, maxRadius, deadzone = DEFAULT_DEADZONE) {
    const radius = Math.max(1, Number.isFinite(maxRadius) ? maxRadius : 1);
    const x = Number.isFinite(dx) ? dx : 0;
    const y = Number.isFinite(dy) ? dy : 0;
    const magnitude = Math.min(1, Math.hypot(x, y) / radius);
    if (magnitude <= deadzone) {
      return { knobX: 0, knobY: 0, steering: 0, throttle: 0 };
    }
    const directionX = x / (Math.hypot(x, y) || 1);
    const directionY = y / (Math.hypot(x, y) || 1);
    const normalizedMagnitude = (magnitude - deadzone) / (1 - deadzone);
    const knobMagnitude = magnitude * radius;
    return {
      knobX: directionX * knobMagnitude,
      knobY: directionY * knobMagnitude,
      steering: clamp(directionX * normalizedMagnitude),
      throttle: clamp(-directionY * normalizedMagnitude),
    };
  }

  function findActiveGamepad(gamepads, preferredIndex = null) {
    const available = Array.from(gamepads || []).filter(Boolean);
    return (
      available.find((gamepad) => gamepad.index === preferredIndex) ||
      available.find((gamepad) => gamepad.mapping === 'standard') ||
      available[0] ||
      null
    );
  }

  function getGamepadLabel(gamepad) {
    if (!gamepad) return 'Controller';
    if (/xbox|xinput|045e/i.test(gamepad.id || '')) return 'XInput controller';
    return gamepad.id || 'Gamepad';
  }

  return Object.freeze({
    DEFAULT_DEADZONE,
    applyDeadzone,
    clamp,
    findActiveGamepad,
    getGamepadLabel,
    mixAxes,
    normalizeRadialInput,
    readGamepadAxes,
    readKeyboardAxes,
    readXRInputSources,
  });
});

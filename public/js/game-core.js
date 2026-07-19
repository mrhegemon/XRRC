(function exposeGameCore(root, factory) {
  'use strict';

  const core = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  } else {
    root.XRRCGameCore = core;
  }
})(typeof window === 'undefined' ? globalThis : window, function createGameCore() {
  'use strict';

  const DEFAULT_PHYSICS = Object.freeze({
    acceleration: 3.8,
    reverseAcceleration: 2.4,
    maxForwardSpeed: 1.7,
    maxReverseSpeed: 0.82,
    coastDrag: 2.8,
    poweredDrag: 0.5,
    steeringRate: 3.35,
    minimumTurn: 0.24,
    driftSteering: 0.52,
    driftSpeedRatio: 0.34,
    collisionBounce: 0.16,
    bounds: 1.82,
  });
  const VEHICLE_SPECS = Object.freeze({
    rally: Object.freeze({
      label: 'Rally car',
      category: 'ground',
      rideHeight: 0.035,
      visualScale: 1.16,
      ratings: Object.freeze({ speed: 4, acceleration: 4, handling: 4, stability: 4 }),
      physics: Object.freeze({}),
    }),
    buggy: Object.freeze({
      label: 'Dune buggy',
      category: 'ground',
      rideHeight: 0.045,
      visualScale: 1.2,
      ratings: Object.freeze({ speed: 3, acceleration: 5, handling: 5, stability: 3 }),
      physics: Object.freeze({
        acceleration: 4.25,
        maxForwardSpeed: 1.58,
        steeringRate: 3.8,
        minimumTurn: 0.28,
        driftSteering: 0.4,
        driftSpeedRatio: 0.25,
        coastDrag: 2.5,
        collisionBounce: 0.2,
      }),
    }),
    truck: Object.freeze({
      label: '4x4 truck',
      category: 'ground',
      rideHeight: 0.052,
      visualScale: 1.1,
      ratings: Object.freeze({ speed: 3, acceleration: 3, handling: 3, stability: 5 }),
      physics: Object.freeze({
        acceleration: 3.05,
        reverseAcceleration: 2.05,
        maxForwardSpeed: 1.34,
        maxReverseSpeed: 0.68,
        steeringRate: 2.72,
        minimumTurn: 0.2,
        driftSteering: 0.68,
        driftSpeedRatio: 0.5,
        collisionBounce: 0.1,
      }),
    }),
    motorcycle: Object.freeze({
      label: 'RC motorcycle',
      category: 'ground',
      rideHeight: 0.04,
      visualScale: 1.45,
      ratings: Object.freeze({ speed: 5, acceleration: 5, handling: 5, stability: 2 }),
      physics: Object.freeze({
        acceleration: 4.6,
        maxForwardSpeed: 2.05,
        maxReverseSpeed: 0.48,
        steeringRate: 4.05,
        minimumTurn: 0.18,
        driftSteering: 0.36,
        driftSpeedRatio: 0.3,
        poweredDrag: 0.42,
        collisionBounce: 0.08,
      }),
    }),
    tank: Object.freeze({
      label: 'Mini tank',
      category: 'ground',
      rideHeight: 0.035,
      visualScale: 1.14,
      ratings: Object.freeze({ speed: 2, acceleration: 2, handling: 4, stability: 5 }),
      physics: Object.freeze({
        acceleration: 2.35,
        reverseAcceleration: 1.9,
        maxForwardSpeed: 0.92,
        maxReverseSpeed: 0.62,
        steeringRate: 2.35,
        minimumTurn: 0.54,
        driftSteering: 2,
        coastDrag: 3.6,
        poweredDrag: 0.8,
        collisionBounce: 0.04,
        pivotTurn: true,
      }),
    }),
    plane: Object.freeze({
      label: 'Prop plane',
      category: 'air',
      rideHeight: 0.31,
      groundHeight: 0.045,
      visualScale: 1.04,
      ratings: Object.freeze({ speed: 5, acceleration: 5, handling: 2, stability: 3 }),
      physics: Object.freeze({
        acceleration: 4.9,
        reverseAcceleration: 1.2,
        maxForwardSpeed: 2.45,
        maxReverseSpeed: 0.28,
        steeringRate: 1.72,
        minimumTurn: 0.12,
        driftSteering: 2,
        coastDrag: 1.2,
        poweredDrag: 0.32,
        collisionBounce: 0.04,
        bounds: 1.92,
      }),
      flight: Object.freeze({
        mode: 'plane',
        climbAcceleration: 3.4,
        gravity: 3.2,
        maxAltitude: 1.75,
        stallSpeed: 0.72,
        verticalDrag: 1.7,
      }),
    }),
    helicopter: Object.freeze({
      label: 'Helicopter',
      category: 'air',
      rideHeight: 0.42,
      groundHeight: 0.08,
      visualScale: 1.08,
      ratings: Object.freeze({ speed: 3, acceleration: 3, handling: 5, stability: 4 }),
      physics: Object.freeze({
        acceleration: 3.1,
        reverseAcceleration: 2.25,
        maxForwardSpeed: 1.48,
        maxReverseSpeed: 0.82,
        steeringRate: 3.7,
        minimumTurn: 0.5,
        driftSteering: 2,
        coastDrag: 1.8,
        poweredDrag: 0.55,
        collisionBounce: 0.03,
        pivotTurn: true,
        bounds: 1.92,
      }),
      flight: Object.freeze({
        mode: 'helicopter',
        climbAcceleration: 2.8,
        gravity: 0,
        maxAltitude: 1.55,
        stallSpeed: 0,
        verticalDrag: 2.4,
      }),
    }),
  });

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value));
  }

  function finiteOr(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
  }

  function normalizeVehicleType(value) {
    const type = String(value || '').toLowerCase();
    return Object.hasOwn(VEHICLE_SPECS, type) ? type : 'rally';
  }

  function getVehicleSpec(value) {
    return VEHICLE_SPECS[normalizeVehicleType(value)];
  }

  function stepCar(state, input, elapsed, overrides = {}) {
    const physics = { ...DEFAULT_PHYSICS, ...overrides };
    const dt = clamp(finiteOr(elapsed), 0, 0.05);
    const throttle = clamp(finiteOr(input && input.throttle), -1, 1);
    const steering = clamp(finiteOr(input && input.steering), -1, 1);
    let x = finiteOr(state && state.x);
    let z = finiteOr(state && state.z);
    let heading = finiteOr(state && state.heading);
    let velocity = finiteOr(state && state.velocity);

    if (throttle !== 0) {
      const acceleration = throttle > 0
        ? physics.acceleration
        : physics.reverseAcceleration;
      velocity += throttle * acceleration * dt;
    }

    const drag = throttle === 0 ? physics.coastDrag : physics.poweredDrag;
    velocity *= Math.exp(-drag * dt);
    velocity = clamp(velocity, -physics.maxReverseSpeed, physics.maxForwardSpeed);
    if (Math.abs(velocity) < 0.002 && throttle === 0) velocity = 0;

    const speedRatio = clamp(
      Math.abs(velocity) / physics.maxForwardSpeed,
      0,
      1
    );
    const direction = Math.sign(velocity || throttle) || (physics.pivotTurn ? 1 : 0);
    heading -= (
      steering *
      physics.steeringRate *
      direction *
      (physics.minimumTurn + speedRatio * (1 - physics.minimumTurn)) *
      dt
    );

    x -= Math.sin(heading) * velocity * dt;
    z -= Math.cos(heading) * velocity * dt;

    const bounds = typeof physics.bounds === 'number'
      ? { x: physics.bounds, z: physics.bounds }
      : physics.bounds;
    const clampedX = clamp(x, -bounds.x, bounds.x);
    const clampedZ = clamp(z, -bounds.z, bounds.z);
    const collided = clampedX !== x || clampedZ !== z;
    const impact = collided ? Math.abs(velocity) : 0;
    x = clampedX;
    z = clampedZ;
    if (collided) velocity *= -physics.collisionBounce;

    return {
      x,
      z,
      heading,
      velocity,
      impact,
      collided,
      speedRatio,
      drifting: (
        Math.abs(steering) > physics.driftSteering &&
        speedRatio > physics.driftSpeedRatio
      ),
      distance: Math.abs(velocity) * dt,
    };
  }

  function getDrivingPhysics(overrides = {}, context = {}) {
    const physics = { ...DEFAULT_PHYSICS, ...overrides };
    const surface = context.surface || 'road';
    if (context.airborne) {
      return {
        ...physics,
        acceleration: physics.acceleration * 0.12,
        reverseAcceleration: physics.reverseAcceleration * 0.12,
        steeringRate: physics.steeringRate * 0.32,
        coastDrag: 0.12,
        poweredDrag: 0.12,
      };
    }
    if (surface !== 'offroad') return physics;
    return {
      ...physics,
      acceleration: physics.acceleration * 0.62,
      reverseAcceleration: physics.reverseAcceleration * 0.68,
      maxForwardSpeed: physics.maxForwardSpeed * 0.58,
      maxReverseSpeed: physics.maxReverseSpeed * 0.72,
      steeringRate: physics.steeringRate * 0.72,
      coastDrag: Math.max(physics.coastDrag, 4.2),
      poweredDrag: Math.max(physics.poweredDrag, 1.65),
    };
  }

  function sampleCourseSurface(position, samples, roadWidth, stuntLane = null) {
    if (!position || !Array.isArray(samples) || samples.length < 2) {
      return {
        type: 'offroad',
        distance: Infinity,
        roadDistance: Infinity,
        progress: 0,
        nearest: { x: 0, z: 0 },
        tangent: { x: 0, z: -1 },
      };
    }

    let nearest = null;
    for (let index = 0; index < samples.length; index += 1) {
      const start = samples[index];
      const end = samples[(index + 1) % samples.length];
      const segmentX = finiteOr(end.x) - finiteOr(start.x);
      const segmentZ = finiteOr(end.z) - finiteOr(start.z);
      const lengthSquared = segmentX * segmentX + segmentZ * segmentZ;
      const along = lengthSquared > 0
        ? clamp(
            (
              (finiteOr(position.x) - finiteOr(start.x)) * segmentX +
              (finiteOr(position.z) - finiteOr(start.z)) * segmentZ
            ) / lengthSquared,
            0,
            1
          )
        : 0;
      const x = finiteOr(start.x) + segmentX * along;
      const z = finiteOr(start.z) + segmentZ * along;
      const distance = Math.hypot(finiteOr(position.x) - x, finiteOr(position.z) - z);
      if (nearest && distance >= nearest.distance) continue;
      const segmentLength = Math.sqrt(lengthSquared) || 1;
      nearest = {
        distance,
        nearest: { x, z },
        progress: (index + along) / samples.length,
        tangent: {
          x: segmentX / segmentLength,
          z: segmentZ / segmentLength,
        },
      };
    }

    let inStuntLane = false;
    if (stuntLane) {
      const dx = finiteOr(position.x) - finiteOr(stuntLane.x);
      const dz = finiteOr(position.z) - finiteOr(stuntLane.z);
      const rotation = finiteOr(stuntLane.rotation);
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      const localX = dx * cos + dz * sin;
      const localZ = -dx * sin + dz * cos;
      inStuntLane = (
        Math.abs(localX) <= Math.max(0, finiteOr(stuntLane.halfLength)) &&
        Math.abs(localZ) <= Math.max(0, finiteOr(stuntLane.halfWidth))
      );
    }

    const onRoad = nearest.distance <= Math.max(0, finiteOr(roadWidth)) / 2;
    return {
      ...nearest,
      roadDistance: nearest.distance,
      distance: inStuntLane ? 0 : nearest.distance,
      type: onRoad ? 'road' : inStuntLane ? 'stunt' : 'offroad',
    };
  }

  function stepVertical(state, input, elapsed, options = {}) {
    const dt = clamp(finiteOr(elapsed), 0, 0.05);
    const mode = options.mode || 'ground';
    const groundY = finiteOr(options.groundY);
    const maxAltitude = Math.max(groundY, finiteOr(options.maxAltitude, groundY + 2));
    const previousY = Math.max(groundY, finiteOr(state && state.y, groundY));
    let y = previousY;
    let velocityY = finiteOr(state && state.velocityY);
    let launched = false;
    let landed = false;
    let landingImpact = 0;

    if (mode === 'ground') {
      const launchSpeed = Math.max(0, finiteOr(options.launchSpeed));
      if (launchSpeed > 0 && y <= groundY + 0.003 && velocityY <= 0.01) {
        velocityY = launchSpeed;
        launched = true;
      }
      if (velocityY !== 0 || y > groundY + 0.001) {
        velocityY -= Math.max(0, finiteOr(options.gravity, 7.2)) * dt;
        y += velocityY * dt;
      }
    } else {
      const lift = clamp(finiteOr(input && input.lift), -1, 1);
      const forwardSpeed = Math.abs(finiteOr(options.forwardSpeed));
      const stallSpeed = Math.max(0.001, finiteOr(options.stallSpeed, 0.7));
      const support = mode === 'plane'
        ? clamp(forwardSpeed / stallSpeed, 0, 1)
        : 1;
      const gravity = Math.max(0, finiteOr(options.gravity));
      const climbAcceleration = Math.max(0, finiteOr(options.climbAcceleration, 2.8));
      velocityY += (
        lift * climbAcceleration -
        gravity * (1 - support)
      ) * dt;
      velocityY *= Math.exp(-Math.max(0, finiteOr(options.verticalDrag, 2)) * dt);
      y += velocityY * dt;
    }

    if (y <= groundY) {
      if (previousY > groundY + 0.005 && velocityY < -0.1) {
        landed = true;
        landingImpact = Math.abs(velocityY);
      }
      y = groundY;
      velocityY = 0;
    } else if (y >= maxAltitude) {
      y = maxAltitude;
      velocityY = Math.min(0, velocityY);
    }

    return {
      airborne: y > groundY + 0.01,
      grounded: y <= groundY + 0.001,
      landed,
      landingImpact,
      launched,
      velocityY,
      y,
    };
  }

  function stepLoop(state, elapsed, options = {}) {
    const dt = clamp(finiteOr(elapsed), 0, 0.05);
    const radius = Math.max(0.05, finiteOr(options.radius, 0.7));
    const direction = Math.sign(finiteOr(options.direction, 1)) || 1;
    const speed = Math.max(0.1, Math.abs(finiteOr(options.speed, 1)));
    const previousProgress = clamp(finiteOr(state && state.progress), 0, Math.PI * 2);
    const progress = Math.min(
      Math.PI * 2,
      previousProgress + (speed / radius) * dt
    );
    const angle = progress * direction;
    const groundY = finiteOr(options.groundY);
    const complete = progress >= Math.PI * 2;
    return {
      airborne: !complete,
      complete,
      pitch: complete ? 0 : -angle,
      progress,
      velocityY: complete ? 0 : speed * Math.sin(angle) * direction,
      x: finiteOr(options.centerX) + radius * Math.sin(angle),
      y: complete ? groundY : groundY + radius * (1 - Math.cos(angle)),
      z: finiteOr(options.centerZ),
    };
  }

  function speedToKph(velocity) {
    return Math.round(Math.abs(finiteOr(velocity)) * 18);
  }

  function getJumpLift(position, velocity, zones) {
    if (!position || Math.abs(finiteOr(velocity)) <= 0.45 || !Array.isArray(zones)) {
      return 0;
    }

    let lift = 0;
    for (const zone of zones) {
      const radius = Math.max(0.001, finiteOr(zone && zone.radius));
      const distance = Math.hypot(
        finiteOr(position.x) - finiteOr(zone && zone.x),
        finiteOr(position.z) - finiteOr(zone && zone.z)
      );
      if (distance >= radius) continue;
      lift = Math.max(
        lift,
        Math.sin((1 - distance / radius) * Math.PI / 2) *
          Math.max(0, finiteOr(zone && zone.lift))
      );
    }
    return lift;
  }

  function getRampLaunchSpeed(position, velocity, zones, gravity = 7.2) {
    const height = getJumpLift(position, velocity, zones);
    return height > 0 ? Math.sqrt(2 * Math.max(0.001, finiteOr(gravity, 7.2)) * height) : 0;
  }

  function verticalRangesOverlap(aY, aBounds, bY, bBounds) {
    const aMin = finiteOr(aY) + finiteOr(aBounds && aBounds.minY);
    const aMax = finiteOr(aY) + finiteOr(aBounds && aBounds.maxY);
    const bMin = finiteOr(bY) + finiteOr(bBounds && bBounds.minY);
    const bMax = finiteOr(bY) + finiteOr(bBounds && bBounds.maxY);
    return aMin < bMax && aMax > bMin;
  }

  function shouldAcceptNetworkState(lastSequence, state) {
    if (!state || typeof state !== 'object') return false;
    if (![state.x, state.y, state.z, state.ry, state.v, state.seq].every(Number.isFinite)) {
      return false;
    }
    return Number.isInteger(state.seq) && state.seq > finiteOr(lastSequence, -1);
  }

  function predictNetworkState(state, ageSeconds) {
    const age = clamp(finiteOr(ageSeconds), 0, 0.12);
    return {
      ...state,
      x: state.x - Math.sin(state.ry) * state.v * age,
      y: state.y + finiteOr(state.vy) * age,
      z: state.z - Math.cos(state.ry) * state.v * age,
    };
  }

  return Object.freeze({
    DEFAULT_PHYSICS,
    VEHICLE_SPECS,
    clamp,
    getDrivingPhysics,
    getJumpLift,
    getRampLaunchSpeed,
    getVehicleSpec,
    normalizeVehicleType,
    predictNetworkState,
    sampleCourseSurface,
    shouldAcceptNetworkState,
    speedToKph,
    stepCar,
    stepLoop,
    stepVertical,
    verticalRangesOverlap,
  });
});

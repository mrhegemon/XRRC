'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../public/js/game-core');

const START = Object.freeze({
  x: 0,
  z: 1,
  heading: 0,
  velocity: 0,
});

test('accelerates forward and reports useful telemetry', () => {
  const next = Core.stepCar(START, { throttle: 1, steering: 0 }, 0.05);

  assert.ok(next.velocity > 0);
  assert.ok(next.z < START.z);
  assert.ok(next.distance > 0);
  assert.equal(next.collided, false);
  assert.equal(next.drifting, false);
});

test('uses frame-rate independent drag when coasting', () => {
  const fast = Core.stepCar(
    { ...START, velocity: 1 },
    { throttle: 0, steering: 0 },
    0.05
  );
  const twoSteps = Core.stepCar(
    Core.stepCar(
      { ...START, velocity: 1 },
      { throttle: 0, steering: 0 },
      0.025
    ),
    { throttle: 0, steering: 0 },
    0.025
  );

  assert.ok(Math.abs(fast.velocity - twoSteps.velocity) < 1e-10);
});

test('steers in opposite directions when reversing', () => {
  const forward = Core.stepCar(
    { ...START, velocity: 0.8 },
    { throttle: 0, steering: 1 },
    0.05
  );
  const reverse = Core.stepCar(
    { ...START, velocity: -0.8 },
    { throttle: 0, steering: 1 },
    0.05
  );

  assert.ok(forward.heading < 0);
  assert.ok(reverse.heading > 0);
});

test('clamps large frame gaps and bounces at the track boundary', () => {
  const largeFrame = Core.stepCar(START, { throttle: 1, steering: 0 }, 1);
  const clampedFrame = Core.stepCar(START, { throttle: 1, steering: 0 }, 0.05);
  assert.deepEqual(largeFrame, clampedFrame);

  const collision = Core.stepCar(
    { x: 0, z: -0.99, heading: 0, velocity: 1 },
    { throttle: 0, steering: 0 },
    0.05,
    { bounds: 1 }
  );
  assert.equal(collision.z, -1);
  assert.equal(collision.collided, true);
  assert.ok(collision.impact > 0);
  assert.ok(collision.velocity < 0);
});

test('converts simulation velocity into readable RC scale speed', () => {
  assert.equal(Core.speedToKph(0), 0);
  assert.equal(Core.speedToKph(-1.5), 27);
  assert.equal(Core.speedToKph(Number.NaN), 0);
});

test('activates speed-gated jump zones with peak lift at the ramp center', () => {
  const zones = [
    { x: -2.45, z: 0.12, radius: 0.52, lift: 0.2 },
    { x: 2.45, z: 0.12, radius: 0.52, lift: 0.2 },
    { x: -0.75, z: 0.12, radius: 0.46, lift: 0.11 },
  ];

  assert.equal(Core.getJumpLift({ x: -2.45, z: 0.12 }, 0.45, zones), 0);
  assert.equal(Core.getJumpLift({ x: 8, z: 8 }, 1, zones), 0);
  assert.equal(Core.getJumpLift({ x: -2.45, z: 0.12 }, 1, zones), 0.2);
  assert.ok(Core.getJumpLift({ x: -2.7, z: 0.12 }, 1, zones) > 0);
  assert.ok(Core.getJumpLift({ x: -0.75, z: 0.12 }, 1, zones) < 0.2);
  assert.ok(Core.getRampLaunchSpeed({ x: -2.45, z: 0.12 }, 1, zones) > 1.6);
});

test('applies off-road drag and reduces control while airborne', () => {
  const road = Core.getDrivingPhysics({}, { surface: 'road' });
  const offroad = Core.getDrivingPhysics({}, { surface: 'offroad' });
  const airborne = Core.getDrivingPhysics({}, { airborne: true, surface: 'road' });

  assert.ok(offroad.maxForwardSpeed < road.maxForwardSpeed);
  assert.ok(offroad.poweredDrag > road.poweredDrag);
  assert.ok(offroad.steeringRate < road.steeringRate);
  assert.ok(airborne.acceleration < offroad.acceleration);
  assert.ok(airborne.steeringRate < offroad.steeringRate);
});

test('samples road, stunt-lane, and off-road surfaces with progress', () => {
  const samples = [
    { x: -1, z: -1 },
    { x: 1, z: -1 },
    { x: 1, z: 1 },
    { x: -1, z: 1 },
  ];
  const road = Core.sampleCourseSurface({ x: 0, z: -0.9 }, samples, 0.4);
  const stunt = Core.sampleCourseSurface(
    { x: 0, z: 0 },
    samples,
    0.4,
    { x: 0, z: 0, halfLength: 0.5, halfWidth: 0.2, rotation: 0 }
  );
  const offroad = Core.sampleCourseSurface({ x: 0, z: 0 }, samples, 0.4);

  assert.equal(road.type, 'road');
  assert.ok(road.progress >= 0 && road.progress <= 1);
  assert.equal(stunt.type, 'stunt');
  assert.equal(offroad.type, 'offroad');
  assert.deepEqual(road.tangent, { x: 1, z: 0 });
});

test('launches, lands, and reports vertical impact for ground vehicles', () => {
  let state = Core.stepVertical(
    { y: 0.04, velocityY: 0 },
    { lift: 0 },
    1 / 60,
    { groundY: 0.04, gravity: 7.2, launchSpeed: 2.4, mode: 'ground' }
  );
  assert.equal(state.launched, true);
  assert.equal(state.airborne, true);

  let landed = false;
  for (let frame = 0; frame < 120; frame += 1) {
    state = Core.stepVertical(
      state,
      { lift: 0 },
      1 / 60,
      { groundY: 0.04, gravity: 7.2, mode: 'ground' }
    );
    if (state.landed) {
      landed = true;
      assert.ok(state.landingImpact > 1);
      break;
    }
  }
  assert.equal(landed, true);
  assert.equal(state.y, 0.04);
});

test('supports controlled aircraft altitude and height-aware overlaps', () => {
  const rising = Core.stepVertical(
    { y: 0.4, velocityY: 0 },
    { lift: 1 },
    0.05,
    {
      climbAcceleration: 3,
      forwardSpeed: 1,
      groundY: 0.08,
      gravity: 0,
      maxAltitude: 1.5,
      mode: 'helicopter',
      verticalDrag: 2,
    }
  );
  assert.ok(rising.y > 0.4);
  assert.ok(rising.velocityY > 0);
  assert.equal(
    Core.verticalRangesOverlap(
      0.04,
      { minY: 0, maxY: 0.2 },
      0.5,
      { minY: 0, maxY: 0.2 }
    ),
    false
  );
  assert.equal(
    Core.verticalRangesOverlap(
      0.04,
      { minY: 0, maxY: 0.2 },
      0.18,
      { minY: 0, maxY: 0.2 }
    ),
    true
  );
});

test('moves a vehicle through a complete vertical stunt loop', () => {
  let state = { progress: 0 };
  let peakY = 0;
  for (let frame = 0; frame < 240; frame += 1) {
    state = Core.stepLoop(state, 1 / 60, {
      centerX: 1.35,
      centerZ: 0.1,
      direction: 1,
      groundY: 0.04,
      radius: 0.7,
      speed: 1.5,
    });
    peakY = Math.max(peakY, state.y);
    if (state.complete) break;
  }
  assert.equal(state.complete, true);
  assert.equal(state.y, 0.04);
  assert.ok(peakY > 1.4);
  assert.ok(Math.abs(state.x - 1.35) < 1e-10);
});

test('exposes distinct handling for every selectable vehicle', () => {
  const types = [
    'rally',
    'buggy',
    'truck',
    'motorcycle',
    'tank',
    'plane',
    'helicopter',
  ];
  assert.deepEqual(Object.keys(Core.VEHICLE_SPECS), types);
  assert.equal(Core.normalizeVehicleType('PLANE'), 'plane');
  assert.equal(Core.normalizeVehicleType('unknown'), 'rally');
  assert.equal(Core.getVehicleSpec('helicopter').category, 'air');
  assert.ok(
    Core.getVehicleSpec('motorcycle').physics.maxForwardSpeed >
    Core.getVehicleSpec('tank').physics.maxForwardSpeed
  );
});

test('publishes a complete and unique handling card for every vehicle class', () => {
  const expectedRatings = {
    rally: { speed: 4, acceleration: 4, handling: 4, stability: 4 },
    buggy: { speed: 3, acceleration: 5, handling: 5, stability: 3 },
    truck: { speed: 3, acceleration: 3, handling: 3, stability: 5 },
    motorcycle: { speed: 5, acceleration: 5, handling: 5, stability: 2 },
    tank: { speed: 2, acceleration: 2, handling: 4, stability: 5 },
    plane: { speed: 5, acceleration: 5, handling: 2, stability: 3 },
    helicopter: { speed: 3, acceleration: 3, handling: 5, stability: 4 },
  };
  const cards = new Set();

  for (const [type, spec] of Object.entries(Core.VEHICLE_SPECS)) {
    const physics = { ...Core.DEFAULT_PHYSICS, ...spec.physics };
    assert.deepEqual(spec.ratings, expectedRatings[type]);
    assert.ok(spec.visualScale >= 0.8 && spec.visualScale <= 1.5);
    assert.ok(physics.minimumTurn >= 0 && physics.minimumTurn <= 1);
    assert.ok(physics.driftSpeedRatio > 0 && physics.driftSpeedRatio < 1);
    cards.add(JSON.stringify(spec.ratings));
  }

  assert.equal(cards.size, Object.keys(expectedRatings).length);
});

test('simulates the intended speed, steering, and drift hierarchy', () => {
  const samples = {};

  for (const type of Object.keys(Core.VEHICLE_SPECS)) {
    const physics = { ...Core.getVehicleSpec(type).physics, bounds: 100 };
    let state = { ...START, z: 0 };

    for (let frame = 0; frame < 120; frame += 1) {
      state = Core.stepCar(state, { throttle: 1, steering: 0 }, 1 / 60, physics);
    }
    const straightSpeed = state.velocity;
    const initialHeading = state.heading;

    for (let frame = 0; frame < 60; frame += 1) {
      state = Core.stepCar(state, { throttle: 1, steering: 1 }, 1 / 60, physics);
    }

    let driftState = { ...START, z: 0 };
    let driftFrame = -1;
    for (let frame = 0; frame < 60; frame += 1) {
      driftState = Core.stepCar(
        driftState,
        { throttle: 1, steering: 1 },
        1 / 60,
        physics
      );
      if (driftState.drifting && driftFrame < 0) driftFrame = frame;
    }

    samples[type] = {
      driftFrame,
      straightSpeed,
      turn: Math.abs(state.heading - initialHeading),
    };
  }

  assert.ok(samples.plane.straightSpeed > samples.motorcycle.straightSpeed);
  assert.ok(samples.motorcycle.straightSpeed > samples.rally.straightSpeed);
  assert.ok(samples.rally.straightSpeed > samples.buggy.straightSpeed);
  assert.ok(samples.buggy.straightSpeed > samples.helicopter.straightSpeed);
  assert.ok(samples.helicopter.straightSpeed > samples.truck.straightSpeed);
  assert.ok(samples.truck.straightSpeed > samples.tank.straightSpeed);

  assert.ok(samples.motorcycle.turn > samples.buggy.turn);
  assert.ok(samples.buggy.turn > samples.helicopter.turn);
  assert.ok(samples.helicopter.turn > samples.rally.turn);
  assert.ok(samples.rally.turn > samples.truck.turn);
  assert.ok(samples.truck.turn > samples.plane.turn);

  assert.ok(samples.buggy.driftFrame < samples.motorcycle.driftFrame);
  assert.ok(samples.motorcycle.driftFrame < samples.rally.driftFrame);
  assert.ok(samples.rally.driftFrame < samples.truck.driftFrame);
  assert.equal(samples.tank.driftFrame, -1);
  assert.equal(samples.plane.driftFrame, -1);
  assert.equal(samples.helicopter.driftFrame, -1);
});

test('lets tracked vehicles pivot while stationary', () => {
  const tank = Core.stepCar(
    START,
    { throttle: 0, steering: 1 },
    0.05,
    Core.getVehicleSpec('tank').physics
  );
  const rally = Core.stepCar(
    START,
    { throttle: 0, steering: 1 },
    0.05,
    Core.getVehicleSpec('rally').physics
  );

  assert.notEqual(tank.heading, 0);
  assert.equal(rally.heading, 0);
});

test('rejects stale unordered snapshots and predicts short network gaps', () => {
  const state = {
    x: 1,
    y: 0.04,
    z: 1,
    ry: 0,
    v: 1.5,
    vy: 0.4,
    seq: 8,
    type: 'truck',
  };

  assert.equal(Core.shouldAcceptNetworkState(7, state), true);
  assert.equal(Core.shouldAcceptNetworkState(8, state), false);
  assert.equal(Core.shouldAcceptNetworkState(9, { ...state, seq: 10, x: NaN }), false);
  const predicted = Core.predictNetworkState(state, 0.1);
  assert.deepEqual(predicted, {
    ...state,
    x: 1,
    y: predicted.y,
    z: 0.85,
  });
  assert.ok(Math.abs(predicted.y - 0.08) < 1e-10);
  assert.ok(Math.abs(Core.predictNetworkState(state, 9).z - 0.82) < 1e-10);
});

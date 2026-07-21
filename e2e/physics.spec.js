'use strict';

const { test, expect } = require('@playwright/test');

async function waitForRace(page) {
  await page.waitForFunction(() => window.XRRC_DIAGNOSTICS?.snapshot().calls > 0);
  // An empty #countdown also matches the window before the countdown starts, so
  // waiting on it alone lets a test drive the car while the grid still holds it.
  // Wait for the race to actually be running instead.
  await page.waitForFunction(
    () => window.XRRC_DIAGNOSTICS?.snapshot().race.status === 'racing',
    null,
    { timeout: 15_000 }
  );
}

test('tracks progress from the grid and reports route state', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&track=backyard&vehicle=rally&rivals=0');
  await waitForRace(page);

  const initial = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  expect(initial.surface.type).toBe('road');
  expect(initial.race.progress).toBe(0);
  await expect(page.locator('#route-status')).toHaveText('On course');

  await page.keyboard.down('w');
  await page.waitForTimeout(900);
  await page.keyboard.up('w');

  const driven = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  expect(driven.race.progress).toBeGreaterThan(0.01);
  expect(driven.race.wrongWay).toBe(false);
  await expect(page.locator('#race-progress-bar')).not.toHaveAttribute('aria-valuenow', '0');
});

test('ordered checkpoints reject off-road finish-line shortcuts', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&track=backyard&vehicle=rally&rivals=0');
  await waitForRace(page);

  for (const progress of [0.21, 0.23, 0.46, 0.48, 0.71, 0.73, 0.89]) {
    await page.evaluate((value) => window.XRRC_DIAGNOSTICS.setCourseProgress(value), progress);
    await page.waitForTimeout(70);
  }
  let race = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().race);
  expect(race.nextCheckpoint).toBe(3);

  await page.evaluate(() => {
    window.XRRC_DIAGNOSTICS.setLocalVehicleState({ x: 0, z: 1.2, velocity: 0 });
  });
  await page.waitForTimeout(70);
  await page.evaluate(() => window.XRRC_DIAGNOSTICS.setCourseProgress(0.05));
  await page.waitForTimeout(70);
  race = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().race);
  expect(race.lap).toBe(1);
  expect(race.nextCheckpoint).toBe(0);
  expect(race.lapElapsedMs).toBeGreaterThan(0);
  expect(race.sectorStartedAt).toBe(0);
});

test('ramps launch the physical vehicle and gravity returns it to the ground', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&track=harbor&vehicle=motorcycle&rivals=0');
  await waitForRace(page);

  // Ramps ride the racing line, so their positions come from the course
  // itself rather than fixed coordinates.
  await page.evaluate(() => {
    const [ramp] = window.XRRC_DIAGNOSTICS.snapshot().jumpZones;
    window.XRRC_DIAGNOSTICS.setLocalVehicleState({
      x: ramp.x,
      y: 0.04,
      z: ramp.z,
      heading: ramp.carHeading,
      velocity: 1.8,
      verticalVelocity: 0,
    });
  });

  await expect.poll(async () => (
    page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().localVehiclePeakY)
  )).toBeGreaterThan(0.25);
  await expect.poll(async () => (
    page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().localVehicleRender.airborne)
  ), { timeout: 3_000 }).toBe(false);
  const landed = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  expect(landed.localVehiclePosition.y).toBeCloseTo(0.04, 3);
  expect(landed.localVehicleVerticalSpeed).toBe(0);
});

test('static obstacle bodies bounce vehicles instead of allowing pass-through', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&track=backyard&vehicle=rally&rivals=0');
  await waitForRace(page);

  const setup = await page.evaluate(() => {
    const diagnostics = window.XRRC_DIAGNOSTICS.snapshot();
    const collider = diagnostics.staticColliders.find(({ label }) => label === 'barrier');
    const carBounds = diagnostics.localVehicleRender.bounds;
    const normal = {
      x: -Math.sin(collider.theta),
      z: Math.cos(collider.theta),
    };
    const distance = collider.hz + carBounds.z + 0.14;
    const before = {
      x: collider.x + normal.x * distance,
      z: collider.z + normal.z * distance,
    };
    window.XRRC_DIAGNOSTICS.setLocalVehicleState({
      ...before,
      y: 0.035,
      heading: Math.atan2(normal.x, normal.z),
      velocity: 1.25,
    });
    return {
      before,
      clearance: collider.hz + carBounds.z,
      collider,
      normal,
    };
  });

  await expect.poll(async () => (
    page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().lastStaticCollision?.label)
  )).toBe('barrier');
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  const afterDistance = (
    (after.localVehiclePosition.x - setup.collider.x) * setup.normal.x +
    (after.localVehiclePosition.z - setup.collider.z) * setup.normal.z
  );
  expect(afterDistance).toBeGreaterThan(setup.clearance - 0.01);
  expect(after.localVehicleSpeed).toBeLessThan(1.25);

  await page.locator('#reset-btn').click();
  await page.waitForTimeout(350);
  const reset = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  expect(Math.abs(reset.localVehiclePosition.x - reset.startGrid.x)).toBeLessThan(0.01);
  expect(Math.abs(reset.localVehiclePosition.z - reset.startGrid.z)).toBeLessThan(0.01);
});

test('the stunt loop carries a ground vehicle through a full vertical path', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&track=harbor&vehicle=rally&rivals=0');
  await waitForRace(page);
  // The loop now straddles the racing line on the start/finish straight, so
  // approach it from wherever the course actually places it.
  await page.evaluate(() => {
    const { loopFeature } = window.XRRC_DIAGNOSTICS.snapshot();
    window.XRRC_DIAGNOSTICS.setLocalVehicleState({
      x: loopFeature.centerX,
      y: 0.035,
      z: loopFeature.centerZ,
      heading: -Math.PI / 2,
      velocity: 1.8,
      verticalVelocity: 0,
    });
  });
  await expect.poll(async () => (
    page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().localVehicleRender.looping)
  )).toBe(true);
  await expect.poll(async () => (
    page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().localVehiclePosition.y)
  ), { timeout: 10_000 }).toBeGreaterThan(0.8);
  await expect.poll(async () => (
    page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().localVehicleRender.looping)
  ), { timeout: 10_000 }).toBe(false);
  const completed = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  expect(completed.localVehiclePosition.y).toBeCloseTo(0.035, 3);
});

test('the running game classifies and reports off-road terrain', async ({ page }) => {
  // The speed/grip penalty itself is unit-tested deterministically in
  // test/game-core.test.js ("applies off-road drag and reduces control").
  // What only a browser can check is that a live race classifies a real
  // off-course position correctly and surfaces it to the player, so this test
  // covers the integration rather than re-measuring the physics.
  await page.goto('/?signal=off&mode=desktop&track=backyard&vehicle=rally&rivals=0&assist=off');
  await waitForRace(page);
  // Auto recovery exists to rescue a stranded player; it would pull the parked
  // car back onto asphalt before the assertions run.
  await page.evaluate(() => window.XRRC_DIAGNOSTICS.setRecoveryEnabled(false));

  const onRoad = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  expect(onRoad.surface.type).toBe('road');
  await expect(page.locator('#route-status')).toHaveText('On course');

  const parked = await page.evaluate(() => {
    const grid = window.XRRC_DIAGNOSTICS.snapshot().startGrid;
    // Road half-width plus shoulder is ~0.83, so 1.2 into the infield is grass.
    window.XRRC_DIAGNOSTICS.setLocalVehicleState({
      x: grid.x,
      z: grid.z - 1.2 * (Math.sign(grid.z) || 1),
      y: 0.035,
      heading: Math.PI / 2,
      velocity: 0,
      verticalVelocity: 0,
    });
    return window.XRRC_DIAGNOSTICS.snapshot();
  });
  expect(parked.surface.type).toBe('offroad');
  expect(parked.surface.roadDistance).toBeGreaterThan(onRoad.surface.roadDistance);
  await expect(page.locator('#route-status')).toHaveText('Off course');
});

test('vehicle collisions ignore vertically separated racers', async ({ page }) => {
  // The pure "collide only when vertical ranges overlap" rule is covered
  // deterministically in test/game-core.test.js. This proves the live resolver
  // actually consults it. A ground vehicle dropped from altitude raced gravity -
  // under CI load it fell into the parked car and registered the very collision
  // the test denies - so the flyer holds altitude instead: the helicopter's
  // flight profile has zero gravity, so it stays put no matter how slow a frame
  // is, and the result no longer depends on timing.
  await page.goto('/?signal=off&mode=desktop&track=backyard&vehicle=rally&rivals=0');
  await waitForRace(page);
  await page.evaluate(() => window.XRRC_DIAGNOSTICS.summonVehicle('helicopter'));
  await expect.poll(async () => (
    page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().localVehicle)
  )).toBe('helicopter');

  // Settle N frames, then report the flyer's state relative to the parked car.
  const settle = (frames) => page.evaluate((count) => new Promise((resolve) => {
    let seen = 0;
    const tick = () => {
      if (seen++ < count) {
        requestAnimationFrame(tick);
        return;
      }
      const snapshot = window.XRRC_DIAGNOSTICS.snapshot();
      const parked = snapshot.worldVehicleStates.find(({ type }) => type === 'rally');
      resolve({
        airborne: snapshot.localVehicleRender.airborne,
        drift: Math.hypot(
          snapshot.localVehiclePosition.x - parked.position.x,
          snapshot.localVehiclePosition.z - parked.position.z
        ),
      });
    };
    requestAnimationFrame(tick);
  }), frames);

  const parked = await page.evaluate(() => {
    window.XRRC_DIAGNOSTICS.setCourseProgress(0.5);
    const position = window.XRRC_DIAGNOSTICS.snapshot().localVehiclePosition;
    window.XRRC_DIAGNOSTICS.setWorldVehicleState('rally', {
      x: position.x,
      y: 0.035,
      z: position.z,
    });
    // Park the flyer well above the ground car: their vertical ranges do not
    // overlap, so the resolver must leave it in place.
    window.XRRC_DIAGNOSTICS.setLocalVehicleState({
      x: position.x,
      y: 1.5,
      z: position.z,
      velocity: 0,
      verticalVelocity: 0,
    });
    return window.XRRC_DIAGNOSTICS.snapshot()
      .worldVehicleStates.find(({ type }) => type === 'rally');
  });

  const separated = await settle(12);
  expect(separated.airborne).toBe(true);
  expect(separated.drift).toBeLessThan(0.02);

  // Drop the flyer to the ground car's height so the ranges overlap, and the
  // resolver must now knock it clear.
  await page.evaluate((position) => {
    window.XRRC_DIAGNOSTICS.setLocalVehicleState({
      x: position.x,
      y: 0.08,
      z: position.z,
      velocity: 0.3,
      verticalVelocity: 0,
    });
  }, parked.position);

  const overlapping = await settle(12);
  expect(overlapping.drift).toBeGreaterThan(0.02);
});

test('course-boundary escape recovers to the last safe road pose', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&track=sakura&vehicle=rally&rivals=0');
  await waitForRace(page);
  const initial = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());

  await page.evaluate(() => {
    const diagnostics = window.XRRC_DIAGNOSTICS.snapshot();
    window.XRRC_DIAGNOSTICS.setLocalVehicleState({
      x: diagnostics.trackBounds.x,
      z: 0,
      heading: -Math.PI / 2,
      velocity: 1,
    });
  });

  await expect(page.locator('#toast')).toHaveText('Recovered to the course');
  await expect.poll(async () => (
    page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().surface.type)
  )).toBe('road');
  const recovered = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  // Recovery settles the car onto the grid; the allowance tracks course scale
  // so the assertion stays as tight relative to the circuit as it ever was.
  const tolerance = 0.05 * (initial.courseScale / 1.42);
  expect(Math.abs(recovered.localVehiclePosition.x - initial.startGrid.x)).toBeLessThan(tolerance);
  expect(Math.abs(recovered.localVehiclePosition.z - initial.startGrid.z)).toBeLessThan(tolerance);
});

test('switching vehicles off-road preserves the last safe recovery pose', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&track=desert&vehicle=rally&rivals=0');
  await waitForRace(page);
  const initial = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  await page.evaluate(() => {
    window.XRRC_DIAGNOSTICS.setLocalVehicleState({
      x: 0,
      z: 1.2,
      heading: 0,
      velocity: 0,
    });
  });
  await page.locator('#vehicle-bay .vehicle-slot[aria-label="Dune buggy"]').click();
  await expect.poll(async () => (
    page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().localVehicle)
  )).toBe('buggy');
  await page.evaluate(() => window.XRRC_DIAGNOSTICS.recover());

  const recovered = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  expect(recovered.surface.type).toBe('road');
  expect(Math.abs(recovered.localVehiclePosition.x - initial.startGrid.x)).toBeLessThan(0.05);
  expect(Math.abs(recovered.localVehiclePosition.z - initial.startGrid.z)).toBeLessThan(0.05);
});

test('saved recovery poses remain clear of trackside obstacles', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&track=harbor&vehicle=rally&rivals=0');
  await waitForRace(page);
  await page.evaluate(() => {
    const diagnostics = window.XRRC_DIAGNOSTICS.snapshot();
    const cone = diagnostics.staticColliders.find(({ label }) => label === 'traffic-cone');
    const surface = window.XRRC_DIAGNOSTICS.sampleSurface(cone);
    const normal = { x: -surface.tangent.z, z: surface.tangent.x };
    const choices = [1, -1].map((side) => ({
      x: surface.nearest.x + normal.x * 0.38 * side,
      z: surface.nearest.z + normal.z * 0.38 * side,
    }));
    const position = choices.sort((a, b) => (
      Math.hypot(b.x - cone.x, b.z - cone.z) -
      Math.hypot(a.x - cone.x, a.z - cone.z)
    ))[0];
    window.XRRC_DIAGNOSTICS.setLocalVehicleState({
      ...position,
      heading: Math.atan2(-surface.tangent.x, -surface.tangent.z),
      velocity: 0,
    });
  });
  await page.waitForTimeout(150);

  const diagnostics = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  expect(diagnostics.surface.type).toBe('road');
  expect(diagnostics.recoveryPoseClear).toBe(true);
});

test('aircraft altitude controls produce real vertical movement', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&track=lunar&vehicle=helicopter&rivals=0');
  await waitForRace(page);
  const initialY = await page.evaluate(() => (
    window.XRRC_DIAGNOSTICS.snapshot().localVehiclePosition.y
  ));

  await page.keyboard.down(' ');
  await page.waitForTimeout(500);
  await page.keyboard.up(' ');
  const raisedY = await page.evaluate(() => (
    window.XRRC_DIAGNOSTICS.snapshot().localVehiclePosition.y
  ));
  expect(raisedY).toBeGreaterThan(initialY + 0.15);
  await expect(page.locator('#route-status')).toHaveText('Airborne');

  await page.keyboard.down('Shift');
  await page.waitForTimeout(500);
  await page.keyboard.up('Shift');
  const loweredY = await page.evaluate(() => (
    window.XRRC_DIAGNOSTICS.snapshot().localVehiclePosition.y
  ));
  expect(loweredY).toBeLessThan(raisedY);

  await page.keyboard.down('w');
  await expect.poll(async () => (
    page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().localVehicleSpeed)
  ), { timeout: 5_000 }).toBeGreaterThan(0.7);
  // Read while the throttle is still down. Sampling after keyboard.up() raced
  // the aircraft's deceleration: on a fast machine the round trip is a few
  // milliseconds, but on a loaded CI runner enough time passes for the speed to
  // decay back below the threshold the poll just proved it had passed.
  const flightSpeed = await page.evaluate(() => (
    window.XRRC_DIAGNOSTICS.snapshot().localVehicleSpeed
  ));
  await page.keyboard.up('w');
  expect(flightSpeed).toBeGreaterThan(0.7);
});

test('airborne aircraft ignore the ground surface below them', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&track=backyard&vehicle=helicopter&rivals=0');
  await waitForRace(page);
  await page.evaluate(() => {
    window.XRRC_DIAGNOSTICS.setLocalVehicleState({
      x: 0,
      y: 0.8,
      z: 1.2,
      heading: Math.PI / 2,
      velocity: 0,
      verticalVelocity: 0,
    });
  });
  await page.waitForTimeout(100);
  const diagnostics = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  expect(diagnostics.surface.type).toBe('offroad');
  expect(diagnostics.localVehicleRender.airborne).toBe(true);
  expect(diagnostics.localVehicleRender.drivingSurface).toBe('road');
});

test('Quest reset input is edge-triggered into the game', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&track=lunar&vehicle=rally&rivals=0');
  await waitForRace(page);
  await page.evaluate(() => {
    window.__xrrcResetEvents = 0;
    document.addEventListener('car-reset', () => {
      window.__xrrcResetEvents += 1;
    });
    window.XRRC_XR_INPUT = {
      lift: 0,
      resetPressed: true,
      steering: 0,
      throttle: 0,
    };
  });
  await expect.poll(async () => page.evaluate(() => window.__xrrcResetEvents)).toBe(1);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.__xrrcResetEvents)).toBe(1);

  await page.evaluate(() => {
    window.XRRC_XR_INPUT.resetPressed = false;
  });
  await page.waitForTimeout(50);
  await page.evaluate(() => {
    window.XRRC_XR_INPUT.resetPressed = true;
  });
  await expect.poll(async () => page.evaluate(() => window.__xrrcResetEvents)).toBe(2);
});

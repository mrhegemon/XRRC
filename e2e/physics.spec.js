'use strict';

const { test, expect } = require('@playwright/test');

async function waitForRace(page) {
  await page.waitForFunction(() => window.XRRC_DIAGNOSTICS?.snapshot().calls > 0);
  await expect(page.locator('#countdown')).toHaveText('', { timeout: 6_000 });
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

  await page.evaluate(() => {
    const radius = 0.42 * 1.42;
    window.XRRC_DIAGNOSTICS.setLocalVehicleState({
      x: 1.95 * 1.42 + radius * 0.7,
      y: 0.04,
      z: 0.08 * 1.42,
      heading: Math.PI / 2,
      velocity: 1.5,
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
  await page.evaluate(() => {
    window.XRRC_DIAGNOSTICS.setLocalVehicleState({
      x: 0.95 * 1.42 - 0.2,
      y: 0.035,
      z: 0.08 * 1.42,
      heading: -Math.PI / 2,
      velocity: 1.5,
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

test('off-road terrain reduces acceleration and top speed', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&track=backyard&vehicle=rally&rivals=0');
  await waitForRace(page);

  const sampleSpeed = async (state) => {
    await page.evaluate((nextState) => {
      window.XRRC_DIAGNOSTICS.setLocalVehicleState({
        ...nextState,
        y: 0.035,
        velocity: 0,
        verticalVelocity: 0,
      });
      window.XRRC_DEMO_INPUT = { throttle: 1, steering: 0 };
    }, state);
    await page.waitForTimeout(650);
    const snapshot = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
    await page.evaluate(() => {
      window.XRRC_DEMO_INPUT = null;
    });
    return snapshot;
  };

  const road = await sampleSpeed({ x: 1.136, z: 3.195, heading: Math.PI / 2 });
  const offroad = await sampleSpeed({ x: 0, z: 1.2, heading: Math.PI / 2 });
  expect(road.surface.type).toBe('road');
  expect(offroad.surface.type).toBe('offroad');
  expect(offroad.localVehicleSpeed).toBeLessThan(road.localVehicleSpeed * 0.8);
});

test('vehicle collisions ignore vertically separated racers', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&track=backyard&vehicle=rally&rivals=0');
  await waitForRace(page);
  await page.evaluate(() => window.XRRC_DIAGNOSTICS.summonVehicle('buggy'));
  await expect.poll(async () => (
    page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().localVehicle)
  )).toBe('buggy');

  const parked = await page.evaluate(() => {
    window.XRRC_DIAGNOSTICS.setCourseProgress(0.5);
    const position = window.XRRC_DIAGNOSTICS.snapshot().localVehiclePosition;
    window.XRRC_DIAGNOSTICS.setWorldVehicleState('rally', {
      x: position.x,
      y: 0.035,
      z: position.z,
    });
    window.XRRC_DIAGNOSTICS.setLocalVehicleState({
      x: position.x,
      y: 2,
      z: position.z,
      velocity: 0,
      verticalVelocity: 0,
    });
    return window.XRRC_DIAGNOSTICS.snapshot()
      .worldVehicleStates.find(({ type }) => type === 'rally');
  });
  await page.waitForTimeout(100);
  const separatedVertically = await page.evaluate(() => (
    window.XRRC_DIAGNOSTICS.snapshot().localVehiclePosition
  ));
  expect(Math.hypot(
    separatedVertically.x - parked.position.x,
    separatedVertically.z - parked.position.z
  )).toBeLessThan(0.02);

  await page.evaluate((position) => {
    window.XRRC_DIAGNOSTICS.setLocalVehicleState({
      x: position.x,
      y: 0.045,
      z: position.z,
      velocity: 0,
      verticalVelocity: 0,
    });
  }, parked.position);
  await page.waitForTimeout(100);
  const collidedOnGround = await page.evaluate(() => (
    window.XRRC_DIAGNOSTICS.snapshot().localVehiclePosition
  ));
  expect(Math.hypot(
    collidedOnGround.x - parked.position.x,
    collidedOnGround.z - parked.position.z
  )).toBeGreaterThan(0.02);
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
  expect(Math.abs(recovered.localVehiclePosition.x - initial.startGrid.x)).toBeLessThan(0.05);
  expect(Math.abs(recovered.localVehiclePosition.z - initial.startGrid.z)).toBeLessThan(0.05);
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
  await page.keyboard.up('w');
  const flightSpeed = await page.evaluate(() => (
    window.XRRC_DIAGNOSTICS.snapshot().localVehicleSpeed
  ));
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

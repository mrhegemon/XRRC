'use strict';

const { test, expect } = require('@playwright/test');

const proceduralVehicles = {
  rally: 'Rally car',
  buggy: 'Dune buggy',
  truck: '4x4 truck',
  motorcycle: 'RC motorcycle',
  tank: 'Mini tank',
  plane: 'Prop plane',
  helicopter: 'Helicopter',
};
const glbVehicles = {
  'toy-car-1': 'Racer 1',
  'toy-car-2': 'Racer 2',
  'toy-car-3': 'Racer 3',
  'toy-car-taxi': 'Taxi',
  'toy-car-cop': 'Police',
  car1: 'Coupe',
  car2: 'Rally GT',
};
const allVehicles = { ...proceduralVehicles, ...glbVehicles };
const vehicleRoles = {
  rally: 'All-rounder',
  buggy: 'Loose-surface sprinter',
  truck: 'Stable bruiser',
  motorcycle: 'Precision missile',
  tank: 'Pivot crawler',
  plane: 'High-speed flyer',
  helicopter: 'Hover specialist',
  'toy-car-1': 'Retro rally shell',
  'toy-car-2': 'Club racer shell',
  'toy-car-3': 'Endurance shell',
  'toy-car-taxi': 'City cab shell',
  'toy-car-cop': 'Pursuit shell',
  car1: 'Sport coupe shell',
  car2: 'Rally GT shell',
};
const expectedVehicleParts = {
  rally: { rotors: 0, wheels: 4 },
  buggy: { rotors: 0, wheels: 4 },
  truck: { rotors: 0, wheels: 4 },
  motorcycle: { rotors: 0, wheels: 2 },
  tank: { rotors: 0, wheels: 6 },
  plane: { rotors: 1, wheels: 3 },
  helicopter: { rotors: 2, wheels: 0 },
};

async function waitForRenderedGame(page) {
  await page.waitForFunction(() => (
    window.XRRC_DIAGNOSTICS &&
    window.XRRC_DIAGNOSTICS.snapshot().calls > 0
  ));
}

test('describes every vehicle choice with a handling profile', async ({ page }) => {
  await page.goto('/?signal=off');
  await expect(page.locator('#vehicle-profile')).toBeVisible();

  for (const [vehicle, role] of Object.entries(vehicleRoles)) {
    await page.locator(`.vehicle-toggle:has(input[value="${vehicle}"])`).click();
    await expect(page.locator('#vehicle-role')).toHaveText(role);
    await expect(page.locator('#vehicle-note')).toHaveText(/\S/);
    await expect(page.locator('.rating-meter')).toHaveCount(4);
    const ratings = await page.locator('.rating-meter').evaluateAll((meters) => (
      meters.map((meter) => Number(meter.getAttribute('aria-valuenow')))
    ));
    expect(ratings.every((rating) => rating >= 1 && rating <= 5)).toBe(true);
  }
});

test('renders every procedural vehicle within the scene budget', async ({ page }) => {
  test.slow();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  for (const [vehicle, label] of Object.entries(proceduralVehicles)) {
    await test.step(label, async () => {
      await page.goto(`/?signal=off&mode=desktop&vehicle=${vehicle}`);
      await waitForRenderedGame(page);
      await expect(page.locator('#vehicle-label')).toHaveText(label);
      const diagnostics = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
      expect(diagnostics.localVehicle).toBe(vehicle);
      expect(diagnostics.calls).toBeLessThanOrEqual(90);
      expect(diagnostics.geometries).toBeLessThanOrEqual(90);
      expect(diagnostics.roadNormalY).toBeGreaterThan(0.9);
      expect(diagnostics.triangles).toBeGreaterThan(10_000);
    });
  }

  expect(pageErrors).toEqual([]);
});

test('loads, drives, resets, and recalls all 14 vehicle types', async ({ page }) => {
  // Cycles all 14 vehicles, which pulls roughly 13MB of GLB skins through the
  // loader. That is comfortably the slowest test in the suite and it has to
  // finish on a CI runner doing software rendering.
  test.setTimeout(300_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/?signal=off&mode=desktop&vehicle=rally&rivals=0');
  await waitForRenderedGame(page);
  await expect(page.locator('#countdown')).toHaveText('', { timeout: 6_000 });
  await expect(page.locator('#vehicle-bay .vehicle-slot')).toHaveCount(14);

  for (const [vehicle, label] of Object.entries(allVehicles)) {
    await test.step(label, async () => {
      if (vehicle !== 'rally') {
        await page.locator(`#vehicle-bay .vehicle-slot[aria-label="${label}"]`).click();
      }
      await page.waitForFunction((expectedVehicle) => {
        const diagnostics = window.XRRC_DIAGNOSTICS?.snapshot();
        return (
          diagnostics?.localVehicle === expectedVehicle &&
          diagnostics.localVehicleRender.modelStatus !== 'loading'
        );
      }, vehicle);

      const diagnostics = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
      expect(diagnostics.localVehicle).toBe(vehicle);
      expect(diagnostics.localVehicleRender).toMatchObject({
        category: expect.stringMatching(/^(ground|air)$/),
        modelSource: Object.hasOwn(glbVehicles, vehicle) ? 'glb' : 'procedural',
        modelStatus: 'ready',
      });
      expect(diagnostics.localVehicleRender.bounds.x).toBeGreaterThan(0.04);
      expect(diagnostics.localVehicleRender.bounds.z).toBeGreaterThan(0.04);
      expect(diagnostics.localVehicleRender.meshes).toBeGreaterThan(0);
      expect(diagnostics.localVehicleRender.triangles).toBeGreaterThan(0);
      if (Object.hasOwn(expectedVehicleParts, vehicle)) {
        expect(diagnostics.localVehicleRender).toMatchObject(expectedVehicleParts[vehicle]);
      }

      await page.evaluate(() => {
        window.XRRC_DEMO_INPUT = { throttle: 0.82, steering: 0.08 };
      });
      await expect.poll(
        async () => Number(await page.locator('#speed-value').textContent())
      ).toBeGreaterThan(0);
      await page.evaluate(() => {
        window.XRRC_DEMO_INPUT = null;
      });
      await page.evaluate(() => new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      }));
      await page.locator('#reset-btn').click();
      await expect(page.locator('#speed-value')).toHaveText('00');

      const reset = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
      expect(Math.abs(reset.localVehiclePosition.x - reset.startGrid.x)).toBeLessThan(0.02);
      expect(Math.abs(reset.localVehiclePosition.z - reset.startGrid.z)).toBeLessThan(0.02);
    });
  }

  const completeBay = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  expect(completeBay.worldVehicles).toEqual(Object.keys(allVehicles));

  await page.locator('#vehicle-bay .vehicle-slot[aria-label="Rally car"]').click();
  await expect.poll(async () => (
    page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().worldVehicles)
  )).not.toContain('rally');
  expect(pageErrors).toEqual([]);
});

test('keyboard driving accelerates and reset returns the vehicle to the grid', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&vehicle=rally');
  await waitForRenderedGame(page);
  await expect(page.locator('#countdown')).toHaveText('', { timeout: 6_000 });

  await page.keyboard.down('w');
  await expect.poll(async () => Number(await page.locator('#speed-value').textContent())).toBeGreaterThan(0);
  await page.keyboard.up('w');
  await page.keyboard.press('r');

  await expect(page.locator('#toast')).toHaveText('Vehicle reset to the grid');
  await expect(page.locator('#speed-value')).toHaveText('00');
});

test('Quest quality mode reduces headset GPU cost', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&quality=quest');
  await waitForRenderedGame(page);
  const diagnostics = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());

  expect(diagnostics).toMatchObject({
    antialias: false,
    particles: 96,
    pixelRatio: 1,
    quality: 'quest',
    shadows: false,
  });
  expect(diagnostics.calls).toBeLessThanOrEqual(90);
});

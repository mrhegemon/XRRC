'use strict';

const { test, expect } = require('@playwright/test');

// The Tripo proxy itself is unit-tested in test/tripo.test.js with a fake
// upstream. These tests exercise the browser side of the dream lab - detection,
// reveal, the generate -> poll -> model -> selectable-car pipeline, and the
// inert no-server path - by mocking the four /api/tripo/* endpoints the client
// calls. The model route serves a real bundled GLB so the skin actually loads.
// The dream lab is a lobby feature, so these stay in the lobby (no mode=desktop
// auto-start) until the car has to be driven.

const TASK_ID = 'dreamtask-000000000001';

async function mockTripo(page, { enabled = true } = {}) {
  await page.route('**/api/tripo/status', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ enabled }),
  }));
  await page.route('**/api/tripo/generate', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ tasks: [{ role: 'vehicle', taskId: TASK_ID }] }),
  }));
  await page.route('**/api/tripo/task/*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ status: 'success', progress: 100, imageUrl: '' }),
  }));
  // Serve a real GLB from the app's own assets so the generated skin loads.
  await page.route('**/api/tripo/model/*', (route) => route.fulfill({
    status: 302,
    headers: { location: '/assets/cars/toy-car-1.glb' },
  }));
}

test('reveals the dream lab and adds a generated car to the vehicle bay', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await mockTripo(page, { enabled: true });
  await page.goto('/?signal=off&rivals=0');

  // The async probe unhides the panel once the mocked status reports enabled.
  await expect(page.locator('#dream-lab')).toBeVisible();

  await page.fill('#dream-vehicle-input', 'chunky orange monster truck');
  await page.click('#dream-vehicle-btn');

  // Status reaches the "added" state and a dream-car toggle appears, preselected.
  await expect(page.locator('#dream-vehicle-status')).toHaveAttribute(
    'data-state',
    'done',
    { timeout: 20_000 }
  );
  await expect(page.locator('#dream-vehicle-toggle input')).toBeChecked();

  // Start the race with the preselected dream car and confirm it loads its
  // generated skin and rides the rally physics profile.
  await page.locator('#desktop-btn').click();
  await page.waitForFunction(() => (
    window.XRRC_DIAGNOSTICS?.snapshot().localVehicle === 'dream-car' &&
    window.XRRC_DIAGNOSTICS.snapshot().localVehicleRender.modelStatus === 'ready'
  ), null, { timeout: 20_000 });
  const snapshot = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  expect(snapshot.localVehicleRender.category).toBe('ground'); // rally profile
  expect(snapshot.localVehicleRender.modelSource).toBe('glb');
  expect(pageErrors).toEqual([]);
});

test('stays hidden and inert when no Tripo server is available', async ({ page }) => {
  // The static Pages build has no /api/tripo backend at all.
  await page.route('**/api/tripo/status', (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: '{}',
  }));
  await page.goto('/?signal=off');
  await page.waitForFunction(() => (
    document.getElementById('lobby')?.getAttribute('aria-busy') === 'false'
  ));
  // Give the probe time to resolve, then confirm the panel never reveals and no
  // dream-car entered the (lobby) vehicle rail.
  await page.waitForTimeout(1_000);
  await expect(page.locator('#dream-lab')).toBeHidden();
  await expect(page.locator('.vehicle-rail input[name="vehicle"]')).toHaveCount(14);
  await expect(page.locator('#dream-vehicle-toggle')).toHaveCount(0);
});

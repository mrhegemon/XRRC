'use strict';

const { test, expect } = require('@playwright/test');

async function waitForRace(page) {
  await page.waitForFunction(() => window.XRRC_DIAGNOSTICS?.snapshot().calls > 0);
  await page.waitForFunction(
    () => window.XRRC_DIAGNOSTICS?.snapshot().race.status === 'racing',
    null,
    { timeout: 10_000 }
  );
  await expect(page.locator('#countdown')).toHaveText('');
}

async function completeLap(page) {
  for (const progress of [
    0.21, 0.23, 0.46, 0.48, 0.71, 0.73, 0.8, 0.86, 0.92, 0.98, 0.03,
  ]) {
    await page.evaluate((value) => {
      window.XRRC_DIAGNOSTICS.setCourseProgress(value, { velocity: 0 });
    }, progress);
    await page.waitForTimeout(85);
  }
}

test('starts a configurable three-lap heat with deterministic rivals and standings', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&track=backyard&vehicle=rally');
  await waitForRace(page);

  let snapshot = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  expect(snapshot.totalLaps).toBe(3);
  expect(snapshot.aiRacers).toHaveLength(3);
  expect(snapshot.standings).toHaveLength(4);
  await expect(page.locator('#lap-label')).toHaveText('Lap 1 / 3');
  await expect(page.locator('#position-label')).toHaveText(/P\d \/ 4/);

  await page.waitForTimeout(650);
  snapshot = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  expect(snapshot.aiRacers.some(({ progress }) => progress > 0)).toBe(true);
  expect(snapshot.race.elapsedMs).toBeGreaterThan(500);
});

test('finishes a timed lap, persists its record, renders results, and replays its ghost', async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem('xrrc-race-records-v1'));
  await page.goto('/?signal=off&mode=desktop&track=harbor&vehicle=rally&laps=1&rivals=0');
  await waitForRace(page);
  await completeLap(page);

  await expect(page.locator('#results-dialog')).toBeVisible({ timeout: 3_000 });
  const finished = await page.evaluate(() => ({
    snapshot: window.XRRC_DIAGNOSTICS.snapshot(),
    save: JSON.parse(localStorage.getItem('xrrc-race-records-v1')),
  }));
  expect(finished.snapshot.race.finished).toBe(true);
  expect(finished.snapshot.race.lapTimes).toHaveLength(1);
  expect(finished.save.bestLaps.harbor).toBeGreaterThan(0);
  expect(finished.save.ghosts.harbor.samples.length).toBeGreaterThan(2);
  await expect(page.locator('#results-laps tr')).toHaveCount(1);

  await page.locator('#results-retry-btn').click();
  await waitForRace(page);
  await expect.poll(async () => (
    page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().ghostVisible)
  )).toBe(true);
});

test('pause freezes race time and exposes steering assist and retry controls', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&rivals=0');
  await waitForRace(page);
  await page.locator('#pause-btn').click();
  await expect(page.locator('#pause-dialog')).toBeVisible();
  const pausedAt = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().race.elapsedMs);
  await page.waitForTimeout(450);
  const stillPaused = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  expect(stillPaused.paused).toBe(true);
  expect(Math.abs(stillPaused.race.elapsedMs - pausedAt)).toBeLessThan(2);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().paused)).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  await page.locator('#pause-assist').click();
  expect(await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().assistEnabled)).toBe(false);
  await page.locator('#resume-btn').click();
  await page.waitForTimeout(220);
  expect(await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().race.elapsedMs))
    .toBeGreaterThan(pausedAt + 100);

  await page.keyboard.press('Escape');
  await expect(page.locator('#pause-dialog')).toBeVisible();
  await page.locator('#retry-btn').click();
  await expect(page.locator('#countdown')).not.toHaveText('', { timeout: 1_000 });
  await waitForRace(page);
  expect(await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().race.completedLaps)).toBe(0);
});

test('charges drift energy and releases a multi-channel boost', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&rivals=0&assist=off');
  await waitForRace(page);
  await page.evaluate(() => {
    window.XRRC_DEMO_INPUT = { throttle: 1, steering: 0.8 };
    window.__pinDrift = window.setInterval(() => {
      window.XRRC_DIAGNOSTICS.setCourseProgress(0.12, { velocity: 1.45 });
    }, 30);
  });
  await expect.poll(async () => (
    page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().boostCharge)
  )).toBeGreaterThan(0.2);
  await page.evaluate(() => {
    window.clearInterval(window.__pinDrift);
    window.XRRC_DEMO_INPUT = { throttle: 1, steering: 0 };
  });
  await expect.poll(async () => page.evaluate(() => ({
    active: window.XRRC_DIAGNOSTICS.snapshot().boostActive,
    meter: document.getElementById('boost-meter').dataset.active === 'true',
  }))).toEqual({ active: true, meter: true });
  await page.evaluate(() => {
    window.XRRC_DEMO_INPUT = null;
  });
});

test('accepts five-lap, five-rival, and no-assist setup from the URL', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&laps=5&rivals=5&assist=off');
  await waitForRace(page);
  const snapshot = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  expect(snapshot.totalLaps).toBe(5);
  expect(snapshot.aiRacers).toHaveLength(5);
  expect(snapshot.assistEnabled).toBe(false);
  await expect(page.locator('#lap-label')).toHaveText('Lap 1 / 5');
});

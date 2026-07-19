'use strict';

const { test, expect, devices } = require('@playwright/test');
const pixel7 = devices['Pixel 7'];

const tracks = {
  backyard: 'Backyard Rally',
  alpine: 'Alpine Pass',
  desert: 'Desert Run',
  harbor: 'Neon Harbor',
  sakura: 'Sakura Sprint',
  lunar: 'Lunar Circuit',
};

async function waitForRenderedGame(page) {
  await page.waitForFunction(() => (
    window.XRRC_DIAGNOSTICS &&
    window.XRRC_DIAGNOSTICS.snapshot().calls > 0
  ));
}

test('course passport selects all six localized tracks and updates the URL', async ({ page }) => {
  await page.goto('/?signal=off&track=sakura');

  await expect(page.locator('input[name="track"]')).toHaveCount(6);
  await expect(page.locator('input[name="track"][value="sakura"]')).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-track', 'sakura');
  await expect(page.locator('#garage-caption strong')).toHaveText('Sakura Sprint');

  await page.locator('[data-track-card="lunar"]').click();
  await expect(page.locator('input[name="track"][value="lunar"]')).toBeChecked();
  await expect(page.locator('html')).toHaveAttribute('data-track', 'lunar');
  await expect(page).toHaveURL(/track=lunar/);

  await page.locator('#language-select').selectOption('fr');
  await expect(page.locator('[data-track-card="lunar"] strong')).toHaveText('Circuit lunaire');
  await expect(page.locator('#garage-caption strong')).toHaveText('Circuit lunaire');
});

test('renders six larger themed circuits with four jumps and an aligned loop', async ({ page }) => {
  test.slow();
  const pageErrors = [];
  const renderedThemes = new Set();
  page.on('pageerror', (error) => pageErrors.push(error.message));

  for (const [track, label] of Object.entries(tracks)) {
    await test.step(label, async () => {
      await page.goto(`/?signal=off&mode=desktop&track=${track}`);
      await waitForRenderedGame(page);
      const diagnostics = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());

      expect(diagnostics.track).toBe(track);
      expect(diagnostics.courseScale).toBeGreaterThan(1.4);
      expect(diagnostics.trackBounds.x).toBeGreaterThan(5.8);
      expect(diagnostics.trackBounds.z).toBeGreaterThan(4.4);
      expect(diagnostics.trackLength).toBeGreaterThan(22);
      expect(diagnostics.jumpCount).toBe(4);
      expect(diagnostics.loopRotationY).toBeCloseTo(0, 5);
      expect(diagnostics.surface.type).toBe('road');
      expect(diagnostics.surface.roadDistance).toBeLessThan(0.08);
      expect(diagnostics.localVehiclePosition.x).toBeCloseTo(diagnostics.startGrid.x, 5);
      expect(diagnostics.localVehiclePosition.z).toBeCloseTo(diagnostics.startGrid.z, 5);
      expect(diagnostics.staticColliderCount).toBeGreaterThanOrEqual(25);
      expect(diagnostics.roadNormalY).toBeGreaterThan(0.9);
      expect(diagnostics.calls).toBeLessThanOrEqual(100);
      expect(diagnostics.geometries).toBeLessThanOrEqual(110);
      expect(diagnostics.triangles).toBeGreaterThan(10_000);
      renderedThemes.add(diagnostics.trackTheme);
    });
  }

  expect(renderedThemes.size).toBe(Object.keys(tracks).length);
  expect(pageErrors).toEqual([]);
});

test.describe('mobile course loading', () => {
  test.use({
    deviceScaleFactor: 1,
    hasTouch: pixel7.hasTouch,
    isMobile: pixel7.isMobile,
    screen: pixel7.screen,
    userAgent: pixel7.userAgent,
    viewport: pixel7.viewport,
  });

  test('keeps the expanded setup scrollable without horizontal clipping', async ({ page }) => {
    await page.goto('/?signal=off');

    const layout = await page.locator('#lobby').evaluate((lobby) => ({
      clientHeight: lobby.clientHeight,
      clientWidth: lobby.clientWidth,
      scrollHeight: lobby.scrollHeight,
      scrollWidth: lobby.scrollWidth,
    }));
    expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);

    await page.locator('#desktop-btn').scrollIntoViewIfNeeded();
    const viewport = page.viewportSize();
    const button = await page.locator('#desktop-btn').boundingBox();
    expect(button.y).toBeGreaterThanOrEqual(0);
    expect(button.y + button.height).toBeLessThanOrEqual(viewport.height);
  });
});

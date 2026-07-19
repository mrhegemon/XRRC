'use strict';

const { test, expect, devices } = require('@playwright/test');

test.use({ ...devices['Pixel 7'] });

test('localizes the complete setup and persists language changes', async ({ page }) => {
  await page.goto('/?signal=off&lang=es');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(page.locator('#setup-title')).toHaveText('Prepara la carrera');
  await expect(page.locator('input[value="helicopter"] + .vehicle-glyph + strong'))
    .toHaveText('Helicoptero');
  await expect(page.locator('#signal-panel .status-dot')).toHaveCount(1);
  await page.locator('.vehicle-toggle:has(input[value="motorcycle"])').click();
  await expect(page.locator('#vehicle-role')).toHaveText('Misil de precision');
  await expect(page.locator('#vehicle-rating-handling')).toHaveAttribute('aria-valuenow', '5');
  await expect(page.locator('#vehicle-rating-stability')).toHaveAttribute('aria-valuenow', '2');

  await page.locator('#language-select').selectOption('fr');
  await expect(page.locator('#setup-title')).toHaveText('Preparez la course');
  await expect(page.locator('#vehicle-role')).toHaveText('Missile de precision');
  await page.goto('/?signal=off');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page.locator('#desktop-btn span')).toHaveText('Course sur ordinateur');
});

test('mobile touch steering remains reachable and drives the vehicle', async ({ page }) => {
  await page.goto('/?signal=off&mode=desktop&controls=touch');
  await page.waitForFunction(() => window.XRRC_DIAGNOSTICS?.snapshot().calls > 0);
  await expect(page.locator('#countdown')).toHaveText('', { timeout: 6_000 });
  await expect(page.locator('#joystick-zone')).toBeVisible();
  await expect(page.locator('#joystick')).toHaveAttribute('role', 'group');
  await expect(page.locator('#joystick')).toHaveAttribute('tabindex', '0');
  await expect(page.locator('[data-touch-axis]')).toHaveCount(6);
  await expect(page.locator('#controller-status')).toHaveText('Touch controls active');

  const viewport = page.viewportSize();
  const joystick = await page.locator('#joystick').boundingBox();
  expect(joystick.x).toBeGreaterThanOrEqual(0);
  expect(joystick.y).toBeGreaterThanOrEqual(0);
  expect(joystick.x + joystick.width).toBeLessThanOrEqual(viewport.width);
  expect(joystick.y + joystick.height).toBeLessThanOrEqual(viewport.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    viewport.width
  );

  const session = await page.context().newCDPSession(page);
  const center = {
    x: joystick.x + joystick.width / 2,
    y: joystick.y + joystick.height / 2,
  };
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ ...center, radiusX: 8, radiusY: 8 }],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{
      x: center.x + joystick.width * 0.2,
      y: center.y - joystick.height * 0.28,
      radiusX: 8,
      radiusY: 8,
    }],
  });
  await expect.poll(async () => Number(await page.locator('#speed-value').textContent())).toBeGreaterThan(0);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  });

  await page.locator('#reset-btn').click();
  const forward = page.locator('[data-touch-axis="throttle"][data-touch-value="1"]');
  await forward.focus();
  await page.keyboard.down('Enter');
  await expect.poll(async () => Number(await page.locator('#speed-value').textContent())).toBeGreaterThan(0);
  await page.keyboard.up('Enter');

  await page.locator('#reset-btn').click();
  await page.evaluate(() => {
    document.querySelector('[data-touch-axis="throttle"][data-touch-value="1"]').click();
  });
  await expect.poll(async () => Number(await page.locator('#speed-value').textContent())).toBeGreaterThan(0);
});

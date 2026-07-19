'use strict';

const { test, expect, devices } = require('@playwright/test');

const QR_CODE_SOURCE = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm';
const pixel7 = devices['Pixel 7'];

async function installShareMocks(page) {
  await page.route(QR_CODE_SOURCE, (route) => route.fulfill({
    contentType: 'application/javascript',
    body: `
      export default {
        async toCanvas(canvas, text) {
          const context = canvas.getContext('2d');
          context.fillStyle = '#f4ead2';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.fillStyle = '#24251f';
          context.fillRect(16, 16, 72, 72);
          context.fillRect(152, 16, 72, 72);
          context.fillRect(16, 152, 72, 72);
          canvas.dataset.encodedByTest = text;
        }
      };
    `,
  }));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText(value) {
          window.__COPIED_INVITE__ = value;
        },
      },
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data) => {
        window.__NATIVE_SHARE__ = data;
      },
    });
  });
}

async function openShareDialog(page, language = 'en') {
  await installShareMocks(page);
  await page.goto(`/?signal=off&mode=desktop&room=Pit%20Crew&track=alpine&lang=${language}`);
  await page.waitForFunction(() => window.XRRC_DIAGNOSTICS?.snapshot().calls > 0);
  await page.locator('#share-link').click();
  await expect(page.locator('#share-dialog')).toBeVisible();
}

test('renders a QR room pass with direct and native share actions', async ({ page }) => {
  await openShareDialog(page);

  await expect(page.locator('#share-title')).toHaveText('Call in your pit crew');
  await expect(page.locator('#share-room-code')).toHaveText('#PIT-CREW');
  await expect(page.locator('#share-qr-card')).toHaveAttribute('data-state', 'ready');

  const invite = await page.locator('#share-url').inputValue();
  const inviteUrl = new URL(invite);
  expect(inviteUrl.searchParams.get('room')).toBe('pit-crew');
  expect(inviteUrl.searchParams.get('track')).toBe('alpine');
  expect(inviteUrl.searchParams.has('signal')).toBe(false);
  await expect(page.locator('#share-qr')).toHaveAttribute('data-encoded-by-test', invite);

  const expectedMessage = `Join my XRRC race on Alpine Pass.\n\n${invite}`;
  const email = new URL(await page.locator('#share-email').getAttribute('href'));
  const sms = new URL(await page.locator('#share-sms').getAttribute('href'));
  const whatsapp = new URL(await page.locator('#share-whatsapp').getAttribute('href'));
  expect(email.searchParams.get('subject')).toBe('XRRC room #pit-crew');
  expect(email.searchParams.get('body')).toBe(expectedMessage);
  expect(sms.searchParams.get('body')).toBe(expectedMessage);
  expect(whatsapp.searchParams.get('text')).toBe(expectedMessage);

  await page.locator('#share-copy').click();
  await expect(page.locator('#share-copy')).toHaveText('Copied');
  expect(await page.evaluate(() => window.__COPIED_INVITE__)).toBe(invite);

  await page.locator('#share-native').click();
  expect(await page.evaluate(() => window.__NATIVE_SHARE__)).toEqual({
    text: 'Join my XRRC race on Alpine Pass.',
    title: 'XRRC room #pit-crew',
    url: invite,
  });

  await page.locator('#share-close').click();
  await expect(page.locator('#share-dialog')).not.toBeVisible();
});

test.describe('mobile room pass', () => {
  test.use({
    deviceScaleFactor: 1,
    hasTouch: pixel7.hasTouch,
    isMobile: pixel7.isMobile,
    screen: pixel7.screen,
    userAgent: pixel7.userAgent,
    viewport: pixel7.viewport,
  });

  test('fits the viewport, localizes its actions, and closes with Escape', async ({ page }) => {
    await openShareDialog(page, 'es');

    await expect(page.locator('#share-title')).toHaveText('Llama a tu equipo');
    await expect(page.locator('#share-copy')).toHaveText('Copiar enlace');
    await expect(page.locator('#share-close')).toHaveText('Cerrar');

    const viewport = page.viewportSize();
    const sheet = await page.locator('.share-sheet').boundingBox();
    expect(sheet.x).toBeGreaterThanOrEqual(0);
    expect(sheet.y).toBeGreaterThanOrEqual(0);
    expect(sheet.x + sheet.width).toBeLessThanOrEqual(viewport.width);
    expect(sheet.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBeLessThanOrEqual(viewport.width);

    await page.keyboard.press('Escape');
    await expect(page.locator('#share-dialog')).not.toBeVisible();
  });
});

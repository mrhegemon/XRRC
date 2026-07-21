'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { mkdir } = require('node:fs/promises');
const { chromium, devices } = require('@playwright/test');

const port = 4174;
const baseUrl = `http://127.0.0.1:${port}`;
const outputDir = path.join(__dirname, '..', 'docs', 'screenshots');
const tracks = ['backyard', 'alpine', 'desert', 'harbor', 'sakura', 'lunar'];
const vehicles = [
  'rally',
  'buggy',
  'truck',
  'motorcycle',
  'tank',
  'plane',
  'helicopter',
  'toy-car-1',
  'toy-car-2',
  'toy-car-3',
  'toy-car-taxi',
  'toy-car-cop',
  'car1',
  'car2',
];

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The child server may still be binding its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Screenshot server did not become ready.');
}

async function settle(page, race = false) {
  await page.evaluate(() => document.fonts.ready);
  if (race) {
    await page.waitForFunction(() => window.XRRC_DIAGNOSTICS?.snapshot().calls > 0);
    await page.waitForFunction(() => (
      window.XRRC_DIAGNOSTICS?.snapshot().localVehicleRender.modelStatus === 'ready'
    ));
    await page.waitForFunction(() => document.getElementById('countdown')?.textContent.trim());
    await page.waitForFunction(() => !document.getElementById('countdown')?.textContent.trim());
    await page.waitForTimeout(500);
  } else {
    await page.waitForTimeout(300);
  }
}

async function capture(context, name, url, options = {}) {
  const page = await context.newPage();
  await page.goto(`${baseUrl}${url}`);
  if (options.openRelay) {
    await page.locator('#signal-panel summary').click();
  }
  await settle(page, options.race);
  if (options.scrollTo) {
    await page.locator(options.scrollTo).scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
  }
  await page.screenshot({
    animations: 'disabled',
    fullPage: Boolean(options.fullPage),
    path: path.join(outputDir, name),
  });
  await page.close();
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: 'ignore',
  });

  try {
    await waitForServer();
    const browser = await chromium.launch({
      args: ['--enable-webgl', '--ignore-gpu-blocklist'],
    });
    try {
      const desktop = await browser.newContext({
        deviceScaleFactor: 1,
        viewport: { width: 1440, height: 900 },
      });
      await capture(desktop, 'lobby-desktop.png', '/?signal=off');
      await capture(desktop, 'lobby-spanish.png', '/?signal=off&lang=es');
      await capture(desktop, 'multiplayer-setup.png', '/?signal=https%3A%2F%2Fquest.tailnet.ts.net', {
        openRelay: true,
      });
      await capture(
        desktop,
        'race-desktop.png',
        '/?signal=off&mode=desktop&vehicle=rally&demo=drive',
        { race: true }
      );
      // Circuit showcases use the overview camera so the whole lap is in frame;
      // the chase camera only holds part of a course at the current scale.
      for (const track of tracks) {
        await capture(
          desktop,
          `track-${track}.png`,
          `/?signal=off&mode=desktop&track=${track}&vehicle=rally&view=overview`,
          { race: true }
        );
      }
      for (const vehicle of vehicles) {
        await capture(
          desktop,
          `race-${vehicle}.png`,
          `/?signal=off&mode=desktop&vehicle=${vehicle}`,
          { race: true }
        );
      }

      const room = `screenshots-${Date.now()}`;
      const signal = encodeURIComponent(baseUrl);
      const tank = await desktop.newPage();
      const helicopter = await desktop.newPage();
      await Promise.all([
        tank.goto(`${baseUrl}/?mode=desktop&room=${room}&vehicle=tank&signal=${signal}`),
        helicopter.goto(
          `${baseUrl}/?mode=desktop&room=${room}&vehicle=helicopter&signal=${signal}`
        ),
      ]);
      await Promise.all([
        tank.locator('#peer-count').waitFor({ state: 'visible' }),
        helicopter.locator('#peer-count').waitFor({ state: 'visible' }),
      ]);
      await Promise.all([
        tank.waitForFunction(() => document.getElementById('peer-count').textContent === '2'),
        helicopter.waitForFunction(() => document.getElementById('peer-count').textContent === '2'),
      ]);
      await tank.waitForTimeout(700);
      await tank.screenshot({
        animations: 'disabled',
        path: path.join(outputDir, 'multiplayer-tank.png'),
      });
      await helicopter.screenshot({
        animations: 'disabled',
        path: path.join(outputDir, 'multiplayer-helicopter.png'),
      });
      await desktop.close();

      const mobile = await browser.newContext({
        ...devices['Pixel 7'],
        deviceScaleFactor: 1,
      });
      await capture(mobile, 'lobby-mobile.png', '/?signal=off');
      await capture(mobile, 'lobby-mobile-setup.png', '/?signal=off&vehicle=motorcycle', {
        scrollTo: '#desktop-btn',
      });
      await capture(
        mobile,
        'race-mobile.png',
        '/?signal=off&mode=desktop&vehicle=buggy&controls=touch',
        { race: true }
      );
      await mobile.close();
    } finally {
      await browser.close();
    }
  } finally {
    server.kill('SIGTERM');
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

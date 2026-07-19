'use strict';

// Dev-only helper: capture a few in-race frames so course layout and camera
// framing can be reviewed without running the full screenshot pipeline.
const path = require('node:path');
const { spawn } = require('node:child_process');
const { mkdir } = require('node:fs/promises');
const { chromium } = require('@playwright/test');

const port = 4188;
const baseUrl = `http://127.0.0.1:${port}`;
const outputDir = process.env.PREVIEW_OUT
  || path.join(__dirname, '..', '.preview');
const tracks = (process.env.PREVIEW_TRACKS || 'backyard,alpine,desert,harbor,sakura,lunar')
  .split(',')
  .filter(Boolean);

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The child server may still be binding its socket.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Preview server did not become ready.');
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
      const context = await browser.newContext({
        deviceScaleFactor: 1,
        viewport: { width: 1440, height: 900 },
      });
      for (const track of tracks) {
        const page = await context.newPage();
        await page.goto(
          `${baseUrl}/?signal=off&mode=desktop&track=${track}&vehicle=rally&rivals=3&demo=drive&view=overview`
        );
        await page.waitForFunction(() => window.XRRC_DIAGNOSTICS?.snapshot().calls > 0);
        await page.waitForFunction(() => (
          window.XRRC_DIAGNOSTICS?.snapshot().localVehicleRender.modelStatus === 'ready'
        ));
        await page.waitForFunction(() => document.getElementById('countdown')?.textContent.trim());
        await page.waitForFunction(() => !document.getElementById('countdown')?.textContent.trim());
        await page.waitForTimeout(1400);
        const snap = await page.evaluate(() => {
          const s = window.XRRC_DIAGNOSTICS.snapshot();
          return {
            track: s.track,
            len: Number(s.trackLength.toFixed(2)),
            speed: Number(s.localVehicleSpeed.toFixed(3)),
            calls: s.calls,
            geometries: s.geometries,
            triangles: s.triangles,
            surface: s.surface.type,
          };
        });
        console.log(JSON.stringify(snap));
        await page.screenshot({
          animations: 'disabled',
          path: path.join(outputDir, `preview-${track}.png`),
        });
        await page.close();
      }
      await context.close();
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

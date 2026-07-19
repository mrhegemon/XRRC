'use strict';

const { test, expect, devices } = require('@playwright/test');

test('enables WebXR when immersive AR is supported', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'xr', {
      configurable: true,
      value: {
        isSessionSupported: async (mode) => mode === 'immersive-ar',
      },
    });
  });
  await page.goto('/?signal=off');

  await expect(page.locator('#webxr-btn')).toBeEnabled();
  await expect(page.locator('#webxr-btn span')).toHaveText('Start WebXR');
  await expect(page.locator('#lobby-status')).toContainText('WebXR is ready');
});

test('starts the complete 8th Wall pipeline with camera runtime modules', async ({ page }) => {
  await page.route('https://cdn.jsdelivr.net/npm/@8thwall/**', (route) => (
    route.fulfill({ contentType: 'application/javascript', body: '// test stub' })
  ));
  await page.addInitScript(() => {
    const pipeline = (name) => ({ name });
    window.LandingPage = { pipelineModule: () => pipeline('landing-page') };
    window.XRExtras = {
      FullWindowCanvas: { pipelineModule: () => pipeline('full-window-canvas') },
      Loading: { pipelineModule: () => pipeline('loading') },
      RuntimeError: { pipelineModule: () => pipeline('runtime-error') },
    };
    window.XR8 = {
      GlTextureRenderer: { pipelineModule: () => pipeline('gl-texture-renderer') },
      Threejs: {
        pipelineModule: () => pipeline('threejs'),
        xrScene: () => window.__XR8_RUNTIME__,
      },
      XrController: { pipelineModule: () => pipeline('xr-controller') },
      addCameraPipelineModules(modules) {
        window.__XR8_MODULES__ = modules;
      },
      run({ canvas }) {
        const scene = new window.THREE.Scene();
        const camera = new window.THREE.PerspectiveCamera(48, 1, 0.01, 100);
        const renderer = new window.THREE.WebGLRenderer({ canvas, alpha: true });
        renderer.setSize(innerWidth, innerHeight);
        window.__XR8_RUNTIME__ = { camera, renderer, scene };
        const customModule = window.__XR8_MODULES__.find((module) => module.name === 'xrrc');
        customModule.onStart();
        customModule.onUpdate();
        renderer.render(scene, camera);
        window.__XR8_RUN__ = true;
      },
      stop() {
        window.__XR8_STOP_COUNT__ = (window.__XR8_STOP_COUNT__ || 0) + 1;
      },
    };
  });

  await page.goto('/?signal=off&vehicle=toy-car-1');
  const cameraButton = page.locator('#eighthwall-btn');
  await expect(cameraButton).toBeEnabled();
  await cameraButton.click();
  await page.waitForFunction(() => window.__XR8_RUN__ === true);

  await expect(page.locator('#hud')).toBeVisible();
  await page.waitForFunction(() => (
    window.XRRC_DIAGNOSTICS?.snapshot().localVehicleRender.modelStatus === 'ready'
  ));
  const diagnostics = await page.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot());
  // A placed AR course has to stay room-sized however large the circuits get
  // on screen, so the XR root scales inversely to COURSE_SCALE. It is their
  // product that must stay fixed - asserting xrScale alone would pass a change
  // that quietly doubled the physical footprint.
  expect(diagnostics.xrScale * diagnostics.courseScale).toBeCloseTo(0.568, 5);
  expect(diagnostics.localVehicleRender.bounds.x).toBeGreaterThan(0.09);
  expect(diagnostics.localVehicleRender.bounds.z).toBeGreaterThan(0.18);
  expect(await page.evaluate(() => window.__XR8_MODULES__.map((module) => module.name)))
    .toEqual([
      'gl-texture-renderer',
      'threejs',
      'xr-controller',
      'landing-page',
      'full-window-canvas',
      'loading',
      'runtime-error',
      'xrrc',
    ]);

  await page.waitForFunction(() => (
    window.XRRC_DIAGNOSTICS?.snapshot().race.status === 'racing'
  ));
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('game-pause')));
  await page.locator('#quit-btn').click();

  await expect(page.locator('#lobby')).toBeVisible();
  await expect(cameraButton).toBeEnabled();
  expect(await page.evaluate(() => window.__XR8_STOP_COUNT__)).toBe(1);
});

// The stubbed pipeline test above replaces the engine wholesale, so it proves
// our wiring but would still pass if the pinned CDN build vanished or changed
// API - which is precisely how camera AR breaks in production without anything
// in the repo changing. These two load the real binary.

test.describe('real 8th Wall engine', () => {
  test.slow();

  test('loads on iOS and reports the device as camera-capable', async ({ browser }) => {
    const context = await browser.newContext({ ...devices['iPhone 14'] });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto('/?signal=off');

    // iOS Safari has no WebXR, so camera mode is the only AR route there.
    await expect(page.locator('#webxr-btn')).toBeDisabled();
    await expect(page.locator('#eighthwall-btn')).toBeEnabled();
    await page.locator('#eighthwall-btn').click();

    await page.waitForFunction(
      () => typeof window.XR8 === 'object' && window.XR8.isInitialized?.() === true,
      null,
      { timeout: 40_000 }
    );
    const engine = await page.evaluate(() => ({
      os: window.XR8.XrDevice.deviceEstimate().os,
      compatible: window.XR8.XrDevice.isDeviceBrowserCompatible(),
      reasons: window.XR8.XrDevice.incompatibleReasons(),
      threejs: typeof window.XR8.Threejs?.pipelineModule,
      controller: typeof window.XR8.XrController?.pipelineModule,
      textureRenderer: typeof window.XR8.GlTextureRenderer?.pipelineModule,
      extras: typeof window.XRExtras?.FullWindowCanvas?.pipelineModule,
      landing: typeof window.LandingPage?.pipelineModule,
    }));

    expect(engine.os).toBe('iOS');
    expect(engine.compatible).toBe(true);
    expect(engine.reasons).toEqual([]);
    // Every module createEighthWallModules() reaches for must still exist.
    expect(engine.threejs).toBe('function');
    expect(engine.controller).toBe('function');
    expect(engine.textureRenderer).toBe('function');
    expect(engine.extras).toBe('function');
    expect(engine.landing).toBe('function');
    expect(pageErrors).toEqual([]);
    await context.close();
  });

  test('explains that camera mode needs a phone instead of stalling on desktop', async ({ page }) => {
    await page.goto('/?signal=off');
    await page.locator('#eighthwall-btn').click();
    // Previously await XR8.run() never settled here, so the lobby sat on
    // "Loading camera mode..." with the button disabled and no way back.
    await expect(page.locator('#lobby-status')).toContainText('phone', {
      timeout: 40_000,
    });
    await expect(page.locator('#eighthwall-btn')).toBeEnabled();
  });
});

'use strict';

const { test, expect } = require('@playwright/test');

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
  expect(diagnostics.xrScale).toBeCloseTo(0.4, 5);
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

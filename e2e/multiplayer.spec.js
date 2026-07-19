'use strict';

const { test, expect } = require('@playwright/test');

test('announces a peer when its data channel is already open', async ({ page }) => {
  await page.goto('/?signal=off');

  const result = await page.evaluate(() => {
    const manager = new window.NetworkManager();
    manager._createPeerRecord('fast-peer');
    let joined = null;
    manager.addEventListener('peer-join', ({ detail }) => {
      joined = detail;
    });
    const channel = { readyState: 'open' };
    manager._setupDataChannel(channel, 'fast-peer');
    return {
      announced: manager._peers.get('fast-peer').announced,
      joined,
    };
  });

  expect(result).toMatchObject({
    announced: true,
    joined: { id: 'fast-peer' },
  });
  expect(result.joined.color).toMatch(/^#[\da-f]{6}$/i);
});

test('sends race milestones over the ordered companion channel', async ({ page }) => {
  await page.goto('/?signal=off');
  const result = await page.evaluate(() => {
    const manager = new window.NetworkManager();
    const record = manager._createPeerRecord('race-peer');
    const sent = [];
    record.raceDc = {
      readyState: 'open',
      send(data) {
        sent.push(JSON.parse(data));
      },
    };
    manager.broadcastRace({ completedLaps: 1, progress: 0.25 });
    let received = null;
    manager.addEventListener('peer-race', ({ detail }) => {
      received = detail;
    });
    const incoming = {};
    manager._setupRaceChannel(incoming, 'race-peer');
    incoming.onmessage({
      data: JSON.stringify({ race: { completedLaps: 2, progress: 0.5 } }),
    });
    return { received, sent };
  });
  expect(result.sent).toEqual([{ race: { completedLaps: 1, progress: 0.25 } }]);
  expect(result.received).toEqual({
    id: 'race-peer',
    race: { completedLaps: 2, progress: 0.5 },
  });
});

test('three browsers share host rules and migrate room authority', async ({ browser, baseURL }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext();
  const tankPage = await context.newPage();
  const helicopterPage = await context.newPage();
  const buggyPage = await context.newPage();
  const room = `playwright-${Date.now()}`;
  const signal = encodeURIComponent(baseURL);

  await tankPage.goto(`/?mode=desktop&room=${room}&vehicle=tank&laps=5&signal=${signal}`);
  await tankPage.waitForFunction(() => window.XRRC_DIAGNOSTICS?.snapshot().calls > 0);
  await tankPage.waitForTimeout(250);
  await helicopterPage.goto(`/?mode=desktop&room=${room}&vehicle=helicopter&signal=${signal}`);
  await helicopterPage.waitForFunction(() => window.XRRC_DIAGNOSTICS?.snapshot().calls > 0);
  await Promise.all([
    expect(tankPage.locator('#peer-count')).toHaveText('2', { timeout: 15_000 }),
    expect(helicopterPage.locator('#peer-count')).toHaveText('2', { timeout: 15_000 }),
  ]);
  await expect.poll(async () => (
    tankPage.evaluate(() => window.XRRC_DIAGNOSTICS?.snapshot().remoteVehicles)
  )).toContain('helicopter');
  await expect.poll(async () => (
    helicopterPage.evaluate(() => window.XRRC_DIAGNOSTICS?.snapshot().remoteVehicles)
  )).toContain('tank');
  await expect.poll(async () => (
    helicopterPage.evaluate(() => window.XRRC_DIAGNOSTICS?.snapshot().totalLaps)
  )).toBe(5);

  await buggyPage.goto(`/?mode=desktop&room=${room}&vehicle=buggy&laps=1&signal=${signal}`);
  await buggyPage.waitForFunction(() => window.XRRC_DIAGNOSTICS?.snapshot().calls > 0);
  await Promise.all([
    expect(tankPage.locator('#peer-count')).toHaveText('3', { timeout: 15_000 }),
    expect(helicopterPage.locator('#peer-count')).toHaveText('3', { timeout: 15_000 }),
    expect(buggyPage.locator('#peer-count')).toHaveText('3', { timeout: 15_000 }),
  ]);
  await expect.poll(async () => (
    buggyPage.evaluate(() => window.XRRC_DIAGNOSTICS?.snapshot().totalLaps)
  )).toBe(5);

  const hostNetwork = await tankPage.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().network);
  expect(hostNetwork.isHost).toBe(true);
  await tankPage.close();
  await Promise.all([
    expect(helicopterPage.locator('#peer-count')).toHaveText('2', { timeout: 15_000 }),
    expect(buggyPage.locator('#peer-count')).toHaveText('2', { timeout: 15_000 }),
  ]);
  await expect.poll(async () => (
    helicopterPage.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().network.isHost)
  )).toBe(true);
  const migratedHost = await helicopterPage.evaluate(
    () => window.XRRC_DIAGNOSTICS.snapshot().network.localId
  );
  await expect.poll(async () => (
    buggyPage.evaluate(() => window.XRRC_DIAGNOSTICS.snapshot().network.hostId)
  )).toBe(migratedHost);

  await context.close();
});

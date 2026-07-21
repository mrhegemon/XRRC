'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const TripoCore = require('../public/js/tripo-core');
const { createXrrcServer } = require('../server');

// -- Pure helpers ----------------------------------------------------------

test('composes guard-railed prompts from user text', () => {
  const vehicle = TripoCore.composeVehiclePrompt('  a banana\tspeedster ');
  assert.match(vehicle, /^A banana speedster as a miniature toy RC vehicle/);
  assert.match(vehicle, /low-poly cartoon style/);
  assert.equal(TripoCore.composeVehiclePrompt('   '), '');

  const props = TripoCore.composePropPrompts('haunted swamp');
  assert.deepEqual(props.map(({ role }) => role), ['landmark', 'decor', 'marker']);
  for (const { prompt } of props) {
    assert.match(prompt, /haunted swamp/);
    assert.match(prompt, /miniature toy RC racing diorama/);
  }
  assert.deepEqual(TripoCore.composePropPrompts(''), []);
});

test('builds text-to-model payloads per kind', () => {
  const vehicle = TripoCore.taskPayload('prompt', 'vehicle');
  assert.equal(vehicle.model, TripoCore.MODEL_VERSION);
  assert.equal(vehicle.face_limit, 15000);
  assert.equal(vehicle.pbr, true);
  assert.equal(TripoCore.taskPayload('prompt', 'prop').face_limit, 8000);
});

test('validates task ids and normalizes task snapshots', () => {
  assert.equal(TripoCore.isTaskId('task_abc123'), true);
  assert.equal(TripoCore.isTaskId('07764597-9c93-4eb9-92b6-4ea96a8c7d1a'), true);
  assert.equal(TripoCore.isTaskId('task_'), false);
  assert.equal(TripoCore.isTaskId('../etc/passwd'), false);

  const running = TripoCore.normalizeTask({ status: 'running', progress: 250.7 });
  assert.deepEqual(running, { status: 'running', progress: 100, imageUrl: '', modelUrl: '' });
  const success = TripoCore.normalizeTask({
    status: 'success',
    progress: 3,
    output: { model_url: 'https://cdn/model.glb', rendered_image_url: 'https://cdn/img.png' },
  });
  assert.equal(success.progress, 100);
  assert.equal(success.modelUrl, 'https://cdn/model.glb');
  assert.equal(TripoCore.normalizeTask(null).status, 'failed');
  assert.equal(TripoCore.normalizeTask({ status: 'garbage' }).status, 'failed');
});

test('derives short labels from prompts', () => {
  assert.match(TripoCore.shortLabel('a banana speedster with fins'), /^Banana speedster/);
});

// -- Server proxy ----------------------------------------------------------

const GLB_BYTES = Buffer.from('glTF-binary-payload');

function jsonResponse(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
    arrayBuffer: async () => {
      throw new Error('not a binary response');
    },
  };
}

const tripoCalls = [];

async function fakeTripoFetch(url, init = {}) {
  tripoCalls.push({ url, init });
  if (url.endsWith('/generation/text-to-model')) {
    assert.equal(init.headers.Authorization, 'Bearer test-key');
    const payload = JSON.parse(init.body);
    const suffix = payload.face_limit === 15000 ? 'vehicle' : 'prop';
    return jsonResponse({ code: 0, data: { task_id: `task_${suffix}${tripoCalls.length}` } });
  }
  if (url.includes('/tasks/task_ready')) {
    return jsonResponse({
      code: 0,
      data: {
        status: 'success',
        progress: 100,
        output: { model_url: 'https://cdn.example/model.glb', rendered_image_url: 'https://cdn.example/render.png' },
      },
    });
  }
  if (url.includes('/tasks/task_pending')) {
    return jsonResponse({ code: 0, data: { status: 'running', progress: 41 } });
  }
  if (url === 'https://cdn.example/model.glb') {
    return { ok: true, status: 200, arrayBuffer: async () => GLB_BYTES };
  }
  return jsonResponse({ code: 2001, message: 'unknown task' }, false, 404);
}

let enabledService;
let enabledOrigin;
let disabledService;
let disabledOrigin;

before(async () => {
  enabledService = createXrrcServer({ tripoApiKey: 'test-key', tripoFetch: fakeTripoFetch });
  disabledService = createXrrcServer({ tripoApiKey: '' });
  await new Promise((resolve) => enabledService.server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve) => disabledService.server.listen(0, '127.0.0.1', resolve));
  enabledOrigin = `http://127.0.0.1:${enabledService.server.address().port}`;
  disabledOrigin = `http://127.0.0.1:${disabledService.server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => enabledService.server.close(resolve));
  await new Promise((resolve) => disabledService.server.close(resolve));
});

test('reports Tripo availability and refuses work when unconfigured', async () => {
  const enabled = await fetch(`${enabledOrigin}/api/tripo/status`);
  assert.deepEqual(await enabled.json(), { enabled: true });

  const disabled = await fetch(`${disabledOrigin}/api/tripo/status`);
  assert.deepEqual(await disabled.json(), { enabled: false });

  const refused = await fetch(`${disabledOrigin}/api/tripo/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'vehicle', text: 'moon rover' }),
  });
  assert.equal(refused.status, 503);
});

test('creates vehicle and map tasks with composed prompts', async () => {
  const vehicle = await fetch(`${enabledOrigin}/api/tripo/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'vehicle', text: 'moon rover' }),
  });
  assert.equal(vehicle.status, 200);
  const vehicleBody = await vehicle.json();
  assert.equal(vehicleBody.tasks.length, 1);
  assert.equal(vehicleBody.tasks[0].role, 'vehicle');
  assert.match(vehicleBody.tasks[0].taskId, /^task_vehicle/);
  const sentVehicle = JSON.parse(tripoCalls.at(-1).init.body);
  assert.match(sentVehicle.prompt, /moon rover as a miniature toy RC vehicle/);

  const map = await fetch(`${enabledOrigin}/api/tripo/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'map', text: 'lava caves' }),
  });
  const mapBody = await map.json();
  assert.deepEqual(mapBody.tasks.map(({ role }) => role), ['landmark', 'decor', 'marker']);

  const invalid = await fetch(`${enabledOrigin}/api/tripo/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'city', text: 'nope' }),
  });
  assert.equal(invalid.status, 400);
});

test('polls tasks without leaking upstream model urls', async () => {
  const pending = await fetch(`${enabledOrigin}/api/tripo/task/task_pending`);
  assert.deepEqual(await pending.json(), { status: 'running', progress: 41, imageUrl: '' });

  const ready = await fetch(`${enabledOrigin}/api/tripo/task/task_ready`);
  const readyBody = await ready.json();
  assert.equal(readyBody.status, 'success');
  assert.equal(readyBody.imageUrl, 'https://cdn.example/render.png');
  assert.equal('modelUrl' in readyBody, false);

  // Real Tripo task ids are opaque UUIDs with no fixed prefix - a
  // well-formed-but-unknown id must be forwarded upstream, not rejected
  // locally (this was the reported "Invalid task id" regression).
  const unknown = await fetch(`${enabledOrigin}/api/tripo/task/07764597-9c93-4eb9-92b6-4ea96a8c7d1a`);
  assert.equal(unknown.status, 502);

  const malformed = await fetch(`${enabledOrigin}/api/tripo/task/bad.id.value`);
  assert.equal(malformed.status, 400);
});

test('proxies generated model binaries and caches them', async () => {
  const first = await fetch(`${enabledOrigin}/api/tripo/model/task_ready`);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'model/gltf-binary');
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), GLB_BYTES);

  const upstreamCalls = tripoCalls.length;
  const second = await fetch(`${enabledOrigin}/api/tripo/model/task_ready`);
  assert.deepEqual(Buffer.from(await second.arrayBuffer()), GLB_BYTES);
  assert.equal(tripoCalls.length, upstreamCalls, 'cached model must not re-fetch upstream');
});

test('rate limits generation bursts per client', async () => {
  const statuses = [];
  for (let index = 0; index < 5; index += 1) {
    const response = await fetch(`${enabledOrigin}/api/tripo/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'vehicle', text: `burst ${index}` }),
    });
    statuses.push(response.status);
  }
  assert.equal(statuses.filter((status) => status === 429).length >= 1, true);
});

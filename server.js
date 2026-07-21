'use strict';

const http = require('http');
const path = require('path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const { normalizeRoom } = require('./public/js/config');
const { normalizeTrackId } = require('./public/js/track-core');
const TripoCore = require('./public/js/tripo-core');

const DEFAULT_ORIGINS = ['https://lab.liambroza.com'];
const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice']);
const TRIPO_API_BASE = 'https://openapi.tripo3d.ai/v3';
const TRIPO_RATE_WINDOW_MS = 10 * 60 * 1000;
const TRIPO_RATE_MAX_REQUESTS = 4;
const TRIPO_MODEL_CACHE_LIMIT = 8;

function createOriginPolicy(configuredOrigins) {
  const values = configuredOrigins || process.env.ALLOWED_ORIGINS || DEFAULT_ORIGINS;
  const origins = Array.isArray(values)
    ? values
    : String(values).split(',').map((value) => value.trim()).filter(Boolean);
  const allowed = new Set(origins.map((value) => value.replace(/\/$/, '')));

  return function isOriginAllowed(origin) {
    if (!origin) return true;
    if (allowed.has('*') || allowed.has(origin.replace(/\/$/, ''))) return true;

    try {
      const url = new URL(origin);
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      );
    } catch {
      return false;
    }
  };
}

function createXrrcServer(options = {}) {
  const app = express();
  const server = http.createServer(app);
  const rooms = new Map();
  const isOriginAllowed = createOriginPolicy(options.allowedOrigins);
  const wss = new WebSocketServer({
    server,
    path: '/ws',
    maxPayload: 256 * 1024,
    verifyClient(info, done) {
      if (isOriginAllowed(info.origin)) {
        done(true);
      } else {
        done(false, 403, 'Origin not allowed');
      }
    },
  });

  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/health', (req, res) => {
    const origin = req.get('origin');
    if (origin && !isOriginAllowed(origin)) {
      res.status(403).json({ status: 'forbidden' });
      return;
    }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
    res.set('Cache-Control', 'no-store');
    res.json({
      status: 'ok',
      service: 'xrrc-signaling',
      connections: wss.clients.size,
      rooms: rooms.size,
    });
  });

  // -- Tripo AI generation proxy -----------------------------------------
  // The client never talks to Tripo directly: the API key stays here, user
  // text is composed into guard-railed prompts server-side, and generated
  // GLB binaries are streamed through /api/tripo/model/:taskId so browser
  // clients (including remote peers) can load them without CORS issues.
  const tripoApiKey = options.tripoApiKey ?? process.env.TRIPO_API_KEY ?? '';
  const tripoFetch = options.tripoFetch || globalThis.fetch;
  const tripoModelCache = new Map(); // taskId -> Promise<Buffer>
  const tripoRateLog = new Map(); // ip -> [timestamps]

  function applyTripoCors(req, res) {
    const origin = req.get('origin');
    if (origin && !isOriginAllowed(origin)) {
      res.status(403).json({ error: 'Origin not allowed' });
      return false;
    }
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
    }
    return true;
  }

  function tripoGuard(req, res) {
    if (!applyTripoCors(req, res)) return false;
    if (!tripoApiKey) {
      res.status(503).json({ error: 'Tripo generation is not configured' });
      return false;
    }
    return true;
  }

  function tripoRateLimited(ip) {
    const now = Date.now();
    const log = (tripoRateLog.get(ip) || []).filter((time) => now - time < TRIPO_RATE_WINDOW_MS);
    if (log.length >= TRIPO_RATE_MAX_REQUESTS) {
      tripoRateLog.set(ip, log);
      return true;
    }
    log.push(now);
    tripoRateLog.set(ip, log);
    return false;
  }

  async function tripoRequest(pathname, init = {}) {
    const response = await tripoFetch(`${TRIPO_API_BASE}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${tripoApiKey}`,
        'Content-Type': 'application/json',
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.code !== 0) {
      const message = (body && body.message) || `Tripo request failed (${response.status})`;
      throw new Error(message);
    }
    return body.data;
  }

  function createTripoTask(prompt, kind) {
    return tripoRequest('/generation/text-to-model', {
      method: 'POST',
      body: JSON.stringify(TripoCore.taskPayload(prompt, kind)),
    });
  }

  app.get('/api/tripo/status', (req, res) => {
    if (!applyTripoCors(req, res)) return;
    res.set('Cache-Control', 'no-store');
    res.json({ enabled: Boolean(tripoApiKey) });
  });

  app.post('/api/tripo/generate', express.json({ limit: '4kb' }), async (req, res) => {
    if (!tripoGuard(req, res)) return;
    const kind = req.body && req.body.kind;
    const text = TripoCore.cleanPromptText(req.body && req.body.text);
    if (!text || (kind !== 'vehicle' && kind !== 'map')) {
      res.status(400).json({ error: 'Expected { kind: "vehicle" | "map", text }' });
      return;
    }
    if (tripoRateLimited(req.ip)) {
      res.status(429).json({ error: 'Too many generations; try again in a few minutes' });
      return;
    }
    try {
      if (kind === 'vehicle') {
        const data = await createTripoTask(TripoCore.composeVehiclePrompt(text), 'vehicle');
        res.json({ tasks: [{ role: 'vehicle', taskId: data.task_id }] });
        return;
      }
      const tasks = await Promise.all(
        TripoCore.composePropPrompts(text).map(async ({ role, prompt }) => {
          const data = await createTripoTask(prompt, 'prop');
          return { role, taskId: data.task_id };
        })
      );
      res.json({ tasks });
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  app.get('/api/tripo/task/:taskId', async (req, res) => {
    if (!tripoGuard(req, res)) return;
    if (!TripoCore.isTaskId(req.params.taskId)) {
      res.status(400).json({ error: 'Invalid task id' });
      return;
    }
    try {
      const task = TripoCore.normalizeTask(await tripoRequest(`/tasks/${req.params.taskId}`));
      res.set('Cache-Control', 'no-store');
      // model_url stays server-side; clients fetch /api/tripo/model/:taskId.
      res.json({ status: task.status, progress: task.progress, imageUrl: task.imageUrl });
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  app.get('/api/tripo/model/:taskId', async (req, res) => {
    if (!tripoGuard(req, res)) return;
    const taskId = req.params.taskId;
    if (!TripoCore.isTaskId(taskId)) {
      res.status(400).json({ error: 'Invalid task id' });
      return;
    }
    if (!tripoModelCache.has(taskId)) {
      tripoModelCache.set(taskId, (async () => {
        const task = TripoCore.normalizeTask(await tripoRequest(`/tasks/${taskId}`));
        if (task.status !== 'success' || !task.modelUrl) {
          const error = new Error(`Model is not ready (task ${task.status})`);
          error.notReady = true;
          throw error;
        }
        const upstream = await tripoFetch(task.modelUrl);
        if (!upstream.ok) throw new Error(`Model download failed (${upstream.status})`);
        return Buffer.from(await upstream.arrayBuffer());
      })());
      // Bound the cache; evict the oldest entry beyond the cap.
      if (tripoModelCache.size > TRIPO_MODEL_CACHE_LIMIT) {
        tripoModelCache.delete(tripoModelCache.keys().next().value);
      }
    }
    try {
      const buffer = await tripoModelCache.get(taskId);
      res.set('Content-Type', 'model/gltf-binary');
      res.set('Cache-Control', 'private, max-age=3600');
      res.send(buffer);
    } catch (error) {
      tripoModelCache.delete(taskId);
      res.status(error.notReady ? 409 : 502).json({ error: error.message });
    }
  });

  function getRoom(name) {
    if (!rooms.has(name)) rooms.set(name, new Map());
    return rooms.get(name);
  }

  function send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  function broadcastToRoom(room, senderWs, message) {
    room.forEach((clientWs) => {
      if (clientWs !== senderWs) send(clientWs, message);
    });
  }

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const roomName = normalizeRoom(url.searchParams.get('room'));
    const trackId = normalizeTrackId(url.searchParams.get('track'));
    const roomKey = `${roomName}:${trackId}`;
    const id = randomUUID();
    const room = getRoom(roomKey);
    const hostId = room.keys().next().value || id;

    ws.isAlive = true;
    ws.rcId = id;
    ws.rcRoom = roomName;
    ws.rcTrack = trackId;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    send(ws, {
      type: 'welcome',
      id,
      host: hostId,
      peers: Array.from(room.keys()),
      track: trackId,
    });
    broadcastToRoom(room, ws, { type: 'peer-joined', id });
    room.set(id, ws);

    ws.on('message', (rawData) => {
      let message;
      try {
        message = JSON.parse(rawData.toString());
      } catch {
        send(ws, { type: 'error', code: 'invalid-json' });
        return;
      }

      if (
        !message ||
        typeof message !== 'object' ||
        !SIGNAL_TYPES.has(message.type) ||
        typeof message.to !== 'string'
      ) {
        send(ws, { type: 'error', code: 'invalid-signal' });
        return;
      }

      const target = room.get(message.to);
      if (!target) {
        send(ws, { type: 'error', code: 'peer-unavailable', peer: message.to });
        return;
      }

      const forwarded = { type: message.type, from: id, to: message.to };
      if (message.type === 'ice') {
        forwarded.candidate = message.candidate;
      } else {
        forwarded.sdp = message.sdp;
      }
      send(target, forwarded);
    });

    ws.on('close', () => {
      const wasHost = room.keys().next().value === id;
      room.delete(id);
      broadcastToRoom(room, ws, { type: 'peer-left', id });
      if (wasHost && room.size > 0) {
        broadcastToRoom(room, ws, {
          type: 'host-changed',
          id: room.keys().next().value,
        });
      }
      if (room.size === 0) rooms.delete(roomKey);
    });

    ws.on('error', (error) => {
      console.error(`WebSocket error for ${id}:`, error.message);
    });
  });

  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));

  return { app, isOriginAllowed, rooms, server, wss };
}

const service = createXrrcServer();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

if (require.main === module) {
  service.server.listen(PORT, HOST, () => {
    console.log(`XRRC signaling ready at http://${HOST}:${PORT}`);
    console.log(`Share it privately with: tailscale serve --bg ${PORT}`);
  });
}

module.exports = {
  ...service,
  createOriginPolicy,
  createXrrcServer,
};

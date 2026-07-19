'use strict';

const http = require('http');
const path = require('path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const { normalizeRoom } = require('./public/js/config');
const { normalizeTrackId } = require('./public/js/track-core');

const DEFAULT_ORIGINS = ['https://lab.liambroza.com'];
const SIGNAL_TYPES = new Set(['offer', 'answer', 'ice']);

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

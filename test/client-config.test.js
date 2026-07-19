'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Config = require('../public/js/config');

test('normalizes memorable room codes without allowing URL punctuation', () => {
  assert.equal(Config.normalizeRoom('  Friday Night!  '), 'friday-night');
  assert.equal(Config.normalizeRoom('___'), Config.DEFAULT_ROOM);
  assert.equal(Config.normalizeRoom('A'.repeat(40)).length, 32);
});

test('uses query, deployment, and local signaling values in priority order', () => {
  const deployment = { signalUrl: 'https://relay.tailnet.ts.net' };
  assert.equal(
    Config.getInitialSignalValue({
      search: '?signal=wss%3A%2F%2Foverride.example%2Fws',
      hostname: 'lab.liambroza.com',
      origin: 'https://lab.liambroza.com',
    }, deployment),
    'wss://override.example/ws'
  );
  assert.equal(
    Config.getInitialSignalValue({
      search: '',
      hostname: 'lab.liambroza.com',
      origin: 'https://lab.liambroza.com',
    }, deployment),
    deployment.signalUrl
  );
  assert.equal(
    Config.getInitialSignalValue({
      search: '',
      hostname: 'localhost',
      origin: 'http://localhost:3000',
    }),
    'http://localhost:3000'
  );
});

test('turns Tailscale HTTPS addresses into secure WebSocket URLs', () => {
  assert.equal(
    Config.normalizeSignalUrl('rally-box.example-tailnet.ts.net').toString(),
    'wss://rally-box.example-tailnet.ts.net/ws'
  );
  assert.equal(
    Config.normalizeSignalUrl('https://rally-box.example-tailnet.ts.net/custom').toString(),
    'wss://rally-box.example-tailnet.ts.net/custom'
  );
  assert.throws(
    () => Config.normalizeSignalUrl('http://192.0.2.4:3000', 'https:'),
    /requires a secure wss/
  );
  assert.throws(
    () => Config.normalizeSignalUrl('ftp://example.com'),
    /HTTPS or secure WebSocket/
  );
});

test('adds normalized rooms and derives the backend health endpoint', () => {
  assert.equal(
    Config.buildSignalUrl(
      'https://rally-box.example-tailnet.ts.net',
      'Friday Night',
      'https:',
      'alpine'
    ),
    'wss://rally-box.example-tailnet.ts.net/ws?room=friday-night&track=alpine'
  );
  assert.equal(
    Config.getHealthUrl(
      'wss://rally-box.example-tailnet.ts.net/ws?room=old',
      'https:'
    ),
    'https://rally-box.example-tailnet.ts.net/health'
  );
});

test('builds a repository-subpath invite without dropping the relay', () => {
  const shareUrl = new URL(Config.buildShareUrl(
    'https://lab.liambroza.com/XRRC/?debug=1#track',
    'Pit Crew',
    'https://rally-box.example-tailnet.ts.net',
    'sakura'
  ));

  assert.equal(shareUrl.origin, 'https://lab.liambroza.com');
  assert.equal(shareUrl.pathname, '/XRRC/');
  assert.equal(shareUrl.searchParams.get('debug'), '1');
  assert.equal(shareUrl.searchParams.get('room'), 'pit-crew');
  assert.equal(shareUrl.searchParams.get('track'), 'sakura');
  assert.equal(
    shareUrl.searchParams.get('signal'),
    'wss://rally-box.example-tailnet.ts.net/ws'
  );
  assert.equal(shareUrl.hash, '');
});

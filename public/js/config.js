(function exposeConfig(root, factory) {
  'use strict';

  const config = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = config;
  } else {
    root.XRRCConfig = config;
  }
})(typeof window === 'undefined' ? globalThis : window, function createConfig() {
  'use strict';

  const DEFAULT_ROOM = 'backyard';
  const SIGNAL_PATH = '/ws';

  function normalizeRoom(value) {
    const room = String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9 _-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);

    return room || DEFAULT_ROOM;
  }

  function isLocalHostname(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  }

  function getInitialSignalValue(locationLike, deployment = {}) {
    const params = new URLSearchParams(locationLike.search || '');
    if (params.has('signal')) {
      const queryValue = params.get('signal');
      return /^(off|solo)$/i.test(queryValue || '') ? '' : queryValue || '';
    }
    if (deployment.signalUrl) return deployment.signalUrl;
    if (isLocalHostname(locationLike.hostname)) return locationLike.origin;
    return '';
  }

  function normalizeSignalUrl(value, pageProtocol = 'https:') {
    const rawValue = String(value || '').trim();
    if (!rawValue || /^(off|solo)$/i.test(rawValue)) return null;

    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(rawValue)
      ? rawValue
      : `https://${rawValue}`;

    let url;
    try {
      url = new URL(candidate);
    } catch {
      throw new TypeError('Enter a valid Tailscale Serve URL.');
    }

    if (url.username || url.password) {
      throw new TypeError('Backend URLs cannot contain credentials.');
    }

    if (url.protocol === 'https:') url.protocol = 'wss:';
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
      throw new TypeError('Use an HTTPS or secure WebSocket backend URL.');
    }
    if (pageProtocol === 'https:' && url.protocol !== 'wss:') {
      throw new TypeError('This HTTPS page requires a secure wss:// backend.');
    }

    if (!url.pathname || url.pathname === '/') url.pathname = SIGNAL_PATH;
    url.hash = '';
    return url;
  }

  function buildSignalUrl(value, room, pageProtocol = 'https:', track = null) {
    const url = normalizeSignalUrl(value, pageProtocol);
    if (!url) return null;
    url.searchParams.set('room', normalizeRoom(room));
    if (track) url.searchParams.set('track', String(track));
    else url.searchParams.delete('track');
    return url.toString();
  }

  function getHealthUrl(value, pageProtocol = 'https:') {
    const url = normalizeSignalUrl(value, pageProtocol);
    if (!url) return null;
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/health';
    url.search = '';
    return url.toString();
  }

  function buildShareUrl(locationHref, room, signalValue, track = null) {
    const url = new URL(locationHref);
    url.searchParams.set('room', normalizeRoom(room));
    if (track) url.searchParams.set('track', String(track));
    if (String(signalValue || '').trim()) {
      const signal = normalizeSignalUrl(signalValue, url.protocol);
      url.searchParams.set('signal', signal.toString());
    } else {
      url.searchParams.delete('signal');
    }
    url.hash = '';
    return url.toString();
  }

  return Object.freeze({
    DEFAULT_ROOM,
    SIGNAL_PATH,
    buildShareUrl,
    buildSignalUrl,
    getHealthUrl,
    getInitialSignalValue,
    isLocalHostname,
    normalizeRoom,
    normalizeSignalUrl,
  });
});

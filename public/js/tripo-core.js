(function exposeTripoCore(root, factory) {
  'use strict';

  const core = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  } else {
    root.XRRCTripoCore = core;
  }
})(typeof window === 'undefined' ? globalThis : window, function createTripoCore() {
  'use strict';

  // Tripo v3 API (https://developers.tripo3d.ai): async tasks created via
  // POST /generation/text-to-model, polled via GET /tasks/{task_id}.
  const MODEL_VERSION = 'v3.1-20260211';
  const VEHICLE_FACE_LIMIT = 15000;
  const PROP_FACE_LIMIT = 8000;
  const POLL_INTERVAL_MS = 3000;
  const POLL_TIMEOUT_MS = 10 * 60 * 1000;
  const NEGATIVE_PROMPT =
    'platform, base, pedestal, diorama floor, background scenery, text, watermark, wireframe, blurry';
  const STYLE_SUFFIX =
    'low-poly cartoon style, chunky proportions, vibrant flat colors, clean silhouette, game asset';
  const TASK_STATUSES = new Set(['queued', 'running', 'success', 'failed', 'cancelled']);

  // The three prop roles generated per map theme. Sizes and world anchors
  // live with the track layout in game.js; roles and prompts live here.
  const PROP_ROLES = Object.freeze(['landmark', 'decor', 'marker']);
  const PROP_HINTS = Object.freeze({
    landmark: 'A large {theme} landmark structure',
    decor: 'A medium-sized {theme} decorative object',
    marker: 'A small {theme} trackside object',
  });

  function cleanPromptText(value, limit = 120) {
    return String(value == null ? '' : value)
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit)
      .trim();
  }

  function composeVehiclePrompt(text) {
    const subject = cleanPromptText(text).replace(/^(a|an|the)\s+/i, '');
    if (!subject) return '';
    return `A ${subject} as a miniature toy RC vehicle, one single complete drivable vehicle, ${STYLE_SUFFIX}`;
  }

  function composePropPrompts(theme) {
    const subject = cleanPromptText(theme);
    if (!subject) return [];
    return PROP_ROLES.map((role) => ({
      role,
      prompt: `${PROP_HINTS[role].replace('{theme}', subject)}, for a miniature toy RC racing diorama, one single object, ${STYLE_SUFFIX}`,
    }));
  }

  function taskPayload(prompt, kind) {
    return {
      prompt,
      model: MODEL_VERSION,
      negative_prompt: NEGATIVE_PROMPT,
      face_limit: kind === 'vehicle' ? VEHICLE_FACE_LIMIT : PROP_FACE_LIMIT,
      texture: true,
      pbr: true,
      texture_quality: 'standard',
    };
  }

  // Tripo's real task_id is an opaque token (in practice a UUID, e.g.
  // "07764597-9c93-4eb9-92b6-4ea96a8c7d1a") - despite the docs' illustrative
  // "task_abc123" example, it carries no fixed prefix. Validate shape only
  // (safe charset, bounded length) rather than assuming a literal prefix,
  // so real ids aren't rejected before ever reaching Tripo.
  function isTaskId(value) {
    return /^[A-Za-z0-9_-]{6,80}$/.test(String(value || ''));
  }

  // Trims a raw Tripo task response down to what the client needs. The
  // upstream model_url is kept separate so the server can withhold it and
  // serve the binary through its own proxy route instead.
  function normalizeTask(data) {
    const raw = data || {};
    const status = TASK_STATUSES.has(raw.status) ? raw.status : 'failed';
    const clamped = Math.max(0, Math.min(100, Math.round(Number(raw.progress) || 0)));
    const output = raw.output || {};
    return {
      status,
      progress: status === 'success' ? 100 : clamped,
      imageUrl: typeof output.rendered_image_url === 'string' ? output.rendered_image_url : '',
      modelUrl: typeof output.model_url === 'string' ? output.model_url : '',
    };
  }

  function shortLabel(text, fallback = 'Dream car') {
    const value = cleanPromptText(text, 26).replace(/^(a|an|the)\s+/i, '');
    if (!value) return fallback;
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  return Object.freeze({
    MODEL_VERSION,
    POLL_INTERVAL_MS,
    POLL_TIMEOUT_MS,
    PROP_ROLES,
    cleanPromptText,
    composeVehiclePrompt,
    composePropPrompts,
    taskPayload,
    isTaskId,
    normalizeTask,
    shortLabel,
  });
});

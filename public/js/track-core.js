(function exposeTrackCore(root, factory) {
  'use strict';

  const core = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  } else {
    root.XRRCTrackCore = core;
  }
})(typeof window === 'undefined' ? globalThis : window, function createTrackCore() {
  'use strict';

  const DEFAULT_TRACK = 'backyard';
  const ADDITIONAL_TRACK_IDS = Object.freeze([
    'alpine',
    'desert',
    'harbor',
    'sakura',
    'lunar',
  ]);

  const definitions = [
    {
      id: 'backyard',
      scenery: 'backyard',
      sign: 'XRRC // DIRT LAB',
      roadWidth: 1.18,
      points: [
        [-3.35, -1.15],
        [-2.25, -2.25],
        [-0.25, -2.52],
        [1.95, -2.28],
        [3.25, -1.35],
        [3.48, 0.05],
        [3.05, 1.48],
        [1.65, 2.43],
        [0.25, 2.12],
        [-1.25, 2.52],
        [-3.05, 1.68],
        [-3.48, 0.25],
      ],
      palette: {
        ground: 0x718956,
        shoulder: 0xa68f60,
        road: 0x3f413a,
        line: 0xeee2c8,
        curbA: 0xd9442b,
        curbB: 0xeee2c8,
        accent: 0xf1c644,
        dark: 0x24251f,
        sky: 0xb9d4ce,
        fog: 0xb9d4ce,
        dust: 0xb7a070,
      },
      lighting: {
        hemisphereSky: 0xfff0d0,
        hemisphereGround: 0x5f7650,
        hemisphereIntensity: 2.2,
        sun: 0xffe5b5,
        sunIntensity: 3.1,
      },
    },
    {
      id: 'alpine',
      scenery: 'alpine',
      sign: 'XRRC // SUMMIT 88',
      roadWidth: 1.08,
      points: [
        [-3.42, -1.42],
        [-2.72, -2.3],
        [-1.35, -2.55],
        [-0.25, -1.72],
        [1.15, -2.48],
        [2.82, -2.2],
        [3.46, -1.05],
        [2.55, -0.05],
        [3.28, 1.22],
        [1.72, 2.42],
        [0.3, 2.12],
        [-1.18, 2.55],
        [-2.42, 1.62],
        [-3.5, 0.32],
      ],
      palette: {
        ground: 0xdce7e9,
        shoulder: 0xb8cad0,
        road: 0x46545e,
        line: 0xf4f0dd,
        curbA: 0x3e7892,
        curbB: 0xf4f0dd,
        accent: 0xf29d49,
        dark: 0x25343b,
        sky: 0xb9d5e5,
        fog: 0xc7dce7,
        dust: 0xd9e5e7,
      },
      lighting: {
        hemisphereSky: 0xe9f6ff,
        hemisphereGround: 0x657b82,
        hemisphereIntensity: 2.35,
        sun: 0xfff7df,
        sunIntensity: 3.4,
      },
    },
    {
      id: 'desert',
      scenery: 'desert',
      sign: 'XRRC // DUST DEVIL',
      roadWidth: 1.14,
      points: [
        [-3.45, -0.78],
        [-2.85, -2.08],
        [-1.1, -2.55],
        [0.35, -2.18],
        [1.72, -2.52],
        [3.32, -1.75],
        [3.48, -0.32],
        [2.7, 0.62],
        [3.22, 1.68],
        [1.62, 2.44],
        [0.28, 2.13],
        [-1.45, 2.5],
        [-3.12, 1.35],
      ],
      palette: {
        ground: 0xc98b4b,
        shoulder: 0xa86437,
        road: 0x5a4a3e,
        line: 0xf1d7a0,
        curbA: 0xc94d2f,
        curbB: 0xf1d7a0,
        accent: 0xf0b541,
        dark: 0x38271f,
        sky: 0xe7ad6a,
        fog: 0xe2a565,
        dust: 0xd99b57,
      },
      lighting: {
        hemisphereSky: 0xffd5a0,
        hemisphereGround: 0x7d4428,
        hemisphereIntensity: 2.45,
        sun: 0xffc66e,
        sunIntensity: 3.65,
      },
    },
    {
      id: 'harbor',
      scenery: 'harbor',
      sign: 'XRRC // NIGHT SHIFT',
      roadWidth: 1.12,
      points: [
        [-3.42, -1.62],
        [-2.72, -2.46],
        [-0.72, -2.48],
        [0.22, -1.62],
        [1.15, -2.45],
        [3.18, -2.08],
        [3.46, -0.62],
        [2.62, 0.12],
        [3.42, 1.42],
        [1.68, 2.42],
        [0.3, 2.12],
        [-1.12, 2.5],
        [-3.18, 1.72],
        [-3.52, 0.08],
      ],
      palette: {
        ground: 0x26313b,
        shoulder: 0x3b4650,
        road: 0x1f252c,
        line: 0xe8dfc4,
        curbA: 0xe35a2c,
        curbB: 0xe8dfc4,
        accent: 0xf1ad3f,
        dark: 0x12191f,
        sky: 0x536274,
        fog: 0x536274,
        dust: 0x77838c,
      },
      lighting: {
        hemisphereSky: 0x8c9aab,
        hemisphereGround: 0x17212a,
        hemisphereIntensity: 1.9,
        sun: 0xffb45b,
        sunIntensity: 3.2,
      },
    },
    {
      id: 'sakura',
      scenery: 'sakura',
      sign: 'XRRC // BLOOM RUN',
      roadWidth: 1.1,
      points: [
        [-3.36, -1.18],
        [-2.55, -2.28],
        [-1.02, -2.52],
        [0.22, -1.82],
        [1.42, -2.42],
        [3.18, -1.72],
        [3.4, -0.22],
        [2.42, 0.58],
        [3.05, 1.68],
        [1.7, 2.4],
        [0.3, 2.12],
        [-1.25, 2.48],
        [-2.75, 1.82],
        [-3.46, 0.42],
      ],
      palette: {
        ground: 0x789273,
        shoulder: 0xb88876,
        road: 0x454448,
        line: 0xf4eadf,
        curbA: 0xd66f85,
        curbB: 0xf4eadf,
        accent: 0xf0b64e,
        dark: 0x30282e,
        sky: 0xe4bec5,
        fog: 0xe1c2c6,
        dust: 0xc8a091,
      },
      lighting: {
        hemisphereSky: 0xffe4e8,
        hemisphereGround: 0x60765b,
        hemisphereIntensity: 2.25,
        sun: 0xffe5bf,
        sunIntensity: 3.15,
      },
    },
    {
      id: 'lunar',
      scenery: 'lunar',
      sign: 'XRRC // SEA OF SPEED',
      roadWidth: 1.16,
      points: [
        [-3.48, -1.08],
        [-2.4, -2.36],
        [-0.52, -2.52],
        [1.1, -2.28],
        [2.9, -2.0],
        [3.5, -0.55],
        [3.02, 1.18],
        [1.68, 2.42],
        [0.28, 2.12],
        [-1.25, 2.52],
        [-3.08, 1.55],
        [-3.55, 0.18],
      ],
      palette: {
        ground: 0x72757d,
        shoulder: 0x53565e,
        road: 0x262a31,
        line: 0xd9d6c9,
        curbA: 0xe0b642,
        curbB: 0xd9d6c9,
        accent: 0xe0b642,
        dark: 0x171a20,
        sky: 0x161b27,
        fog: 0x303744,
        dust: 0x92949a,
      },
      lighting: {
        hemisphereSky: 0xaebbd0,
        hemisphereGround: 0x32343b,
        hemisphereIntensity: 1.85,
        sun: 0xf4f0dc,
        sunIntensity: 3.5,
      },
    },
  ];

  function freezeDefinition(definition) {
    const points = Object.freeze(
      definition.points.map((point) => Object.freeze([...point]))
    );
    return Object.freeze({
      ...definition,
      points,
      palette: Object.freeze({ ...definition.palette }),
      lighting: Object.freeze({ ...definition.lighting }),
    });
  }

  const tracks = Object.freeze(Object.fromEntries(
    definitions.map((definition) => {
      const track = freezeDefinition(definition);
      return [track.id, track];
    })
  ));
  const TRACK_IDS = Object.freeze(Object.keys(tracks));
  const aliases = Object.freeze({
    garden: 'backyard',
    snow: 'alpine',
    canyon: 'desert',
    docks: 'harbor',
    blossom: 'sakura',
    moon: 'lunar',
  });

  function normalizeTrackId(value) {
    const candidate = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9-]+$/.test(candidate)) return DEFAULT_TRACK;
    const normalized = aliases[candidate] || candidate;
    return Object.hasOwn(tracks, normalized) ? normalized : DEFAULT_TRACK;
  }

  function getTrack(value) {
    return tracks[normalizeTrackId(value)];
  }

  return Object.freeze({
    ADDITIONAL_TRACK_IDS,
    DEFAULT_TRACK,
    TRACK_IDS,
    getTrack,
    normalizeTrackId,
    tracks,
  });
});

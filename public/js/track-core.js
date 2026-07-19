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
        [0.8, 2.25],
        [-0.046, 2.274],
        [-0.911, 2.332],
        [-1.849, 2.204],
        [-2.619, 1.737],
        [-2.999, 1.041],
        [-3.075, 0.309],
        [-3.05, -0.424],
        [-2.889, -1.228],
        [-2.335, -1.991],
        [-1.323, -2.392],
        [-0.198, -2.226],
        [0.627, -1.689],
        [1.161, -1.188],
        [1.788, -0.881],
        [2.693, -0.521],
        [3.508, 0.176],
        [3.646, 1.112],
        [2.947, 1.879],
        [1.831, 2.214],
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
        [0.8, 2.25],
        [-0.169, 2.123],
        [-0.882, 2.099],
        [-1.65, 2.222],
        [-2.564, 2.17],
        [-3.322, 1.709],
        [-3.637, 0.971],
        [-3.602, 0.214],
        [-3.485, -0.513],
        [-3.288, -1.305],
        [-2.742, -2.058],
        [-1.775, -2.408],
        [-0.749, -2.14],
        [-0.07, -1.506],
        [0.334, -0.987],
        [0.923, -0.729],
        [1.877, -0.394],
        [2.728, 0.352],
        [2.805, 1.349],
        [1.982, 2.075],
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
        [0.8, 2.25],
        [-0.511, 2.022],
        [-1.533, 1.561],
        [-2.368, 1],
        [-3.046, 0.279],
        [-3.346, -0.643],
        [-2.998, -1.591],
        [-2.033, -2.249],
        [-0.815, -2.443],
        [0.294, -2.281],
        [1.237, -1.973],
        [2.159, -1.564],
        [3.042, -0.904],
        [3.543, 0.085],
        [3.275, 1.186],
        [2.222, 1.995],
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
        [0.8, 2.25],
        [-0.169, 2.054],
        [-0.946, 1.711],
        [-1.777, 1.421],
        [-2.816, 1.017],
        [-3.628, 0.272],
        [-3.584, -0.655],
        [-2.655, -1.337],
        [-1.459, -1.621],
        [-0.463, -1.794],
        [0.508, -2.1],
        [1.762, -2.319],
        [3.038, -2.036],
        [3.677, -1.227],
        [3.469, -0.32],
        [2.922, 0.343],
        [2.572, 0.857],
        [2.33, 1.449],
        [1.759, 2.022],
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
        [0.8, 2.25],
        [-0.174, 2.165],
        [-0.958, 2.221],
        [-1.896, 2.294],
        [-2.832, 2.009],
        [-3.282, 1.345],
        [-3.211, 0.628],
        [-3.075, -0.017],
        [-3.035, -0.809],
        [-2.636, -1.779],
        [-1.523, -2.482],
        [-0.055, -2.483],
        [1.149, -1.901],
        [1.987, -1.17],
        [2.731, -0.435],
        [3.27, 0.463],
        [3.092, 1.451],
        [2.075, 2.116],
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
        [0.8, 2.25],
        [-0.35, 2.091],
        [-1.313, 1.75],
        [-2.16, 1.303],
        [-2.905, 0.697],
        [-3.345, -0.119],
        [-3.188, -1.033],
        [-2.34, -1.776],
        [-1.063, -2.107],
        [0.213, -1.998],
        [1.213, -1.627],
        [1.962, -1.181],
        [2.611, -0.694],
        [3.152, -0.074],
        [3.351, 0.71],
        [2.966, 1.508],
        [2.015, 2.072],
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

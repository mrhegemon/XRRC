'use strict';

// Dev-only helper: searches for circuit layouts that satisfy the geometric
// constraints in validate-tracks.js, then ranks survivors by how varied their
// corners are so the result is a real racing line rather than an oval.
//
// Strategy: build a smooth closed loop from a few radial harmonics, find a
// section where the tangent is already horizontal, and translate the whole loop
// so that section lands on the start grid. Generating first and placing second
// avoids the radius discontinuity you get from welding a straight onto an arc.
//
// Usage: node scripts/generate-tracks.js <trackId> [trials] [roadWidth]

const { analyse } = require('./validate-tracks');

const START = { x: 0.8, z: 2.25 };
const LIMIT_X = 3.7;
const LIMIT_Z = 2.7;
const DENSE = 720;

function makeRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Per-circuit character. Higher harmonics and amplitude mean more direction
// changes; straightBias trades lap length against a long full-throttle run.
const CHARACTERS = {
  balanced: { kMax: 3, ampBase: 0.03, ampSpan: 0.13, straightBias: 1 },
  switchback: { kMax: 4, ampBase: 0.06, ampSpan: 0.16, straightBias: 0.7 },
  fast: { kMax: 2, ampBase: 0.02, ampSpan: 0.08, straightBias: 1.9 },
  angular: { kMax: 4, ampBase: 0.07, ampSpan: 0.17, straightBias: 1.1 },
  technical: { kMax: 5, ampBase: 0.08, ampSpan: 0.18, straightBias: 0.55 },
  sweeping: { kMax: 2, ampBase: 0.02, ampSpan: 0.06, straightBias: 1.5 },
};

function randomShape(random, character) {
  const harmonics = [];
  const count = 2 + Math.floor(random() * 2);
  for (let i = 0; i < count; i += 1) {
    harmonics.push({
      k: 1 + Math.floor(random() * character.kMax),
      amplitude: character.ampBase + random() * character.ampSpan,
      phase: random() * Math.PI * 2,
    });
  }
  return {
    harmonics,
    // Sized to fill the 7.4 x 5.4 playable box rather than a small loop in the
    // middle of it; the exact fit is checked after the start-grid translation.
    stretchX: 2.55 + random() * 0.75,
    stretchZ: 1.95 + random() * 0.5,
    controlPoints: 16 + Math.floor(random() * 5),
  };
}

function radiusAt(shape, angle) {
  let wobble = 0;
  for (const { k, amplitude, phase } of shape.harmonics) {
    wobble += Math.sin(angle * k + phase) * amplitude;
  }
  return 1 + wobble;
}

function pointAt(shape, angle) {
  const radius = radiusAt(shape, angle);
  return {
    x: Math.cos(angle) * radius * shape.stretchX,
    z: Math.sin(angle) * radius * shape.stretchZ,
  };
}

function buildCandidate(shape) {
  // Dense sampling to locate a naturally horizontal run near the bottom.
  const dense = [];
  for (let i = 0; i < DENSE; i += 1) {
    dense.push(pointAt(shape, (i / DENSE) * Math.PI * 2));
  }

  // Collect every sufficiently flat run along the bottom edge. Anchoring on the
  // flattest one usually shoves the loop off the right-hand limit, because the
  // flattest point of a near-symmetric loop sits at its centre while the grid
  // is at x = 0.8. Trying each candidate lets an off-centre flat section be the
  // start straight, which keeps the loop centred in the box.
  const candidates = [];
  for (let i = 0; i < DENSE; i += 1) {
    if (dense[i].z <= 0.4) continue; // must be the bottom edge, not the top
    const before = dense[(i - 6 + DENSE) % DENSE];
    const after = dense[(i + 6) % DENSE];
    const length = Math.hypot(after.x - before.x, after.z - before.z) || 1;
    if (Math.abs((after.z - before.z) / length) > 0.05) continue;
    let flatness = 0;
    for (let offset = -22; offset <= 22; offset += 1) {
      const a = dense[(i + offset - 6 + DENSE) % DENSE];
      const b = dense[(i + offset + 6 + DENSE) % DENSE];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      flatness = Math.max(flatness, Math.abs((b.z - a.z) / len));
    }
    candidates.push({ index: i, flatness });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.flatness - b.flatness);

  const count = shape.controlPoints;
  for (const { index } of candidates.slice(0, 12)) {
    const anchor = dense[index];
    const shiftX = START.x - anchor.x;
    const shiftZ = START.z - anchor.z;
    const points = [];
    let fits = true;
    for (let i = 0; i < count; i += 1) {
      const angle = ((index / DENSE) + i / count) * Math.PI * 2;
      const raw = pointAt(shape, angle);
      const x = raw.x + shiftX;
      const z = raw.z + shiftZ;
      if (Math.abs(x) > LIMIT_X || Math.abs(z) > LIMIT_Z) {
        fits = false;
        break;
      }
      points.push([Number(x.toFixed(3)), Number(z.toFixed(3))]);
    }
    if (fits) return points;
  }
  return null;
}

function score(result, character) {
  // Reward a long lap and a real straight; punish the oval signature (most of
  // the lap registering as one constant sweep) and reward having at least one
  // corner near the tight end of the drivable range.
  const straightFraction = result.longestStraight / result.length;
  const tightness = 1 / Math.max(0.7, result.minRadius);
  return (
    result.length * 1.2 +
    Math.min(result.longestStraight, 5) * 2.2 * character.straightBias +
    tightness * 6 -
    Math.max(0, straightFraction - 0.32) * 60
  );
}

function main() {
  const [trackId, trialArg, roadWidthArg, characterArg, offsetArg] = process.argv.slice(2);
  if (!trackId) {
    throw new Error('usage: generate-tracks.js <trackId> [trials] [roadWidth] [character] [seedOffset]');
  }
  const trials = Number(trialArg) || 20000;
  const roadWidth = Number(roadWidthArg) || 1.15;
  const character = CHARACTERS[characterArg] || CHARACTERS.balanced;
  // Distinct seed ranges keep the six circuits from converging on one shape.
  const seedOffset = Number(offsetArg) || 0;

  const survivors = [];
  const reasons = new Map();
  let built = 0;
  for (let seed = 1; seed <= trials; seed += 1) {
    const random = makeRandom((seed + seedOffset) * 2654435761);
    const points = buildCandidate(randomShape(random, character));
    if (!points) continue;
    built += 1;
    const result = analyse(trackId, points, roadWidth);
    if (!result.ok) {
      for (const issue of result.issues) {
        const key = issue.replace(/-?[\d.]+/g, 'N');
        reasons.set(key, (reasons.get(key) || 0) + 1);
      }
      continue;
    }
    // A circuit that passes the geometry checks but is short or has no straight
    // is not worth shipping, so those are filtered out before ranking.
    if (result.length < 17) {
      reasons.set('too short', (reasons.get('too short') || 0) + 1);
      continue;
    }
    if (result.longestStraight < 2.2) {
      reasons.set('no usable straight for the loop', (reasons.get('no usable straight for the loop') || 0) + 1);
      continue;
    }
    survivors.push({ seed, points, ...result, score: score(result, character) });
  }

  survivors.sort((a, b) => b.score - a.score);
  console.log(`${trackId}: ${survivors.length} passed of ${built} built (${trials} trials)`);
  if (!survivors.length) {
    console.log('  failure reasons:');
    for (const [key, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      console.log(`    ${count.toString().padStart(6)}  ${key}`);
    }
    return;
  }
  for (const entry of survivors.slice(0, 3)) {
    console.log(`  seed=${entry.seed} score=${entry.score.toFixed(2)} straightFrac=${(entry.longestStraight / entry.length).toFixed(2)} len=${entry.length} minR=${entry.minRadius} straight=${entry.longestStraight} gap=${entry.minGap} startGap=${entry.startGap}`);
    console.log(`  ${JSON.stringify(entry.points)}`);
  }
}

main();

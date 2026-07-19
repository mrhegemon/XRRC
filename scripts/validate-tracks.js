'use strict';

// Dev-only helper: geometric sanity checks for circuit splines.
// Usage: node scripts/validate-tracks.js            (checks track-core definitions)
//        node scripts/validate-tracks.js points.json (checks a candidate layout)
//
// A candidate file is {"id": "...", "points": [[x, z], ...]}.

const { CatmullRomCurve3, Vector3 } = require('./vendor-curve');

const LIMIT_X = 3.75;
const LIMIT_Z = 2.75;
const START = { x: 0.8, z: 2.25 };
const SAMPLES = 480;

function sample(points) {
  const curve = new CatmullRomCurve3(
    points.map(([x, z]) => new Vector3(x, 0, z)),
    true,
    'centripetal',
    0.45
  );
  return Array.from({ length: SAMPLES }, (_, index) => {
    const point = curve.getPointAt(index / SAMPLES);
    return { x: point.x, z: point.z };
  });
}

function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function analyse(id, points, roadWidth) {
  const issues = [];
  const warnings = [];

  if (points.length < 12) issues.push(`only ${points.length} points (need >= 12)`);
  for (const [x, z] of points) {
    if (Math.abs(x) > LIMIT_X) issues.push(`x=${x} exceeds +/-${LIMIT_X}`);
    if (Math.abs(z) > LIMIT_Z) issues.push(`z=${z} exceeds +/-${LIMIT_Z}`);
  }

  const pts = sample(points);

  // Total centreline length.
  let length = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    length += Math.hypot(b.x - a.x, b.z - a.z);
  }

  // Self-intersection: a circuit must never cross itself.
  let crossings = 0;
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 2; j < pts.length; j += 1) {
      if (i === 0 && j === pts.length - 1) continue;
      if (segmentsIntersect(
        pts[i], pts[(i + 1) % pts.length],
        pts[j], pts[(j + 1) % pts.length]
      )) crossings += 1;
    }
  }
  if (crossings > 0) issues.push(`self-intersects (${crossings} crossings)`);

  // Minimum corner radius via the circumradius of consecutive sample triples.
  let minRadius = Infinity;
  let minRadiusAt = 0;
  const step = 4;
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[(i - step + pts.length) % pts.length];
    const b = pts[i];
    const c = pts[(i + step) % pts.length];
    const ab = Math.hypot(b.x - a.x, b.z - a.z);
    const bc = Math.hypot(c.x - b.x, c.z - b.z);
    const ca = Math.hypot(a.x - c.x, a.z - c.z);
    const area = Math.abs(
      (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)
    ) / 2;
    if (area < 1e-9) continue;
    const radius = (ab * bc * ca) / (4 * area);
    if (radius < minRadius) {
      minRadius = radius;
      minRadiusAt = i / pts.length;
    }
  }

  // Self-proximity: two genuinely different parts of the ribbon must not
  // overlap. Rounding a corner naturally brings the centreline close to itself
  // in straight-line terms, so a short chord only counts as an overlap when the
  // arc between the two samples is far longer than the gap itself - that is
  // what distinguishes "the track came back alongside itself" from "the track
  // turned a corner".
  let minGap = Infinity;
  const ribbon = roadWidth ? roadWidth + 0.18 : 1.33;
  const arcStep = length / pts.length;
  for (let i = 0; i < pts.length; i += 1) {
    for (let j = i + 1; j < pts.length; j += 1) {
      const apart = Math.min(j - i, pts.length - (j - i));
      const arc = apart * arcStep;
      const gap = Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z);
      if (arc < 3 * Math.max(gap, 0.05)) continue;
      if (gap < minGap) minGap = gap;
    }
  }
  if (minGap < ribbon) {
    issues.push(`ribbon overlap: closest non-adjacent gap ${minGap.toFixed(2)} < ${ribbon.toFixed(2)}`);
  }

  // The start grid must sit on the road, running along x.
  let startGap = Infinity;
  let startIndex = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const gap = Math.hypot(pts[i].x - START.x, pts[i].z - START.z);
    if (gap < startGap) {
      startGap = gap;
      startIndex = i;
    }
  }
  const before = pts[(startIndex - 3 + pts.length) % pts.length];
  const after = pts[(startIndex + 3) % pts.length];
  const tangentAngle = Math.abs(Math.atan2(after.z - before.z, after.x - before.x));
  const alignment = Math.min(tangentAngle, Math.PI - tangentAngle);
  const halfRoad = (roadWidth || 1.15) / 2;
  if (startGap > halfRoad * 0.55) {
    issues.push(`start grid ${startGap.toFixed(2)} from centreline (needs < ${(halfRoad * 0.55).toFixed(2)})`);
  }
  if (alignment > 0.61) {
    issues.push(`start straight tilted ${(alignment * 180 / Math.PI).toFixed(0)}deg from the x axis (needs < 35)`);
  }

  // Straights: runs of near-zero curvature, useful for the loop and top speed.
  let longestStraight = 0;
  let run = 0;
  for (let i = 0; i < pts.length * 2; i += 1) {
    const a = pts[(i - step + pts.length) % pts.length];
    const b = pts[i % pts.length];
    const c = pts[(i + step) % pts.length];
    const area = Math.abs(
      (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z)
    ) / 2;
    const ab = Math.hypot(b.x - a.x, b.z - a.z);
    const bc = Math.hypot(c.x - b.x, c.z - b.z);
    const ca = Math.hypot(a.x - c.x, a.z - c.z);
    const radius = area < 1e-9 ? Infinity : (ab * bc * ca) / (4 * area);
    if (radius > 5) {
      run += Math.hypot(c.x - b.x, c.z - b.z);
      longestStraight = Math.max(longestStraight, run);
    } else {
      run = 0;
    }
  }
  longestStraight = Math.min(longestStraight, length);

  // A corner tighter than half the road width pinches the ribbon: the inner
  // edge folds through itself and the rendered road self-overlaps.
  const pinchLimit = (roadWidth || 1.15) / 2 + 0.12;
  if (minRadius < pinchLimit) {
    issues.push(`tightest corner radius ${minRadius.toFixed(2)} pinches the ${(roadWidth || 1.15).toFixed(2)}-wide road (needs >= ${pinchLimit.toFixed(2)})`);
  }
  if (longestStraight < 1.6) {
    warnings.push(`longest straight only ${longestStraight.toFixed(2)} - little room to build speed`);
  }
  if (length < 15) warnings.push(`centreline ${length.toFixed(2)} is short`);

  return {
    id,
    ok: issues.length === 0,
    length: Number(length.toFixed(2)),
    minRadius: Number(minRadius.toFixed(2)),
    minRadiusAt: Number(minRadiusAt.toFixed(3)),
    longestStraight: Number(longestStraight.toFixed(2)),
    minGap: Number(minGap.toFixed(2)),
    startGap: Number(startGap.toFixed(3)),
    issues,
    warnings,
  };
}

function main() {
  const [file] = process.argv.slice(2);
  const results = [];
  if (file) {
    const candidate = require(require('node:path').resolve(file));
    const list = Array.isArray(candidate) ? candidate : [candidate];
    for (const entry of list) {
      results.push(analyse(entry.id || 'candidate', entry.points, entry.roadWidth));
    }
  } else {
    const TrackCore = require('../public/js/track-core');
    for (const track of Object.values(TrackCore.tracks)) {
      results.push(analyse(track.id, track.points, track.roadWidth));
    }
  }
  let failed = 0;
  for (const result of results) {
    if (!result.ok) failed += 1;
    console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.id.padEnd(10)} len=${result.length} minR=${result.minRadius}@${result.minRadiusAt} straight=${result.longestStraight} gap=${result.minGap} startGap=${result.startGap}`);
    for (const issue of result.issues) console.log(`     ! ${issue}`);
    for (const warning of result.warnings) console.log(`     ~ ${warning}`);
  }
  process.exitCode = failed ? 1 : 0;
}

if (require.main === module) main();

module.exports = { analyse };

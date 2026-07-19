'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const TrackCore = require('../public/js/track-core');

test('keeps Backyard Rally and adds five themed circuits', () => {
  assert.equal(TrackCore.DEFAULT_TRACK, 'backyard');
  assert.deepEqual(TrackCore.ADDITIONAL_TRACK_IDS, [
    'alpine',
    'desert',
    'harbor',
    'sakura',
    'lunar',
  ]);
  assert.equal(TrackCore.TRACK_IDS.length, 6);
});

test('defines safe, distinct geometry and art direction for every circuit', () => {
  const layouts = new Set();
  const palettes = new Set();
  const scenery = new Set();

  for (const track of Object.values(TrackCore.tracks)) {
    assert.ok(track.points.length >= 12, `${track.id} needs a complete spline`);
    assert.ok(track.roadWidth >= 1 && track.roadWidth <= 1.25);
    assert.match(track.sign, /^XRRC \/\/ /);
    for (const [x, z] of track.points) {
      assert.ok(Math.abs(x) <= 3.75, `${track.id} exceeds horizontal bounds`);
      assert.ok(Math.abs(z) <= 2.75, `${track.id} exceeds vertical bounds`);
    }
    layouts.add(JSON.stringify(track.points));
    palettes.add(JSON.stringify(track.palette));
    scenery.add(track.scenery);
  }

  assert.equal(layouts.size, TrackCore.TRACK_IDS.length);
  assert.equal(palettes.size, TrackCore.TRACK_IDS.length);
  assert.equal(scenery.size, TrackCore.TRACK_IDS.length);
});

test('normalizes track IDs and memorable aliases with a safe fallback', () => {
  assert.equal(TrackCore.normalizeTrackId(' Alpine '), 'alpine');
  assert.equal(TrackCore.normalizeTrackId('moon'), 'lunar');
  assert.equal(TrackCore.normalizeTrackId('../../harbor'), 'backyard');
  assert.equal(TrackCore.getTrack('snow').id, 'alpine');
  assert.equal(TrackCore.getTrack('unknown').id, TrackCore.DEFAULT_TRACK);
});

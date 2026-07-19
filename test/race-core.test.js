'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Race = require('../public/js/race-core');

test('normalizes lap counts and formats arcade race times', () => {
  assert.equal(Race.normalizeLapCount('3'), 3);
  assert.equal(Race.normalizeLapCount('99'), 9);
  assert.equal(Race.normalizeLapCount('bad'), 3);
  assert.equal(Race.formatTime(83456), '1:23.456');
  assert.equal(Race.formatTime(null), '--:--.---');
});

test('records best laps, sectors, and ghosts without overwriting slower records', () => {
  const first = Race.recordLap(null, 'harbor', 42000, [10000, 11000, 9000, 12000], {
    vehicle: 'rally',
    samples: [
      { t: 0, x: 0, y: 0, z: 0, ry: 0 },
      { t: 100, x: 1, y: 0, z: 0, ry: 0 },
    ],
  });
  assert.equal(first.isPersonalBest, true);
  assert.equal(first.save.bestLaps.harbor, 42000);
  assert.equal(first.save.ghosts.harbor.vehicle, 'rally');

  const slower = Race.recordLap(first.save, 'harbor', 45000, [9000, 12000], {
    vehicle: 'truck',
    samples: [
      { t: 0, x: 0, y: 0, z: 0, ry: 0 },
      { t: 100, x: 2, y: 0, z: 0, ry: 0 },
    ],
  });
  assert.equal(slower.isPersonalBest, false);
  assert.equal(slower.save.bestLaps.harbor, 42000);
  assert.equal(slower.save.ghosts.harbor.vehicle, 'rally');
  assert.deepEqual(slower.save.sectorBests.harbor.slice(0, 2), [9000, 11000]);
});

test('ranks finished racers first and active racers by lap progress', () => {
  const ranked = Race.rankRacers([
    { id: 'local', completedLaps: 1, progress: 0.2 },
    { id: 'ahead', completedLaps: 1, progress: 0.8 },
    { id: 'finished', completedLaps: 3, progress: 0, finished: true, finishTime: 90000 },
  ]);
  assert.deepEqual(ranked.map(({ id }) => id), ['finished', 'ahead', 'local']);
  assert.deepEqual(ranked.map(({ position }) => position), [1, 2, 3]);
});

test('interpolates ghost position and wrapped yaw', () => {
  const ghost = Race.interpolateGhost([
    { t: 0, x: 0, y: 0, z: 0, ry: Math.PI - 0.1 },
    { t: 100, x: 2, y: 1, z: 4, ry: -Math.PI + 0.1 },
  ], 50);
  assert.deepEqual({ x: ghost.x, y: ghost.y, z: ghost.z }, { x: 1, y: 0.5, z: 2 });
  assert.ok(Math.abs(Math.abs(ghost.ry) - Math.PI) < 0.01);
  assert.equal(Race.interpolateGhost([], 0), null);
});

test('rejects stale race revisions and completed attempts across data channels', () => {
  const finished = { attempt: 100, revision: 4, finished: true };
  assert.equal(Race.shouldAcceptRaceState(null, finished), true);
  assert.equal(
    Race.shouldAcceptRaceState({ attempt: 100, revision: 4 }, {
      attempt: 100,
      revision: 3,
      finished: false,
    }),
    false
  );
  assert.equal(
    Race.shouldAcceptRaceState({ attempt: 101, revision: 0 }, finished),
    false
  );
  assert.equal(
    Race.shouldAcceptRaceState({ attempt: 100, revision: 4 }, {
      attempt: 101,
      revision: 0,
    }),
    true
  );
});

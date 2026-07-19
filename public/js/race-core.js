(function exposeRaceCore(root, factory) {
  'use strict';

  const core = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  } else {
    root.XRRCRaceCore = core;
  }
})(typeof window === 'undefined' ? globalThis : window, function createRaceCore() {
  'use strict';

  const SAVE_VERSION = 1;

  function clamp(value, minimum, maximum) {
    const number = Number.isFinite(value) ? value : minimum;
    return Math.max(minimum, Math.min(maximum, number));
  }

  function normalizeLapCount(value, fallback = 3) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? clamp(parsed, 1, 9) : fallback;
  }

  function formatTime(milliseconds, placeholder = '--:--.---') {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return placeholder;
    const total = Math.round(milliseconds);
    const minutes = Math.floor(total / 60000);
    const seconds = Math.floor((total % 60000) / 1000);
    const millis = total % 1000;
    return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }

  function emptySave() {
    return {
      bestLaps: {},
      ghosts: {},
      sectorBests: {},
      version: SAVE_VERSION,
    };
  }

  function parseSave(value) {
    if (!value) return emptySave();
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      if (!parsed || typeof parsed !== 'object') return emptySave();
      return {
        bestLaps: parsed.bestLaps && typeof parsed.bestLaps === 'object'
          ? { ...parsed.bestLaps }
          : {},
        ghosts: parsed.ghosts && typeof parsed.ghosts === 'object'
          ? { ...parsed.ghosts }
          : {},
        sectorBests: parsed.sectorBests && typeof parsed.sectorBests === 'object'
          ? { ...parsed.sectorBests }
          : {},
        version: SAVE_VERSION,
      };
    } catch {
      return emptySave();
    }
  }

  function recordLap(saveValue, trackId, lapTime, sectorTimes, ghost) {
    const save = parseSave(saveValue);
    const track = String(trackId || 'backyard');
    const time = Number(lapTime);
    if (!Number.isFinite(time) || time <= 0) {
      throw new TypeError('lapTime must be a positive finite number');
    }
    const previousBest = Number(save.bestLaps[track]);
    const isPersonalBest = !Number.isFinite(previousBest) || time < previousBest;
    if (isPersonalBest) {
      save.bestLaps[track] = time;
      if (ghost && Array.isArray(ghost.samples) && ghost.samples.length >= 2) {
        save.ghosts[track] = {
          samples: ghost.samples.map((sample) => ({ ...sample })),
          vehicle: String(ghost.vehicle || 'rally'),
        };
      }
    }
    const sectors = Array.isArray(sectorTimes) ? sectorTimes : [];
    const bestSectors = Array.isArray(save.sectorBests[track])
      ? [...save.sectorBests[track]]
      : [];
    sectors.forEach((sector, index) => {
      if (!Number.isFinite(sector) || sector <= 0) return;
      if (!Number.isFinite(bestSectors[index]) || sector < bestSectors[index]) {
        bestSectors[index] = sector;
      }
    });
    save.sectorBests[track] = bestSectors;
    return {
      delta: Number.isFinite(previousBest) ? time - previousBest : null,
      isPersonalBest,
      previousBest: Number.isFinite(previousBest) ? previousBest : null,
      save,
    };
  }

  function rankRacers(racers) {
    return [...(racers || [])]
      .sort((a, b) => {
        if (Boolean(a.finished) !== Boolean(b.finished)) return a.finished ? -1 : 1;
        if (a.finished && b.finished) {
          const aTime = Number.isFinite(a.finishTime) ? Math.max(0, a.finishTime) : Infinity;
          const bTime = Number.isFinite(b.finishTime) ? Math.max(0, b.finishTime) : Infinity;
          return aTime - bTime;
        }
        const aScore = clamp(a.completedLaps, 0, 99) + clamp(a.progress, 0, 0.999999);
        const bScore = clamp(b.completedLaps, 0, 99) + clamp(b.progress, 0, 0.999999);
        return bScore - aScore;
      })
      .map((racer, index) => ({ ...racer, position: index + 1 }));
  }

  function interpolateAngle(from, to, amount) {
    let delta = to - from;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    return from + delta * amount;
  }

  function interpolateGhost(samples, elapsed) {
    if (!Array.isArray(samples) || samples.length < 2 || !Number.isFinite(elapsed)) return null;
    if (elapsed < samples[0].t || elapsed > samples[samples.length - 1].t) return null;
    let low = 0;
    let high = samples.length - 1;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (samples[middle].t <= elapsed) low = middle;
      else high = middle;
    }
    const from = samples[low];
    const to = samples[high];
    const span = Math.max(1, to.t - from.t);
    const amount = clamp((elapsed - from.t) / span, 0, 1);
    return {
      ry: interpolateAngle(from.ry, to.ry, amount),
      x: from.x + (to.x - from.x) * amount,
      y: from.y + (to.y - from.y) * amount,
      z: from.z + (to.z - from.z) * amount,
    };
  }

  function shouldAcceptRaceState(lastVersion, state) {
    if (!state || typeof state !== 'object') return false;
    const attempt = Number.isFinite(state.attempt)
      ? Math.max(0, Math.floor(state.attempt))
      : 0;
    const revision = Number.isFinite(state.revision)
      ? Math.max(0, Math.floor(state.revision))
      : 0;
    if (!lastVersion) return true;
    if (attempt !== lastVersion.attempt) return attempt > lastVersion.attempt;
    return revision >= lastVersion.revision;
  }

  return Object.freeze({
    SAVE_VERSION,
    emptySave,
    formatTime,
    interpolateGhost,
    normalizeLapCount,
    parseSave,
    rankRacers,
    recordLap,
    shouldAcceptRaceState,
  });
});

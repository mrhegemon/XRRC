'use strict';

// Minimal Node port of the pieces of THREE.CatmullRomCurve3 the circuit
// validator needs, so track geometry can be checked without a browser.
// Mirrors three/src/extras/curves/CatmullRomCurve3.js (centripetal + closed)
// including the arc-length reparameterisation used by getPointAt().

class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  distanceToSquared(v) {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    const dz = this.z - v.z;
    return dx * dx + dy * dy + dz * dz;
  }

  distanceTo(v) {
    return Math.sqrt(this.distanceToSquared(v));
  }
}

class CubicPoly {
  constructor() {
    this.c0 = 0;
    this.c1 = 0;
    this.c2 = 0;
    this.c3 = 0;
  }

  init(x0, x1, t0, t1) {
    this.c0 = x0;
    this.c1 = t0;
    this.c2 = -3 * x0 + 3 * x1 - 2 * t0 - t1;
    this.c3 = 2 * x0 - 2 * x1 + t0 + t1;
  }

  initNonuniformCatmullRom(x0, x1, x2, x3, dt0, dt1, dt2) {
    let t1 = (x1 - x0) / dt0 - (x2 - x0) / (dt0 + dt1) + (x2 - x1) / dt1;
    let t2 = (x2 - x1) / dt1 - (x3 - x1) / (dt1 + dt2) + (x3 - x2) / dt2;
    t1 *= dt1;
    t2 *= dt1;
    this.init(x1, x2, t1, t2);
  }

  calc(t) {
    const t2 = t * t;
    const t3 = t2 * t;
    return this.c0 + this.c1 * t + this.c2 * t2 + this.c3 * t3;
  }
}

class CatmullRomCurve3 {
  constructor(points = [], closed = false, curveType = 'centripetal', tension = 0.5) {
    this.points = points;
    this.closed = closed;
    this.curveType = curveType;
    this.tension = tension;
    this.arcLengthDivisions = 200;
    this._cacheArcLengths = null;
    this._px = new CubicPoly();
    this._py = new CubicPoly();
    this._pz = new CubicPoly();
  }

  getPoint(t, optionalTarget = new Vector3()) {
    const point = optionalTarget;
    const points = this.points;
    const l = points.length;
    const p = (l - (this.closed ? 0 : 1)) * t;
    let intPoint = Math.floor(p);
    let weight = p - intPoint;

    if (this.closed) {
      intPoint += intPoint > 0 ? 0 : (Math.floor(Math.abs(intPoint) / l) + 1) * l;
    } else if (weight === 0 && intPoint === l - 1) {
      intPoint = l - 2;
      weight = 1;
    }

    let p0;
    let p3;
    if (this.closed || intPoint > 0) {
      p0 = points[(intPoint - 1) % l];
    } else {
      p0 = new Vector3(
        2 * points[0].x - points[1].x,
        2 * points[0].y - points[1].y,
        2 * points[0].z - points[1].z
      );
    }

    const p1 = points[intPoint % l];
    const p2 = points[(intPoint + 1) % l];

    if (this.closed || intPoint + 2 < l) {
      p3 = points[(intPoint + 2) % l];
    } else {
      p3 = new Vector3(
        2 * points[l - 1].x - points[l - 2].x,
        2 * points[l - 1].y - points[l - 2].y,
        2 * points[l - 1].z - points[l - 2].z
      );
    }

    if (this.curveType === 'centripetal' || this.curveType === 'chordal') {
      const pow = this.curveType === 'chordal' ? 0.5 : 0.25;
      let dt0 = Math.pow(p0.distanceToSquared(p1), pow);
      let dt1 = Math.pow(p1.distanceToSquared(p2), pow);
      let dt2 = Math.pow(p2.distanceToSquared(p3), pow);

      if (dt1 < 1e-4) dt1 = 1.0;
      if (dt0 < 1e-4) dt0 = dt1;
      if (dt2 < 1e-4) dt2 = dt1;

      this._px.initNonuniformCatmullRom(p0.x, p1.x, p2.x, p3.x, dt0, dt1, dt2);
      this._py.initNonuniformCatmullRom(p0.y, p1.y, p2.y, p3.y, dt0, dt1, dt2);
      this._pz.initNonuniformCatmullRom(p0.z, p1.z, p2.z, p3.z, dt0, dt1, dt2);
    } else if (this.curveType === 'catmullrom') {
      this._px.initCatmullRom(p0.x, p1.x, p2.x, p3.x, this.tension);
      this._py.initCatmullRom(p0.y, p1.y, p2.y, p3.y, this.tension);
      this._pz.initCatmullRom(p0.z, p1.z, p2.z, p3.z, this.tension);
    }

    point.x = this._px.calc(weight);
    point.y = this._py.calc(weight);
    point.z = this._pz.calc(weight);
    return point;
  }

  getLengths(divisions = this.arcLengthDivisions) {
    if (this._cacheArcLengths && this._cacheArcLengths.length === divisions + 1) {
      return this._cacheArcLengths;
    }
    const cache = [0];
    let last = this.getPoint(0, new Vector3());
    let sum = 0;
    for (let p = 1; p <= divisions; p += 1) {
      const current = this.getPoint(p / divisions, new Vector3());
      sum += current.distanceTo(last);
      cache.push(sum);
      last = current;
    }
    this._cacheArcLengths = cache;
    return cache;
  }

  getUtoTmapping(u, distance = null) {
    const arcLengths = this.getLengths();
    const il = arcLengths.length;
    const targetArcLength = distance === null ? u * arcLengths[il - 1] : distance;

    let low = 0;
    let high = il - 1;
    let comparison;
    let i = 0;
    while (low <= high) {
      i = Math.floor(low + (high - low) / 2);
      comparison = arcLengths[i] - targetArcLength;
      if (comparison < 0) {
        low = i + 1;
      } else if (comparison > 0) {
        high = i - 1;
      } else {
        high = i;
        break;
      }
    }
    i = high;
    if (arcLengths[i] === targetArcLength) return i / (il - 1);

    const lengthBefore = arcLengths[i];
    const lengthAfter = arcLengths[i + 1];
    const segmentLength = lengthAfter - lengthBefore;
    const segmentFraction = (targetArcLength - lengthBefore) / segmentLength;
    return (i + segmentFraction) / (il - 1);
  }

  getPointAt(u, optionalTarget = new Vector3()) {
    return this.getPoint(this.getUtoTmapping(u), optionalTarget);
  }
}

module.exports = { CatmullRomCurve3, Vector3 };

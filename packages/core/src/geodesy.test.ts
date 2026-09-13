import { describe, expect, it } from 'vitest';
import {
  TangentPlane,
  crossTrackDistance,
  destinationPoint,
  haversineDistance,
  initialBearing,
  vincentyDistance,
} from './geodesy.js';
import { nauticalMiles, toDegrees, toNauticalMiles } from './units.js';

const SINGAPORE = { lat: 1.2644, lon: 103.8402 };

describe('haversineDistance', () => {
  it('measures one minute of latitude as about one nautical mile', () => {
    const d = haversineDistance({ lat: 0, lon: 0 }, { lat: 1 / 60, lon: 0 });
    expect(toNauticalMiles(d)).toBeCloseTo(1, 2);
  });

  it('is zero for identical points', () => {
    expect(haversineDistance(SINGAPORE, SINGAPORE)).toBe(0);
  });
});

describe('initialBearing', () => {
  it('reads 090 due east', () => {
    expect(toDegrees(initialBearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }))).toBeCloseTo(90, 4);
  });

  it('reads 000 due north', () => {
    expect(toDegrees(initialBearing({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }))).toBeCloseTo(0, 4);
  });
});

describe('destinationPoint', () => {
  it('round-trips with distance and bearing', () => {
    const brg = initialBearing(SINGAPORE, { lat: 1.4, lon: 104.0 });
    const dist = haversineDistance(SINGAPORE, { lat: 1.4, lon: 104.0 });
    const p = destinationPoint(SINGAPORE, brg, dist);
    expect(p.lat).toBeCloseTo(1.4, 5);
    expect(p.lon).toBeCloseTo(104.0, 5);
  });
});

describe('TangentPlane', () => {
  it('round-trips geodetic to local and back', () => {
    const plane = new TangentPlane(SINGAPORE);
    const target = { lat: 1.32, lon: 103.91 };
    const back = plane.toGeodetic(plane.toLocal(target));
    expect(back.lat).toBeCloseTo(target.lat, 9);
    expect(back.lon).toBeCloseTo(target.lon, 9);
  });

  it('agrees with the ellipsoidal geodesic to within a metre at 20 nm', () => {
    // Checked against Vincenty, not haversine: the tangent plane is built from
    // WGS84 radii of curvature, so a spherical reference would report its own
    // 0.5% model error as if it were flat-earth error.
    const plane = new TangentPlane(SINGAPORE);
    for (const bearing of [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, Math.PI]) {
      const target = destinationPoint(SINGAPORE, bearing, nauticalMiles(20));
      const local = plane.toLocal(target);
      const flat = Math.hypot(local.e, local.n);
      expect(Math.abs(flat - vincentyDistance(SINGAPORE, target))).toBeLessThan(1);
    }
  });

  it('flags positions beyond the rebase radius', () => {
    const plane = new TangentPlane(SINGAPORE);
    expect(plane.shouldRebase({ e: 10_000, n: 10_000 })).toBe(false);
    expect(plane.shouldRebase({ e: 60_000, n: 0 })).toBe(true);
  });
});

describe('vincentyDistance', () => {
  it('measures one minute of latitude as about one nautical mile', () => {
    const d = vincentyDistance({ lat: 0, lon: 0 }, { lat: 1 / 60, lon: 0 });
    expect(toNauticalMiles(d)).toBeCloseTo(0.9946, 3); // shorter near the equator
  });

  it('returns zero for coincident points', () => {
    expect(vincentyDistance(SINGAPORE, SINGAPORE)).toBe(0);
  });

  it('stays within 0.5% of the spherical approximation', () => {
    const far = { lat: 22.3, lon: 114.17 }; // Hong Kong
    const v = vincentyDistance(SINGAPORE, far);
    const h = haversineDistance(SINGAPORE, far);
    expect(Math.abs(v - h) / v).toBeLessThan(0.005);
  });
});

describe('crossTrackDistance', () => {
  it('is positive to starboard of a northbound leg', () => {
    const xte = crossTrackDistance({ lat: 0.5, lon: 0.01 }, { lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(xte).toBeGreaterThan(0);
  });

  it('is near zero on the leg', () => {
    const xte = crossTrackDistance({ lat: 0.5, lon: 0 }, { lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(Math.abs(xte)).toBeLessThan(1);
  });
});

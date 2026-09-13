import {
  type Degrees,
  type Metres,
  type Radians,
  DEG_TO_RAD,
  RAD_TO_DEG,
  wrapAngle,
} from './units.js';

/** WGS84 ellipsoid. */
export const WGS84 = {
  /** Semi-major axis, metres. */
  a: 6378137.0,
  /** Flattening. */
  f: 1 / 298.257223563,
  get b(): number {
    return this.a * (1 - this.f);
  },
  /** First eccentricity squared. */
  get e2(): number {
    return this.f * (2 - this.f);
  },
} as const;

/** A geodetic position. Degrees on WGS84; the only non-SI type in the system. */
export interface LatLon {
  readonly lat: Degrees;
  readonly lon: Degrees;
}

/** A position in a local East-North-Up tangent plane, metres. */
export interface LocalPosition {
  /** East, metres. */
  readonly e: Metres;
  /** North, metres. */
  readonly n: Metres;
}

/**
 * A local tangent plane anchored at a geodetic origin.
 *
 * Vessel dynamics are integrated in a flat Cartesian frame because the
 * hydrodynamic equations are written in body/inertial axes, not on an
 * ellipsoid. Error grows with distance from the origin, so the simulation
 * rebases the frame when own-ship strays past `rebaseRadius` (see
 * `shouldRebase`). At 50 km the flat-earth error is well under a metre,
 * which is far below the fidelity of the motion model itself.
 */
export class TangentPlane {
  readonly origin: LatLon;
  /** Metres per degree of latitude at the origin. */
  private readonly mPerDegLat: number;
  /** Metres per degree of longitude at the origin. */
  private readonly mPerDegLon: number;

  constructor(origin: LatLon) {
    this.origin = origin;
    const phi = origin.lat * DEG_TO_RAD;
    const sinPhi = Math.sin(phi);
    const denom = 1 - WGS84.e2 * sinPhi * sinPhi;
    // Meridional and prime-vertical radii of curvature at the origin latitude.
    const rMeridional = (WGS84.a * (1 - WGS84.e2)) / Math.pow(denom, 1.5);
    const rNormal = WGS84.a / Math.sqrt(denom);
    this.mPerDegLat = rMeridional * DEG_TO_RAD;
    this.mPerDegLon = rNormal * Math.cos(phi) * DEG_TO_RAD;
  }

  toLocal(p: LatLon): LocalPosition {
    return {
      e: (p.lon - this.origin.lon) * this.mPerDegLon,
      n: (p.lat - this.origin.lat) * this.mPerDegLat,
    };
  }

  toGeodetic(p: LocalPosition): LatLon {
    return {
      lat: this.origin.lat + p.n / this.mPerDegLat,
      lon: this.origin.lon + p.e / this.mPerDegLon,
    };
  }

  /** True when a local position is far enough out that the frame should be re-anchored. */
  shouldRebase(p: LocalPosition, rebaseRadius: Metres = 50_000): boolean {
    return Math.hypot(p.e, p.n) > rebaseRadius;
  }
}

const MEAN_EARTH_RADIUS: Metres = 6_371_008.8;

/**
 * Great-circle distance on a sphere, metres.
 *
 * Fast, and fine for coarse work such as spatial binning or a first-pass
 * range filter. It is a spherical model, so it disagrees with the true
 * ellipsoidal distance by up to about 0.5% - around 90 m in 20 nautical miles.
 * Anything a navigator or a guidance loop reads should use
 * `vincentyDistance` instead.
 */
export function haversineDistance(a: LatLon, b: LatLon): Metres {
  const phi1 = a.lat * DEG_TO_RAD;
  const phi2 = b.lat * DEG_TO_RAD;
  const dPhi = phi2 - phi1;
  const dLam = (b.lon - a.lon) * DEG_TO_RAD;
  const h =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
  return 2 * MEAN_EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from `a` to `b`, radians clockwise from true north. */
export function initialBearing(a: LatLon, b: LatLon): Radians {
  const phi1 = a.lat * DEG_TO_RAD;
  const phi2 = b.lat * DEG_TO_RAD;
  const dLam = (b.lon - a.lon) * DEG_TO_RAD;
  const y = Math.sin(dLam) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLam);
  return wrapAngle(Math.atan2(y, x));
}

/** Position reached by travelling `distance` along `bearing` from `start`. */
export function destinationPoint(start: LatLon, bearing: Radians, distance: Metres): LatLon {
  const delta = distance / MEAN_EARTH_RADIUS;
  const phi1 = start.lat * DEG_TO_RAD;
  const lam1 = start.lon * DEG_TO_RAD;
  const sinPhi2 =
    Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(bearing);
  const phi2 = Math.asin(sinPhi2);
  const lam2 =
    lam1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(delta) * Math.cos(phi1),
      Math.cos(delta) - Math.sin(phi1) * sinPhi2,
    );
  return { lat: phi2 * RAD_TO_DEG, lon: ((lam2 * RAD_TO_DEG + 540) % 360) - 180 };
}

/**
 * Cross-track distance of `p` from the great-circle leg `a`->`b`, metres.
 * Positive means `p` lies to starboard of the leg. Used by track-keeping guidance.
 */
export function crossTrackDistance(p: LatLon, a: LatLon, b: LatLon): Metres {
  const d13 = haversineDistance(a, p) / MEAN_EARTH_RADIUS;
  const brg13 = initialBearing(a, p);
  const brg12 = initialBearing(a, b);
  return Math.asin(Math.sin(d13) * Math.sin(brg13 - brg12)) * MEAN_EARTH_RADIUS;
}

/** Along-track distance from `a` toward `b` of the projection of `p`, metres. */
export function alongTrackDistance(p: LatLon, a: LatLon, b: LatLon): Metres {
  const d13 = haversineDistance(a, p) / MEAN_EARTH_RADIUS;
  const xt = crossTrackDistance(p, a, b) / MEAN_EARTH_RADIUS;
  return Math.acos(Math.min(1, Math.cos(d13) / Math.cos(xt))) * MEAN_EARTH_RADIUS;
}

/** Web Mercator projection, for handing positions to the map renderer. */
export function toWebMercator(p: LatLon): { x: number; y: number } {
  const x = WGS84.a * p.lon * DEG_TO_RAD;
  const phi = Math.max(-85.05112878, Math.min(85.05112878, p.lat)) * DEG_TO_RAD;
  return { x, y: WGS84.a * Math.log(Math.tan(Math.PI / 4 + phi / 2)) };
}


/**
 * Geodesic distance on the WGS84 ellipsoid (Vincenty inverse), metres.
 *
 * Sub-millimetre accuracy, and the reference every other distance in the
 * system is judged against. Iterative, so it is roughly an order of magnitude
 * slower than the haversine formula: use it for displayed ranges, chart
 * measurements and validation, not inside a per-frame loop over every contact.
 *
 * Returns `NaN` for near-antipodal points, where the algorithm does not
 * converge - a case that cannot arise within a single simulated area.
 */
export function vincentyDistance(p1: LatLon, p2: LatLon): Metres {
  const { a, f } = WGS84;
  const b = a * (1 - f);
  const L = (p2.lon - p1.lon) * DEG_TO_RAD;
  const U1 = Math.atan((1 - f) * Math.tan(p1.lat * DEG_TO_RAD));
  const U2 = Math.atan((1 - f) * Math.tan(p2.lat * DEG_TO_RAD));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cos2SigmaM = 0;
  let cosSqAlpha = 0;

  for (let i = 0; i < 200; i++) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2,
    );
    if (sinSigma === 0) return 0; // coincident points
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    const C = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    const prev = lambda;
    lambda =
      L +
      (1 - C) *
        f *
        sinAlpha *
        (sigma +
          C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - prev) < 1e-12) {
      const uSq = (cosSqAlpha * (a * a - b * b)) / (b * b);
      const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
      const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
      const deltaSigma =
        B *
        sinSigma *
        (cos2SigmaM +
          (B / 4) *
            (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
              (B / 6) *
                cos2SigmaM *
                (-3 + 4 * sinSigma * sinSigma) *
                (-3 + 4 * cos2SigmaM * cos2SigmaM)));
      return b * A * (sigma - deltaSigma);
    }
  }
  return Number.NaN; // near-antipodal, did not converge
}

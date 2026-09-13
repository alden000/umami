/**
 * Canonical units for the whole system.
 *
 * RULE: every value crossing a package boundary is in SI base units
 * (metres, seconds, radians, kilograms) with the sole exception of
 * geodetic positions, which are decimal degrees on WGS84.
 *
 * Marine-facing units (knots, nautical miles, degrees) exist only at the
 * edges: the UI, the AIS wire format and scenario files. Convert on the way
 * in and on the way out, never in the middle.
 */

/** Metres. */
export type Metres = number;
/** Metres per second. */
export type MetresPerSecond = number;
/** Radians. */
export type Radians = number;
/** Radians per second. */
export type RadiansPerSecond = number;
/** Seconds. */
export type Seconds = number;
/** Kilograms. */
export type Kilograms = number;
/** Newtons. */
export type Newtons = number;
/** Newton-metres. */
export type NewtonMetres = number;
/** Decimal degrees, WGS84. */
export type Degrees = number;

export const KNOTS_TO_MS = 0.514444;
export const MS_TO_KNOTS = 1 / KNOTS_TO_MS;
export const NM_TO_M = 1852;
export const M_TO_NM = 1 / NM_TO_M;
export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

export const knots = (v: number): MetresPerSecond => v * KNOTS_TO_MS;
export const toKnots = (v: MetresPerSecond): number => v * MS_TO_KNOTS;
export const nauticalMiles = (v: number): Metres => v * NM_TO_M;
export const toNauticalMiles = (v: Metres): number => v * M_TO_NM;
export const degrees = (v: number): Radians => v * DEG_TO_RAD;
export const toDegrees = (v: Radians): number => v * RAD_TO_DEG;

/** Wrap an angle to [0, 2*pi). Use for headings and bearings. */
export function wrapAngle(a: Radians): Radians {
  const t = a % (2 * Math.PI);
  return t < 0 ? t + 2 * Math.PI : t;
}

/** Wrap an angle to (-pi, pi]. Use for heading *errors*. */
export function wrapAngleSigned(a: Radians): Radians {
  const t = wrapAngle(a);
  return t > Math.PI ? t - 2 * Math.PI : t;
}

/** Wrap a compass value to [0, 360). */
export function wrapDegrees(a: Degrees): Degrees {
  const t = a % 360;
  return t < 0 ? t + 360 : t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Move `current` toward `target` by at most `maxDelta`. Actuator rate limiting. */
export function rateLimit(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (d > maxDelta) return current + maxDelta;
  if (d < -maxDelta) return current - maxDelta;
  return target;
}

/** Rate-limit an angle, taking the short way round. */
export function rateLimitAngle(current: Radians, target: Radians, maxDelta: number): Radians {
  const err = wrapAngleSigned(target - current);
  return wrapAngle(current + clamp(err, -maxDelta, maxDelta));
}

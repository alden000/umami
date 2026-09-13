import {
  haversineDistance,
  initialBearing,
  wrapAngle,
  wrapAngleSigned,
  type LatLon,
  type Metres,
  type MetresPerSecond,
  type Radians,
  type Seconds,
} from '@umami/core';

export interface KinematicTarget {
  readonly position: LatLon;
  readonly cog: Radians;
  readonly sog: MetresPerSecond;
}

export interface CpaResult {
  /** Closest point of approach, metres. */
  readonly cpa: Metres;
  /** Time to CPA, seconds. Negative when the CPA is already past. */
  readonly tcpa: Seconds;
  /** Present range, metres. */
  readonly range: Metres;
  /** Present bearing from own vessel to the target, radians. */
  readonly bearing: Radians;
  /** Bearing of own vessel as seen from the target, radians. */
  readonly relativeBearing: Radians;
  /** True when range is closing. */
  readonly closing: boolean;
}

/**
 * Closest point of approach on a flat local approximation.
 *
 * Both vessels are treated as moving in straight lines at constant speed,
 * which is the same assumption an ARPA makes and the same one that makes CPA
 * meaningful at all. Over the few minutes that matter for an encounter the
 * flat-earth error is negligible compared with the error in assuming neither
 * vessel manoeuvres.
 */
export function computeCpa(own: KinematicTarget, target: KinematicTarget): CpaResult {
  const range = haversineDistance(own.position, target.position);
  const bearing = initialBearing(own.position, target.position);

  // Relative position in a local north-east frame centred on own vessel.
  const rx = range * Math.sin(bearing); // east
  const ry = range * Math.cos(bearing); // north

  // Relative velocity, target minus own.
  const vx = target.sog * Math.sin(target.cog) - own.sog * Math.sin(own.cog);
  const vy = target.sog * Math.cos(target.cog) - own.sog * Math.cos(own.cog);
  const vSquared = vx * vx + vy * vy;

  const relativeBearing = wrapAngle(initialBearing(target.position, own.position) - target.cog);

  if (vSquared < 1e-9) {
    // No relative motion: range holds indefinitely.
    return { cpa: range, tcpa: 0, range, bearing, relativeBearing, closing: false };
  }

  const tcpa = -(rx * vx + ry * vy) / vSquared;
  const cx = rx + vx * tcpa;
  const cy = ry + vy * tcpa;

  return {
    cpa: Math.hypot(cx, cy),
    tcpa,
    range,
    bearing,
    relativeBearing,
    closing: rx * vx + ry * vy < 0,
  };
}

/** Encounter geometry under the collision regulations. */
export type EncounterType = 'head-on' | 'crossing-give-way' | 'crossing-stand-on' | 'overtaking' | 'being-overtaken' | 'none';

/**
 * Classify an encounter by the geometry the collision regulations use.
 *
 * Rules 13 to 15 are defined by relative bearing and heading difference, not
 * by who is closer: a vessel approaching within about 5 degrees of reciprocal
 * is head-on (Rule 14); one approaching from more than 22.5 degrees abaft the
 * beam is overtaking (Rule 13); otherwise it is crossing (Rule 15) and the
 * vessel with the other on its own starboard side gives way.
 *
 * This is provided so scenarios can be *labelled* and results scored, not to
 * decide what a USV should do. Determining risk of collision, and what action
 * to take, is the algorithm under test.
 */
export function classifyEncounter(
  own: KinematicTarget,
  target: KinematicTarget,
  cpa: CpaResult,
): EncounterType {
  if (!cpa.closing) return 'none';

  // Bearing of the target relative to own heading.
  const relative = wrapAngleSigned(cpa.bearing - own.cog);
  const headingDifference = Math.abs(wrapAngleSigned(target.cog - own.cog));
  const abaftTheBeam = (22.5 * Math.PI) / 180 + Math.PI / 2;

  // Reciprocal courses and nearly dead ahead: head-on, both alter to starboard.
  if (headingDifference > Math.PI - 0.15 && Math.abs(relative) < 0.15) return 'head-on';

  // Own vessel overtaking: target ahead, similar course, own vessel faster.
  if (headingDifference < (67.5 * Math.PI) / 180 && Math.abs(relative) < abaftTheBeam) {
    if (own.sog > target.sog * 1.05 && Math.abs(relative) < Math.PI / 2) return 'overtaking';
  }

  // Being overtaken: target coming up from abaft own beam on a similar course.
  if (headingDifference < (67.5 * Math.PI) / 180 && Math.abs(relative) > abaftTheBeam) {
    if (target.sog > own.sog * 1.05) return 'being-overtaken';
  }

  // Crossing: the vessel with the other on its starboard bow gives way.
  return relative > 0 && relative < abaftTheBeam ? 'crossing-give-way' : 'crossing-stand-on';
}

export interface CollisionRiskOptions {
  /** CPA below this counts as a close-quarters situation, metres. */
  readonly cpaThreshold?: Metres;
  /** Only alert when the CPA is within this many seconds. */
  readonly tcpaThreshold?: Seconds;
}

export interface RiskAssessment extends CpaResult {
  readonly encounter: EncounterType;
  readonly dangerous: boolean;
}

export function assessRisk(
  own: KinematicTarget,
  target: KinematicTarget,
  opts: CollisionRiskOptions = {},
): RiskAssessment {
  const cpaThreshold = opts.cpaThreshold ?? 926; // 0.5 nm
  const tcpaThreshold = opts.tcpaThreshold ?? 900; // 15 minutes
  const cpa = computeCpa(own, target);
  return {
    ...cpa,
    encounter: classifyEncounter(own, target, cpa),
    dangerous: cpa.closing && cpa.cpa < cpaThreshold && cpa.tcpa > 0 && cpa.tcpa < tcpaThreshold,
  };
}

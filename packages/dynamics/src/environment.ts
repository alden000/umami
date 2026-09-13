import { wrapAngleSigned, type MetresPerSecond, type Radians } from '@umami/core';
import { AIR_DENSITY } from './hull.js';
import type { BodyForce, BodyVelocity, HullParticulars, RigidBodyState } from './types.js';

export interface WindField {
  /** Direction the wind is blowing *from*, radians clockwise from true north. */
  readonly fromRadians: Radians;
  /** True wind speed, m/s. */
  readonly speed: MetresPerSecond;
}

export const NO_WIND: WindField = { fromRadians: 0, speed: 0 };

export interface SeaState {
  /** Significant wave height, metres. */
  readonly significantWaveHeight: number;
  /** Mean wave direction, radians clockwise from true north, direction waves travel toward. */
  readonly directionRadians: Radians;
  /** Peak period, seconds. */
  readonly peakPeriod: number;
}

export const CALM_SEA: SeaState = {
  significantWaveHeight: 0,
  directionRadians: 0,
  peakPeriod: 8,
};

/** Above-water areas, estimated from particulars when not supplied. */
export interface WindageAreas {
  readonly frontal: number;
  readonly lateral: number;
  /** Longitudinal position of the centre of the lateral area, metres forward of CG. */
  readonly centroidX: number;
}

export function estimateWindage(p: HullParticulars): WindageAreas {
  const L = p.loa;
  // Freeboard plus superstructure, crudely scaled off draught and beam.
  const effectiveHeight = Math.max(1.2, 0.55 * p.draught + 0.18 * p.beam);
  return {
    frontal: p.beam * effectiveHeight,
    lateral: L * effectiveHeight * 0.85,
    // Superstructure is usually aft of amidships on merchant ships.
    centroidX: -0.05 * L,
  };
}

/**
 * Wind force on the above-water body.
 *
 * A harmonic approximation of the Blendermann coefficients: axial force varies
 * as cos of the apparent wind angle, lateral as sin, and the yawing moment as
 * sin of twice the angle, which puts the peak moment near 45 degrees off the
 * bow where it actually sits. Good enough to make a lightly loaded, high-sided
 * vessel behave like one; not a substitute for measured coefficients.
 */
export function windForce(
  state: RigidBodyState,
  wind: WindField,
  areas: WindageAreas,
  loa: number,
  airDensity = AIR_DENSITY,
): BodyForce {
  if (wind.speed <= 0) return { X: 0, Y: 0, N: 0 };

  // True wind velocity in the inertial frame; `fromRadians` is the direction
  // it blows from, so the velocity vector points the opposite way.
  const towards = wind.fromRadians + Math.PI;
  const wn = wind.speed * Math.cos(towards);
  const we = wind.speed * Math.sin(towards);

  // Vessel velocity in the inertial frame.
  const c = Math.cos(state.heading);
  const s = Math.sin(state.heading);
  const vn = state.u * c - state.v * s;
  const ve = state.u * s + state.v * c;

  // Apparent wind in the body frame.
  const rn = wn - vn;
  const re = we - ve;
  const ax = rn * c + re * s;
  const ay = -rn * s + re * c;
  const apparentSpeed = Math.hypot(ax, ay);
  if (apparentSpeed < 1e-3) return { X: 0, Y: 0, N: 0 };

  // Angle of the apparent wind relative to the bow.
  const gamma = wrapAngleSigned(Math.atan2(ay, ax));
  const q = 0.5 * airDensity * apparentSpeed * apparentSpeed;

  const cx = 0.7;
  const cy = 0.9;
  const cn = 0.12;

  return {
    X: q * areas.frontal * cx * Math.cos(gamma),
    Y: q * areas.lateral * cy * Math.sin(gamma),
    N: q * areas.lateral * loa * cn * Math.sin(2 * gamma) + areas.centroidX * q * areas.lateral * cy * Math.sin(gamma),
  };
}

/**
 * Second-order wave drift force.
 *
 * Only the slowly varying mean drift is applied to the planar motion, because
 * first-order oscillatory surge, sway and yaw average to nothing over a wave
 * period and would otherwise just add noise a controller must filter out.
 * First-order motion is reported separately by `seakeepingMotion` for display.
 */
export function waveDriftForce(
  state: RigidBodyState,
  sea: SeaState,
  areas: { readonly lateral: number },
  loa: number,
  waterDensity = 1025,
): BodyForce {
  if (sea.significantWaveHeight <= 0) return { X: 0, Y: 0, N: 0 };

  const relative = wrapAngleSigned(sea.directionRadians - state.heading);
  // Mean drift scales with the square of wave height and with waterline length.
  const magnitude =
    0.5 * waterDensity * 9.81 * (sea.significantWaveHeight / 2) ** 2 * loa * 0.02;

  return {
    X: magnitude * Math.cos(relative),
    Y: magnitude * Math.sin(relative) * 1.4,
    N: magnitude * loa * 0.05 * Math.sin(2 * relative),
  };
}

/**
 * Out-of-plane motion: roll, pitch and heave.
 *
 * The simulation is planar, so this is not fed back into the equations of
 * motion. It is computed because a 2D chart display wants it for a heel
 * indicator, and because the future 3D view needs somewhere to get vessel
 * attitude from without the sim core growing a six-degree-of-freedom model.
 * See `docs/adr/0007-2d-now-3d-later.md`.
 */
export interface SeakeepingMotion {
  readonly rollRadians: Radians;
  readonly pitchRadians: Radians;
  readonly heaveMetres: number;
}

export function seakeepingMotion(
  state: RigidBodyState,
  sea: SeaState,
  nu: BodyVelocity,
  loa: number,
  beam: number,
  timeSeconds: number,
): SeakeepingMotion {
  const hs = sea.significantWaveHeight;
  if (hs <= 0) {
    // Heel from the turn alone: a vessel in a hard turn heels outward.
    return { rollRadians: -0.35 * nu.r * Math.max(0, nu.u) * (beam > 0 ? 1 / beam : 0), pitchRadians: 0, heaveMetres: 0 };
  }

  const encounter = (2 * Math.PI) / Math.max(1, sea.peakPeriod);
  const relative = wrapAngleSigned(sea.directionRadians - state.heading);
  const amplitude = hs / 2;

  // Beam seas roll, head seas pitch; scale each by how much of the wave the
  // hull spans, so a long ship is less affected by short waves.
  const rollGain = Math.abs(Math.sin(relative)) * Math.min(1, (hs * 20) / Math.max(1, beam));
  const pitchGain = Math.abs(Math.cos(relative)) * Math.min(1, (hs * 40) / Math.max(1, loa));

  const phase = encounter * timeSeconds;
  return {
    rollRadians:
      0.25 * rollGain * Math.sin(phase) -
      0.35 * nu.r * Math.max(0, nu.u) * (beam > 0 ? 1 / beam : 0),
    pitchRadians: 0.08 * pitchGain * Math.sin(phase + Math.PI / 3),
    heaveMetres: amplitude * 0.6 * Math.sin(phase + Math.PI / 6),
  };
}

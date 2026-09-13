import type { MetresPerSecond, Seconds } from '@umami/core';
import { clamp, wrapAngle } from '@umami/core';
import type {
  BodyForce,
  BodyVelocity,
  HullParticulars,
  HydroCoefficients,
  RigidBodyState,
} from './types.js';

export const SEAWATER_DENSITY = 1025; // kg/m^3
export const AIR_DENSITY = 1.225; // kg/m^3

export interface DeriveOptions {
  readonly waterDensity?: number;
  /**
   * Total resistance coefficient. 0.0025 suits a large, smooth, full-form
   * hull; 0.004-0.006 is closer to a small planing or semi-displacement craft
   * where appendage and form drag dominate.
   */
  readonly totalResistanceCoefficient?: number;
  /** Cross-flow drag coefficient of the hull section. */
  readonly crossFlowDragCoefficient?: number;
  /** Radius of gyration in yaw, as a fraction of Lpp. */
  readonly yawGyradiusRatio?: number;
  /**
   * Reduce sway-yaw coupling until the hull is directionally stable.
   *
   * Set per vessel class, never globally. See `enforceDirectionalStability`:
   * it is the right call for a small, beamy, shallow-draught craft that the
   * regression has been extrapolated past, and the wrong call for a large
   * full-form merchant hull, which really is course-unstable.
   */
  readonly ensureDirectionalStability?: boolean;
}

/**
 * Estimate hydrodynamic derivatives from principal particulars.
 *
 * The linear sway/yaw derivatives use Clarke's (1983) regressions over a
 * series of hull forms; surge resistance comes from a wetted-surface estimate
 * (Denny-Mumford) and a total resistance coefficient; cross-flow terms come
 * from strip theory with a constant section drag coefficient.
 *
 * This exists so that any vessel seen on AIS - for which only length, beam and
 * a ship type are known - can be given plausible, type-appropriate motion
 * without hand-tuning. It is an estimate, not a towing-tank result. A vessel
 * that matters (own USV above all) should have its coefficients calibrated
 * against turning-circle and zig-zag trials and supplied explicitly; see
 * `docs/adr/0006-vessel-dynamics-fidelity.md`.
 */
export function deriveHydroCoefficients(
  p: HullParticulars,
  opts: DeriveOptions = {},
): HydroCoefficients {
  const rho = opts.waterDensity ?? SEAWATER_DENSITY;
  const cT = opts.totalResistanceCoefficient ?? 0.003;
  const cdCross = opts.crossFlowDragCoefficient ?? 0.9;
  const kzz = opts.yawGyradiusRatio ?? 0.25;

  const L = p.lpp ?? p.loa * 0.96;
  const B = p.beam;
  const T = p.draught;
  const Cb = p.blockCoefficient;

  const volume = Cb * L * B * T;
  const mass = p.massKg ?? rho * volume;
  const Iz = mass * (kzz * L) ** 2;

  // Denny-Mumford wetted surface.
  const wettedSurface = 1.7 * L * T + volume / T;

  // Surge resistance. The quadratic term is the real one; the linear term only
  // exists so that a vessel with the way off still slows to a stop instead of
  // coasting indefinitely. It is sized to match the quadratic term at Froude
  // 0.02 - roughly steerage way - and must stay well below service speed, or
  // it silently eats the installed power and the vessel never makes its
  // designed speed.
  const Xuu = -0.5 * rho * wettedSurface * cT;
  const steerageWay = 0.02 * Math.sqrt(9.81 * L);
  const Xu = Xuu * steerageWay;

  // Clarke (1983) non-dimensional derivatives.
  //
  // The regressions were fitted over merchant hull forms and are extrapolated
  // badly by beamy, deep, short vessels - a harbour tug at B/L 0.43 is nothing
  // like anything in the original data set, and evaluating the fit there
  // returns a *positive* yaw added-mass term, which is physically impossible
  // and makes the mass matrix indefinite. Inputs are therefore clamped to the
  // envelope the fit is valid over. The vessel's real particulars are still
  // used for mass, inertia and resistance; only the shape ratios feeding the
  // regression are limited. A hull well outside this range needs measured
  // coefficients, not a regression.
  const TL = clamp(T / L, 0.02, 0.09);
  const BL = clamp(B / L, 0.1, 0.25);
  const BT = clamp(B / T, 1.8, 6.0);
  const Cbr = clamp(Cb, 0.4, 0.9);
  const k = Math.PI * TL * TL;

  const Yvdot_ = -k * (1 + 0.16 * Cbr * BT - 5.1 * BL * BL);
  const Yrdot_ = -k * (0.67 * BL - 0.0033 * BT * BT);
  const Nvdot_ = -k * (1.1 * BL - 0.041 * BT);
  const Nrdot_ = -k * (1 / 12 + 0.017 * Cbr * BT - 0.33 * BL);
  const Yv_ = -k * (1 + 0.4 * Cbr * BT);
  const Yr_ = -k * (-0.5 + 2.2 * BL - 0.08 * BT);
  const Nv_ = -k * (0.5 + 2.4 * TL);
  const Nr_ = -k * (0.25 + 0.039 * BT - 0.56 * BL);

  // Prime system I: added mass scales with rho*L^n; linear damping also with speed.
  const referenceSpeed: MetresPerSecond = Math.max(1, Math.sqrt(9.81 * L) * 0.25);
  const h = 0.5 * rho;

  const conditioned = conditionMassMatrix({
    mass,
    Iz,
    Xudot: -0.05 * mass,
    Yvdot: Yvdot_ * h * L ** 3,
    Yrdot: Yrdot_ * h * L ** 4,
    Nvdot: Nvdot_ * h * L ** 4,
    Nrdot: Nrdot_ * h * L ** 5,
    Yv: Yv_ * h * referenceSpeed * L ** 2,
    Yr: Yr_ * h * referenceSpeed * L ** 3,
    Nv: Nv_ * h * referenceSpeed * L ** 3,
    Nr: Nr_ * h * referenceSpeed * L ** 4,
    referenceSpeed,
    Xu,
    Xuu,
    Yvv: -0.5 * rho * L * T * cdCross,
    Nrr: (-0.5 * rho * T * cdCross * L ** 4) / 32,
  });

  // Applied by default. With the added-mass Munk moment included, hulls derived
  // from an extrapolated regression come out unstable by margins no real
  // vessel of the type would tolerate, and unstable enough that no autopilot
  // gain holds them. Pass `ensureDirectionalStability: false` to study a hull
  // exactly as the regression describes it.
  return opts.ensureDirectionalStability === false
    ? conditioned
    : enforceDirectionalStability(conditioned);
}

/**
 * Linear directional-stability index, evaluated at the reference speed.
 *
 * The standard criterion from the linearised sway-yaw equations. Positive
 * means a vessel disturbed off its heading tends to straighten out; negative
 * means the sway-induced yawing moment overpowers the yaw damping and the
 * vessel diverges, needing continuous steering just to run straight.
 */
export function directionalStabilityIndex(c: HydroCoefficients): number {
  const { swayFromYaw, yawFromSway } = effectiveCouplings(c);
  return c.Yv * c.Nr - yawFromSway * swayFromYaw;
}

/**
 * The sway-yaw couplings a vessel actually experiences at its reference speed.
 *
 * Two contributions, not one. The hydrodynamic derivatives Nv and Yr are the
 * obvious part; the added-mass Coriolis terms are the other, and they are not
 * small. `(Yvdot - Xudot) * u * v` is the Munk moment - the reason a hull with
 * more added mass in sway than in surge tends to broach to rather than
 * straighten up - and it enters the yaw equation exactly as an addition to Nv.
 * Leaving it out makes a hull look far more directionally stable than it is.
 */
function effectiveCouplings(c: HydroCoefficients): {
  yawFromSway: number;
  swayFromYaw: number;
} {
  const U = c.referenceSpeed;
  return {
    yawFromSway: c.Nv + (c.Yvdot - c.Xudot) * U,
    swayFromYaw: c.Yr - (c.mass - c.Xudot) * U,
  };
}

/**
 * Reduce the sway-yaw coupling until a hull is directionally stable.
 *
 * Opt-in, and deliberately NOT applied by `deriveHydroCoefficients`, because
 * directional instability is often the physically correct answer. Large
 * full-form tankers really are course-unstable and really do need continuous
 * helm to run straight; "correcting" that would remove one of the more
 * instructive things a USV control algorithm can be tested against.
 *
 * It is offered for the opposite case: a small, beamy, shallow-draught hull
 * where the regression has been extrapolated well past its envelope and
 * returns a coupling so strong the drive cannot counter it at all. Such craft
 * get real directional stability from skegs, chines and hull form that a fit
 * over merchant hulls knows nothing about. Use this when a derived hull is
 * uncontrollable and measured coefficients are not available - and prefer the
 * measured coefficients when they are.
 */
export function enforceDirectionalStability(
  c: HydroCoefficients,
  margin = 0.15,
): HydroCoefficients {
  const { swayFromYaw, yawFromSway } = effectiveCouplings(c);
  const stabilising = c.Yv * c.Nr;
  const index = stabilising - yawFromSway * swayFromYaw;
  if (index > 0 || Math.abs(swayFromYaw) < 1e-9 || stabilising <= 0) return c;

  // Solve Yv*Nr - NvEffective*(Yr - m*U) = margin * Yv*Nr for the effective
  // coupling, then back out the hydrodynamic Nv that produces it once the
  // added-mass Munk moment is accounted for.
  const targetEffective = ((1 - margin) * stabilising) / swayFromYaw;
  const U = c.referenceSpeed;
  return { ...c, Nv: targetEffective - (c.Yvdot - c.Xudot) * U };
}

/** The 3x3 rigid-body-plus-added-mass matrix, as the integrator sees it. */
export function massMatrix(c: HydroCoefficients): {
  m11: number;
  m22: number;
  m23: number;
  m32: number;
  m33: number;
  determinant: number;
} {
  const m11 = c.mass - c.Xudot;
  const m22 = c.mass - c.Yvdot;
  const m23 = -c.Yrdot;
  const m32 = -c.Nvdot;
  const m33 = c.Iz - c.Nrdot;
  return { m11, m22, m23, m32, m33, determinant: m22 * m33 - m23 * m32 };
}

/**
 * True when the mass matrix describes a physically realisable body.
 *
 * A vessel whose mass matrix is not positive definite has negative inertia in
 * some direction: apply a force and it accelerates the wrong way, energy grows
 * without bound, and the integrator produces NaN within seconds. Worth being
 * able to assert, because the failure appears as a vessel silently vanishing
 * from the display rather than as an error.
 */
export function isPhysicallyRealisable(c: HydroCoefficients): boolean {
  const m = massMatrix(c);
  return (
    Number.isFinite(m.determinant) && m.m11 > 0 && m.m22 > 0 && m.m33 > 0 && m.determinant > 0
  );
}

/**
 * Force a set of coefficients into a physically realisable mass matrix.
 *
 * Applied to everything `deriveHydroCoefficients` produces, and available for
 * coefficients supplied from outside - a towing-tank data sheet transcribed
 * with a sign error is not a hypothetical. Diagonal added-mass terms must be
 * negative in this sign convention, since added mass increases effective
 * inertia; the sway/yaw coupling is then scaled back only as far as needed to
 * keep the determinant positive, preserving as much of the real coupling as
 * the physics allows.
 */
export function conditionMassMatrix(c: HydroCoefficients): HydroCoefficients {
  const Xudot = Math.min(0, c.Xudot);
  const Yvdot = Math.min(0, c.Yvdot);
  const Nrdot = Math.min(0, c.Nrdot);

  const m22 = c.mass - Yvdot;
  const m33 = c.Iz - Nrdot;

  let Yrdot = c.Yrdot;
  let Nvdot = c.Nvdot;
  const product = Yrdot * Nvdot; // equals m23 * m32
  const limit = 0.9 * m22 * m33;
  if (product > limit && product > 0) {
    const scale = Math.sqrt(limit / product);
    Yrdot *= scale;
    Nvdot *= scale;
  }

  return { ...c, Xudot, Yvdot, Yrdot, Nvdot, Nrdot };
}

/** Water motion in the inertial frame. */
export interface CurrentField {
  /** Direction the water is flowing toward, radians clockwise from true north. */
  readonly setRadians: number;
  /** Speed, m/s. */
  readonly driftSpeed: MetresPerSecond;
}

export const NO_CURRENT: CurrentField = { setRadians: 0, driftSpeed: 0 };

/** Velocity of the water in the body frame, for computing relative flow. */
export function currentInBodyFrame(current: CurrentField, heading: number): BodyVelocity {
  const vn = current.driftSpeed * Math.cos(current.setRadians);
  const ve = current.driftSpeed * Math.sin(current.setRadians);
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  return { u: vn * c + ve * s, v: -vn * s + ve * c, r: 0 };
}

/**
 * Hydrodynamic reaction force on the hull, given flow relative to the water.
 *
 * Damping derivatives are evaluated against the relative velocity because a
 * vessel stopped over the ground in a three-knot current is hydrodynamically
 * making three knots through the water - which is precisely the case a USV
 * station-keeping controller has to get right.
 */
export function hullForce(coeffs: HydroCoefficients, relative: BodyVelocity): BodyForce {
  const { u, v, r } = relative;

  // Rescale the linear derivatives from their reference speed to the speed now.
  const speed = Math.max(Math.abs(u), 0.5);
  const scale = speed / coeffs.referenceSpeed;
  const Yv = coeffs.Yv * scale;
  const Yr = coeffs.Yr * scale;
  const Nv = coeffs.Nv * scale;
  const Nr = coeffs.Nr * scale;

  return {
    X: coeffs.Xu * u + coeffs.Xuu * Math.abs(u) * u,
    Y: Yv * v + Yr * r + coeffs.Yvv * Math.abs(v) * v,
    N: Nv * v + Nr * r + coeffs.Nrr * Math.abs(r) * r,
  };
}

/**
 * Coriolis and centripetal terms, rigid-body plus added mass (Fossen).
 *
 * Returns -C(nu)*nu, not C(nu)*nu. The equations of motion are
 * `M*nuDot + C(nu)*nu + D(nu)*nu = tau`, and this result is summed with the
 * other forces on the right-hand side, so it has to carry the sign it appears
 * with after being moved across. Sanity check on the sway row: writing Newton's
 * second law in body axes gives `m*(vDot + u*r) = Y`, hence a contribution of
 * `-m*u*r` - a vessel turning to starboard feels the apparent force to port.
 * Getting this backwards is quietly destructive: the vessel still turns and
 * still looks plausible, but the sway-yaw coupling is inverted, and course
 * keeping in a cross-current goes unstable in a way that reads like a badly
 * tuned autopilot.
 */
export function coriolisForce(coeffs: HydroCoefficients, nu: BodyVelocity): BodyForce {
  const { mass, Xudot, Yvdot, Yrdot } = coeffs;
  const { u, v, r } = nu;
  return {
    X: (mass - Yvdot) * v * r - Yrdot * r * r,
    Y: -(mass - Xudot) * u * r,
    N: (Yvdot - Xudot) * u * v + Yrdot * u * r,
  };
}

/** Solve `M * nuDot = force` for the 3-DOF mass matrix with sway/yaw coupling. */
export function accelerations(coeffs: HydroCoefficients, force: BodyForce): BodyVelocity {
  const m11 = coeffs.mass - coeffs.Xudot;
  const m22 = coeffs.mass - coeffs.Yvdot;
  const m23 = -coeffs.Yrdot;
  const m32 = -coeffs.Nvdot;
  const m33 = coeffs.Iz - coeffs.Nrdot;
  const det = m22 * m33 - m23 * m32;
  return {
    u: force.X / m11,
    v: (m33 * force.Y - m23 * force.N) / det,
    r: (-m32 * force.Y + m22 * force.N) / det,
  };
}

/** Time derivative of the full state, for the integrator. */
export interface StateDerivative {
  readonly north: number;
  readonly east: number;
  readonly heading: number;
  readonly u: number;
  readonly v: number;
  readonly r: number;
}

export function kinematics(state: RigidBodyState, accel: BodyVelocity): StateDerivative {
  const c = Math.cos(state.heading);
  const s = Math.sin(state.heading);
  return {
    north: state.u * c - state.v * s,
    east: state.u * s + state.v * c,
    heading: state.r,
    u: accel.u,
    v: accel.v,
    r: accel.r,
  };
}

function addScaled(state: RigidBodyState, d: StateDerivative, h: Seconds): RigidBodyState {
  return {
    north: state.north + d.north * h,
    east: state.east + d.east * h,
    heading: state.heading + d.heading * h,
    u: state.u + d.u * h,
    v: state.v + d.v * h,
    r: state.r + d.r * h,
  };
}

/**
 * Classical RK4 over one fixed step.
 *
 * Actuator positions are held constant across the four evaluations, which is
 * standard practice: they are updated once per step by the drive model, so the
 * integrator sees a time-invariant plant within the step.
 */
export function integrateRK4(
  state: RigidBodyState,
  dt: Seconds,
  derivative: (s: RigidBodyState) => StateDerivative,
): RigidBodyState {
  const k1 = derivative(state);
  const k2 = derivative(addScaled(state, k1, dt / 2));
  const k3 = derivative(addScaled(state, k2, dt / 2));
  const k4 = derivative(addScaled(state, k3, dt));
  const w = (a: number, b: number, c: number, d: number): number => (a + 2 * b + 2 * c + d) / 6;
  const combined: StateDerivative = {
    north: w(k1.north, k2.north, k3.north, k4.north),
    east: w(k1.east, k2.east, k3.east, k4.east),
    heading: w(k1.heading, k2.heading, k3.heading, k4.heading),
    u: w(k1.u, k2.u, k3.u, k4.u),
    v: w(k1.v, k2.v, k3.v, k4.v),
    r: w(k1.r, k2.r, k3.r, k4.r),
  };
  const next = addScaled(state, combined, dt);
  return { ...next, heading: wrapAngle(next.heading) };
}

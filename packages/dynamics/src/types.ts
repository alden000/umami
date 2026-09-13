import type {
  Kilograms,
  Metres,
  MetresPerSecond,
  Newtons,
  NewtonMetres,
  Radians,
  RadiansPerSecond,
  Seconds,
} from '@umami/core';

/** Body-frame velocity: surge (forward), sway (starboard), yaw rate. */
export interface BodyVelocity {
  readonly u: MetresPerSecond;
  readonly v: MetresPerSecond;
  readonly r: RadiansPerSecond;
}

/** Planar pose in the local tangent plane, plus body velocities. */
export interface RigidBodyState extends BodyVelocity {
  /** North, metres from the tangent-plane origin. */
  readonly north: Metres;
  /** East, metres from the tangent-plane origin. */
  readonly east: Metres;
  /** True heading, radians clockwise from north. */
  readonly heading: Radians;
}

/** Generalised force in the body frame. */
export interface BodyForce {
  readonly X: Newtons;
  readonly Y: Newtons;
  readonly N: NewtonMetres;
}

export const ZERO_FORCE: BodyForce = { X: 0, Y: 0, N: 0 };

export function addForces(...forces: readonly BodyForce[]): BodyForce {
  let X = 0;
  let Y = 0;
  let N = 0;
  for (const f of forces) {
    X += f.X;
    Y += f.Y;
    N += f.N;
  }
  return { X, Y, N };
}

/** Principal particulars. Everything else is derived from these where possible. */
export interface HullParticulars {
  /** Length overall, metres. */
  readonly loa: Metres;
  /** Length between perpendiculars, metres. Defaults to 0.96 * loa when omitted. */
  readonly lpp?: Metres;
  /** Moulded beam, metres. */
  readonly beam: Metres;
  /** Mean draught, metres. */
  readonly draught: Metres;
  /** Block coefficient, 0..1. */
  readonly blockCoefficient: number;
  /** Loaded displacement mass, kilograms. Derived from the block coefficient when omitted. */
  readonly massKg?: Kilograms;
  /** Frontal projected area above the waterline, m^2. Estimated when omitted. */
  readonly frontalArea?: number;
  /** Lateral projected area above the waterline, m^2. Estimated when omitted. */
  readonly lateralArea?: number;
}

/**
 * Dimensional hydrodynamic derivatives for the 3-DOF manoeuvring model.
 *
 * Sign convention: these are force derivatives, so damping terms are negative
 * (a positive sway velocity produces a negative sway force). Added-mass terms
 * are also negative, which is why they appear as `m - Yvdot` in the mass
 * matrix: subtracting a negative increases the effective inertia.
 *
 * Linear derivatives scale with forward speed (prime system I), so the speed
 * they were evaluated at is carried with them and they are rescaled each step.
 */
export interface HydroCoefficients {
  readonly mass: Kilograms;
  /** Yaw moment of inertia about the body z axis, kg*m^2. */
  readonly Iz: number;
  // Added mass.
  readonly Xudot: number;
  readonly Yvdot: number;
  readonly Yrdot: number;
  readonly Nvdot: number;
  readonly Nrdot: number;
  // Linear damping, evaluated at `referenceSpeed`.
  readonly Yv: number;
  readonly Yr: number;
  readonly Nv: number;
  readonly Nr: number;
  /** Forward speed the linear derivatives were evaluated at, m/s. */
  readonly referenceSpeed: MetresPerSecond;
  // Surge resistance: X = Xu*u + Xuu*|u|*u.
  readonly Xu: number;
  readonly Xuu: number;
  // Nonlinear cross-flow damping.
  readonly Yvv: number;
  readonly Nrr: number;
}

/** What the external control interface ultimately reduces to. */
export interface ActuatorDemand {
  /**
   * Thrust demand, -1..1. Positive is ahead. How astern is achieved is the
   * drive's business: a reverse bucket, a gear shift, or a reversing propeller.
   */
  readonly throttle: number;
  /** Steering demand, -1..1. Positive commands a turn to starboard, always. */
  readonly steer: number;
}

export const ZERO_DEMAND: ActuatorDemand = { throttle: 0, steer: 0 };

export type PropulsionKind = 'waterjet' | 'shaft-rudder' | 'outboard';

/** Ambient conditions a drive needs in order to produce force. */
export interface PropulsionContext {
  /** Water density, kg/m^3. */
  readonly waterDensity: number;
  /** Water depth under keel, metres. Infinity in open water. */
  readonly depthUnderKeel?: Metres;
}

/**
 * A propulsion and steering system.
 *
 * This is the seam that keeps hull hydrodynamics independent of how a vessel
 * is driven. The distinction that matters for USV control is
 * `steersAtZeroSpeed`: vectored-thrust drives (waterjets, outboards) retain
 * full turning authority with no way on, while a rudder behind a shaft loses
 * authority with the square of speed. Control algorithms that assume the wrong
 * one fail in exactly the situations - station keeping, berthing, recovery -
 * where a USV most needs to be trusted.
 */
export interface PropulsionModel {
  readonly kind: PropulsionKind;
  /** Advance actuator dynamics (slew rates, spool-up) one step toward the demand. */
  update(demand: ActuatorDemand, dt: Seconds): void;
  /** Body-frame force at the present actuator positions. */
  force(velocity: BodyVelocity, ctx: PropulsionContext): BodyForce;
  /** Actuator positions, for telemetry, hardware-in-the-loop and display. */
  telemetry(): Readonly<Record<string, number>>;
  /** Whether a turning moment is available with no forward speed. */
  readonly steersAtZeroSpeed: boolean;
  /** Maximum sustained ahead speed used for scaling, m/s. */
  readonly maxAheadThrust: Newtons;
}

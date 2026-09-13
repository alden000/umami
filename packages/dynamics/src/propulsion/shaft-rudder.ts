import { clamp, rateLimit, type Metres, type Newtons, type Radians, type Seconds } from '@umami/core';
import type {
  ActuatorDemand,
  BodyForce,
  BodyVelocity,
  PropulsionContext,
  PropulsionModel,
} from '../types.js';

export interface ShaftRudderParams {
  /** Ahead thrust at full revolutions, newtons. */
  readonly maxThrust: Newtons;
  /** Astern thrust as a fraction of ahead. A fixed-pitch propeller manages ~0.6-0.7. */
  readonly asternThrustFraction?: number;
  /** Rudder plan area, m^2. */
  readonly rudderArea: number;
  /** Longitudinal distance from the centre of gravity to the rudder stock, metres. */
  readonly leverArm: Metres;
  /** Maximum rudder angle either side, radians. Usually 35 degrees. */
  readonly maxRudderAngle?: Radians;
  /**
   * Rudder slew rate, radians per second. SOLAS requires 35 degrees one side
   * to 30 degrees the other in 28 seconds, about 2.3 deg/s.
   */
  readonly rudderRate?: Radians;
  /** Rudder aspect ratio, for the lift-curve slope. */
  readonly rudderAspectRatio?: number;
  /** Stall angle, radians. */
  readonly stallAngle?: Radians;
  /** Time constant for shaft revolutions to follow the telegraph, seconds. */
  readonly shaftTimeConstant?: Seconds;
  /** Wake fraction: the hull slows the flow reaching the propeller. */
  readonly wakeFraction?: number;
  /** Thrust deduction factor. */
  readonly thrustDeduction?: number;
  /** Propeller diameter, metres. Sets how concentrated the race is. */
  readonly propellerDiameter: number;
  /** Fraction of the rudder standing in the propeller race. */
  readonly raceFraction?: number;
  /** Rudder section profile drag coefficient at zero lift. */
  readonly profileDragCoefficient?: number;
}

/**
 * Conventional inboard engine driving a shaft, propeller and rudder.
 *
 * Steering force is aerodynamic lift on the rudder and therefore scales with
 * the square of the flow over it. A vessel with no way on has no steering,
 * except for the weak authority the propeller race provides while the engine
 * is ahead - modelled here, because manoeuvring in harbour depends on it. The
 * contrast with vectored-thrust drives is the whole reason this abstraction
 * exists.
 */
export class ShaftRudderPropulsion implements PropulsionModel {
  readonly kind = 'shaft-rudder' as const;
  readonly steersAtZeroSpeed = false;

  private readonly p: Required<ShaftRudderParams>;
  /** Shaft revolutions as a signed fraction of maximum, -1..1. */
  private shaft = 0;
  private rudder: Radians = 0;

  constructor(params: ShaftRudderParams) {
    this.p = {
      maxThrust: params.maxThrust,
      asternThrustFraction: params.asternThrustFraction ?? 0.65,
      rudderArea: params.rudderArea,
      leverArm: params.leverArm,
      maxRudderAngle: params.maxRudderAngle ?? 0.6109, // 35 degrees
      rudderRate: params.rudderRate ?? 0.0407, // 2.33 deg/s
      rudderAspectRatio: params.rudderAspectRatio ?? 1.5,
      stallAngle: params.stallAngle ?? 0.4014, // 23 degrees
      shaftTimeConstant: params.shaftTimeConstant ?? 8,
      wakeFraction: params.wakeFraction ?? 0.25,
      thrustDeduction: params.thrustDeduction ?? 0.18,
      propellerDiameter: params.propellerDiameter,
      raceFraction: params.raceFraction ?? 0.6,
      profileDragCoefficient: params.profileDragCoefficient ?? 0.025,
    };
  }

  get maxAheadThrust(): Newtons {
    return this.p.maxThrust * (1 - this.p.thrustDeduction);
  }

  update(demand: ActuatorDemand, dt: Seconds): void {
    const alpha = 1 - Math.exp(-dt / this.p.shaftTimeConstant);
    this.shaft += (clamp(demand.throttle, -1, 1) - this.shaft) * alpha;
    this.rudder = rateLimit(
      this.rudder,
      clamp(demand.steer, -1, 1) * this.p.maxRudderAngle,
      this.p.rudderRate * dt,
    );
  }

  force(velocity: BodyVelocity, ctx: PropulsionContext): BodyForce {
    const rho = ctx.waterDensity;
    const scale = this.shaft >= 0 ? 1 : this.p.asternThrustFraction;
    const thrust = this.p.maxThrust * scale * this.shaft * Math.abs(this.shaft);
    const X = thrust * (1 - this.p.thrustDeduction);

    // Flow over the rudder is the wake-reduced hull flow, augmented over part
    // of the span by the propeller race. Momentum theory gives a fully
    // developed slipstream dynamic pressure of T / A_disc, which is what
    // leaves a stopped ship some steering while the engine turns ahead - and
    // why that authority vanishes the moment the engine is stopped or put
    // astern, when the race blows away from the rudder instead of over it.
    const advance = (1 - this.p.wakeFraction) * velocity.u;
    const hullFlowSquared = advance * Math.abs(advance);
    const discArea = (Math.PI * this.p.propellerDiameter ** 2) / 4;
    const raceAreaOfRudder = this.p.raceFraction * this.p.rudderArea;
    const raceFlowSquared =
      this.shaft >= 0 ? (2 * Math.max(0, thrust)) / (rho * discArea) : 0;

    // Effective dynamic-pressure-weighted area, split between clean flow and race.
    const effectiveAreaFlow =
      this.p.rudderArea * hullFlowSquared + raceAreaOfRudder * raceFlowSquared;
    if (Math.abs(effectiveAreaFlow) < 1e-6) return { X, Y: 0, N: 0 };

    const liftSlope = (2 * Math.PI * this.p.rudderAspectRatio) / (this.p.rudderAspectRatio + 2);
    const alpha = clamp(this.rudder, -this.p.stallAngle, this.p.stallAngle);
    const cl = liftSlope * Math.sin(alpha);
    const lift = 0.5 * rho * cl * effectiveAreaFlow;
    const drag =
      0.5 * rho * (this.p.profileDragCoefficient + 0.4 * cl * cl) * Math.abs(effectiveAreaFlow);

    // Same convention as the waterjet: starboard helm pushes the stern to port.
    return { X: X - drag, Y: -lift, N: this.p.leverArm * lift };
  }

  telemetry(): Readonly<Record<string, number>> {
    return { shaftFraction: this.shaft, rudderAngleRad: this.rudder };
  }
}

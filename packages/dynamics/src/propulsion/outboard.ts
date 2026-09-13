import { clamp, rateLimit, type Metres, type Newtons, type Radians, type Seconds } from '@umami/core';
import type {
  ActuatorDemand,
  BodyForce,
  BodyVelocity,
  PropulsionContext,
  PropulsionModel,
} from '../types.js';

export interface OutboardParams {
  /** Number of engines. Two or more also allow differential steering. */
  readonly engineCount?: number;
  /** Static thrust per engine at wide-open throttle, newtons. */
  readonly maxThrustPerEngine: Newtons;
  /** Longitudinal distance from the centre of gravity to the transom, metres. */
  readonly leverArm: Metres;
  /** Half the athwartships spacing between outer engines, metres. Enables differential thrust. */
  readonly lateralOffset?: Metres;
  /** Maximum steering angle either side, radians. Typically 30 degrees. */
  readonly maxSteerAngle?: Radians;
  /** Steering rate, radians per second. */
  readonly steerRate?: Radians;
  /** Astern thrust as a fraction of ahead. */
  readonly asternThrustFraction?: number;
  /** Time constant for engine speed to follow the throttle, seconds. */
  readonly engineTimeConstant?: Seconds;
  /** Time to complete a gear shift through neutral, seconds. */
  readonly shiftTime?: Seconds;
  /** Thrust deduction factor. */
  readonly thrustDeduction?: number;
  /**
   * Blend of steering authority taken from differential thrust rather than
   * from the steering angle. Only meaningful with two or more engines.
   */
  readonly differentialSteerFraction?: number;
}

/**
 * Steerable outboard or sterndrive legs.
 *
 * Like a waterjet this is vectored thrust, so steering authority survives at
 * zero speed - but only while the engine is driving. Chopping the throttle
 * mid-turn removes the turning moment almost entirely, which is the classic
 * outboard handling trap and worth reproducing for a USV that may be told to
 * slow and turn at once. Astern is a gear shift through neutral, so the
 * direction reversal takes real time and passes through a period of no thrust.
 */
export class OutboardPropulsion implements PropulsionModel {
  readonly kind = 'outboard' as const;
  readonly steersAtZeroSpeed = true;

  private readonly p: Required<OutboardParams>;
  /** Engine speed as a fraction of maximum, 0..1. */
  private engine = 0;
  /** Gear: -1 astern, 0 neutral, 1 ahead; moves continuously through neutral. */
  private gear = 0;
  private steerAngle: Radians = 0;

  constructor(params: OutboardParams) {
    this.p = {
      engineCount: params.engineCount ?? 1,
      maxThrustPerEngine: params.maxThrustPerEngine,
      leverArm: params.leverArm,
      lateralOffset: params.lateralOffset ?? 0,
      maxSteerAngle: params.maxSteerAngle ?? 0.5236, // 30 degrees
      steerRate: params.steerRate ?? 0.6,
      asternThrustFraction: params.asternThrustFraction ?? 0.6,
      engineTimeConstant: params.engineTimeConstant ?? 1.0,
      shiftTime: params.shiftTime ?? 1.2,
      thrustDeduction: params.thrustDeduction ?? 0.08,
      differentialSteerFraction: params.differentialSteerFraction ?? 0,
    };
  }

  get maxAheadThrust(): Newtons {
    return this.p.maxThrustPerEngine * this.p.engineCount * (1 - this.p.thrustDeduction);
  }

  update(demand: ActuatorDemand, dt: Seconds): void {
    const throttle = clamp(demand.throttle, -1, 1);
    const gearDemand = throttle > 0.01 ? 1 : throttle < -0.01 ? -1 : 0;
    this.gear = rateLimit(this.gear, gearDemand, dt / this.p.shiftTime);

    const alpha = 1 - Math.exp(-dt / this.p.engineTimeConstant);
    this.engine += (Math.abs(throttle) - this.engine) * alpha;

    this.steerAngle = rateLimit(
      this.steerAngle,
      clamp(demand.steer, -1, 1) * this.p.maxSteerAngle,
      this.p.steerRate * dt,
    );
  }

  force(_velocity: BodyVelocity, _ctx: PropulsionContext): BodyForce {
    const directionScale = this.gear >= 0 ? 1 : this.p.asternThrustFraction;
    const total =
      this.p.maxThrustPerEngine *
      this.p.engineCount *
      this.engine *
      this.engine *
      this.gear *
      directionScale *
      (1 - this.p.thrustDeduction);

    // Split the steering demand between vectoring the legs and, where fitted,
    // thrusting differentially across them.
    const dFrac = this.p.engineCount > 1 ? this.p.differentialSteerFraction : 0;
    const vectored = total * (1 - dFrac);
    const sin = Math.sin(this.steerAngle);
    const cos = Math.cos(this.steerAngle);

    const Y = -vectored * sin;
    let N = this.p.leverArm * vectored * sin;

    if (dFrac > 0 && this.p.lateralOffset > 0) {
      const steerFraction = this.steerAngle / this.p.maxSteerAngle;
      N += this.p.lateralOffset * total * dFrac * steerFraction;
    }

    return { X: vectored * cos + total * dFrac, Y, N };
  }

  telemetry(): Readonly<Record<string, number>> {
    return {
      engineFraction: this.engine,
      gear: this.gear,
      steerAngleRad: this.steerAngle,
    };
  }
}

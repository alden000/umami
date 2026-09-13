import { clamp, rateLimit, type Metres, type Newtons, type Radians, type Seconds } from '@umami/core';
import type {
  ActuatorDemand,
  BodyForce,
  BodyVelocity,
  PropulsionContext,
  PropulsionModel,
} from '../types.js';

export interface WaterjetParams {
  /** Number of jet units. Twin jets also permit differential steering. */
  readonly unitCount?: number;
  /** Bollard-pull thrust per unit at full impeller speed, newtons. */
  readonly maxThrustPerUnit: Newtons;
  /** Longitudinal distance from the centre of gravity to the jets, metres, positive. */
  readonly leverArm: Metres;
  /** Maximum nozzle deflection either side, radians. Typically 25-30 degrees. */
  readonly maxNozzleAngle?: Radians;
  /** Nozzle steering rate, radians per second. */
  readonly nozzleSlewRate?: Radians;
  /** Time constant for impeller speed to follow the throttle, seconds. */
  readonly impellerTimeConstant?: Seconds;
  /** Time for the reverse bucket to travel its full stroke, seconds. */
  readonly bucketStrokeTime?: Seconds;
  /** Fraction of ahead thrust recoverable astern with the bucket fully down. */
  readonly reverseEffectiveness?: number;
  /** Thrust deduction factor: the hull steals a little of the jet's thrust. */
  readonly thrustDeduction?: number;
  /**
   * Fraction of static thrust lost at maximum speed to inlet momentum drag.
   * A waterjet has to accelerate water that is already moving past the inlet.
   */
  readonly momentumDragFactor?: number;
  /** Speed at which `momentumDragFactor` is reached, m/s. */
  readonly designSpeed?: number;
}

/**
 * Waterjet propulsion with a steering nozzle and a reverse bucket.
 *
 * The defining characteristic, and the reason this is the default drive for
 * the USV, is that steering force comes from vectoring the jet rather than
 * from flow over a rudder. Turning moment is therefore proportional to
 * impeller thrust and completely independent of speed through the water: a
 * waterjet craft can spin on the spot and hold station against wind and tide
 * with no way on. Thrust is vectored at the transom, so a turn to starboard
 * first pushes the stern to port - the "kick" that a track-keeping controller
 * has to anticipate.
 */
export class WaterjetPropulsion implements PropulsionModel {
  readonly kind = 'waterjet' as const;
  readonly steersAtZeroSpeed = true;

  private readonly p: Required<WaterjetParams>;
  /** Impeller speed as a fraction of maximum, 0..1. */
  private impeller = 0;
  /** Nozzle deflection, radians, positive commands a starboard turn. */
  private nozzle: Radians = 0;
  /** Reverse bucket position, 0 stowed to 1 fully deployed. */
  private bucket = 0;

  constructor(params: WaterjetParams) {
    this.p = {
      unitCount: params.unitCount ?? 2,
      maxThrustPerUnit: params.maxThrustPerUnit,
      leverArm: params.leverArm,
      maxNozzleAngle: params.maxNozzleAngle ?? 0.4712, // 27 degrees
      nozzleSlewRate: params.nozzleSlewRate ?? 0.5, // ~29 deg/s, fast electro-hydraulic
      impellerTimeConstant: params.impellerTimeConstant ?? 1.5,
      bucketStrokeTime: params.bucketStrokeTime ?? 2.0,
      reverseEffectiveness: params.reverseEffectiveness ?? 0.55,
      thrustDeduction: params.thrustDeduction ?? 0.04,
      momentumDragFactor: params.momentumDragFactor ?? 0.35,
      designSpeed: params.designSpeed ?? 15,
    };
  }

  get maxAheadThrust(): Newtons {
    return this.p.maxThrustPerUnit * this.p.unitCount * (1 - this.p.thrustDeduction);
  }

  update(demand: ActuatorDemand, dt: Seconds): void {
    const throttle = clamp(demand.throttle, -1, 1);
    const steer = clamp(demand.steer, -1, 1);

    // The impeller keeps turning when going astern; it is the bucket that
    // reverses the flow. Idling the impeller would lose steering authority,
    // which is exactly what this drive is chosen to retain.
    const bucketDemand = throttle < 0 ? -throttle : 0;
    const impellerDemand = Math.max(Math.abs(throttle), bucketDemand > 0 ? 0.25 : 0);

    // First-order lag on impeller speed, exact for a constant demand.
    const alpha = 1 - Math.exp(-dt / this.p.impellerTimeConstant);
    this.impeller += (impellerDemand - this.impeller) * alpha;

    this.bucket = rateLimit(this.bucket, bucketDemand, dt / this.p.bucketStrokeTime);
    this.nozzle = rateLimit(
      this.nozzle,
      steer * this.p.maxNozzleAngle,
      this.p.nozzleSlewRate * dt,
    );
  }

  force(velocity: BodyVelocity, _ctx: PropulsionContext): BodyForce {
    // Thrust rises with the square of impeller speed, and falls off with
    // forward speed as inlet momentum drag grows.
    const speedLoss =
      1 - this.p.momentumDragFactor * clamp(velocity.u / this.p.designSpeed, 0, 1.2);
    const gross =
      this.p.maxThrustPerUnit *
      this.p.unitCount *
      this.impeller *
      this.impeller *
      Math.max(0.1, speedLoss);
    const net = gross * (1 - this.p.thrustDeduction);

    // Bucket down reverses the flow, at reduced efficiency.
    const axialFactor = 1 - (1 + this.p.reverseEffectiveness) * this.bucket;
    const effective = net * axialFactor;

    const sin = Math.sin(this.nozzle);
    const cos = Math.cos(this.nozzle);

    // Deflecting the jet to produce a starboard turn pushes the stern to port,
    // hence the negative sway force paired with a positive yawing moment.
    const Y = -effective * sin;
    return { X: effective * cos, Y, N: this.p.leverArm * effective * sin };
  }

  telemetry(): Readonly<Record<string, number>> {
    return {
      impellerFraction: this.impeller,
      nozzleAngleRad: this.nozzle,
      bucketPosition: this.bucket,
    };
  }
}

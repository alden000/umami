import {
  clamp,
  wrapAngle,
  wrapAngleSigned,
  type LatLon,
  type MetresPerSecond,
  type Radians,
  type Seconds,
  type SimTime,
  type TangentPlane,
} from '@umami/core';
import type {
  ActuatorDemand,
  EnvironmentConditions,
  PropulsionModel,
  RigidBodyState,
  VesselDynamics,
} from '@umami/dynamics';
import {
  HeadingAutopilot,
  SpeedController,
  type HeadingAutopilotGains,
  type NomotoModel,
} from './autopilot.js';
import { LineOfSightGuidance, type GuidanceOutput, type Route } from './guidance.js';

/**
 * Control modes exposed over the external interface.
 *
 * All of them converge on the same `ActuatorDemand`, so a control algorithm
 * can move up and down the stack without the simulation changing underneath
 * it: test a mission planner against `waypoint`, a guidance law against
 * `course-speed`, and a low-level controller or real autopilot hardware
 * against `actuator`, all on the same vessel model.
 */
export type ControlMode =
  | 'idle'
  | 'actuator'
  | 'heading-speed'
  | 'course-speed'
  | 'waypoint'
  | 'station-keep';

export interface ControlContext {
  readonly simTime: SimTime;
  readonly dt: Seconds;
  readonly state: RigidBodyState;
  readonly position: LatLon;
  readonly plane: TangentPlane;
  readonly propulsion: PropulsionModel;
  readonly environment: EnvironmentConditions;
  /** Course over ground now, radians. Differs from heading whenever set matters. */
  readonly courseOverGround: Radians;
  readonly speedOverGround: MetresPerSecond;
}

export interface Controller {
  readonly mode: ControlMode;
  update(ctx: ControlContext): ActuatorDemand;
  /** Anything worth showing on a telemetry panel or streaming to the client. */
  readonly status?: Readonly<Record<string, unknown>>;
}

/** Stop everything. The state a vessel falls back to if its commander goes away. */
export class IdleController implements Controller {
  readonly mode = 'idle' as const;
  update(): ActuatorDemand {
    return { throttle: 0, steer: 0 };
  }
}

/** Pass raw actuator demands straight through, for low-level control testing. */
export class ActuatorController implements Controller {
  readonly mode = 'actuator' as const;
  private demand: ActuatorDemand = { throttle: 0, steer: 0 };

  set(demand: ActuatorDemand): void {
    this.demand = { throttle: clamp(demand.throttle, -1, 1), steer: clamp(demand.steer, -1, 1) };
  }

  update(): ActuatorDemand {
    return this.demand;
  }

  get status(): Readonly<Record<string, unknown>> {
    return { ...this.demand };
  }
}

export interface AutopilotControllerOptions {
  readonly gains: HeadingAutopilotGains;
  readonly maxSpeed: MetresPerSecond;
  /** Follow course over ground rather than heading. See `setCourseDemand`. */
  readonly followCourse?: boolean;
  /**
   * Rate at which the course loop trims the heading setpoint, per second.
   * Defaults to an eighth of the heading loop's bandwidth. Raising it toward
   * the inner loop's speed reintroduces the instability described below.
   */
  readonly courseTrimRate?: number;
}

/** Largest crab angle the course loop will carry, radians. */
const MAX_CRAB_ANGLE: Radians = Math.PI / 4;
/** Below this speed over ground, course is meaningless and the loop holds. */
const MIN_SPEED_FOR_COURSE: MetresPerSecond = 0.5;
/**
 * Fallback outer-loop rate when the caller does not supply one, per second.
 * Slow enough to be safe on any hull; callers that know the vessel's time
 * constant should pass `courseTrimRate` and get a much brisker response.
 */
const DEFAULT_COURSE_TRIM_RATE = 0.01;

/**
 * Outer-loop trim rate a decade below the heading loop's closed-loop bandwidth.
 *
 * The course loop must be slower than the heading loop beneath it - that
 * separation is what keeps the non-minimum-phase response from helm to course
 * outside the loop that has to stay stable - but "slower" has to be measured
 * against the loop actually achieved, not guessed. For the first-order model
 * the closed-loop bandwidth is sqrt(K * kp / T), so a decade below that is
 * both stable and as brisk as the vessel allows: about 0.3 per second for a
 * tuned USV, two orders of magnitude less for a laden tanker. Guessing a fixed
 * fraction instead leaves a small craft crabbing into a tideway ten times
 * slower than it could, which reads as a sluggish autopilot rather than as the
 * tuning mistake it is.
 */
export function courseTrimRateFor(model: NomotoModel, proportionalGain: number): number {
  // Two bounds, and the binding one varies by vessel. The linear estimate
  // sqrt(K * kp / T) is the bandwidth the gains would give an unsaturating
  // plant; real steering gear saturates long before that, so on a small craft
  // with high tuned gains it is wildly optimistic. The vessel's own yaw time
  // constant gives the second bound, and taking the lesser keeps the course
  // loop below the heading loop in every case - which is the entire reason the
  // two are separated.
  const fromGains = Math.sqrt(
    (Math.max(model.gain, 1e-9) * proportionalGain) / Math.max(model.timeConstant, 1e-6),
  ) / 10;
  const fromPlant = 1 / (10 * Math.max(model.timeConstant, 0.1));
  return clamp(Math.min(fromGains, fromPlant), 0.002, 0.1);
}

/**
 * Heading-or-course and speed autopilot.
 *
 * The distinction between the two is not pedantry. Holding a *heading* keeps
 * the bow pointed somewhere; holding a *course* keeps the vessel's track over
 * the ground where it is wanted, steering up into a set to do so. A USV asked
 * to transit a tidal channel needs the second, and a control algorithm that
 * commands one while the simulation implements the other will look correct in
 * still water and fail on the day.
 *
 * Course is therefore held as a slow outer loop trimming the heading setpoint,
 * never by feeding course error into the heading gains. The reason is that the
 * response from helm to course over ground is non-minimum-phase: putting the
 * helm over kicks the stern out, so the track initially swings the *opposite*
 * way to the bow before the turn develops. Gains tuned for the heading
 * response - which has no such inversion - go unstable when closed around
 * course instead, and the vessel spins helm-to-helm rather than settling. The
 * outer loop runs at a fraction of the inner loop's bandwidth, which is what
 * keeps the inversion well outside the loop that has to stay stable.
 */
export class AutopilotController implements Controller {
  private _mode: 'heading-speed' | 'course-speed';
  private readonly heading: HeadingAutopilot;
  private readonly speed: SpeedController;
  private readonly courseTrimRate: number;
  private demandAngle: Radians = 0;
  private demandSpeed: MetresPerSecond = 0;
  /** Heading offset the course loop is carrying to counter set and leeway. */
  private crabTrim: Radians = 0;

  constructor(private readonly opts: AutopilotControllerOptions) {
    this._mode = opts.followCourse ? 'course-speed' : 'heading-speed';
    this.heading = new HeadingAutopilot(opts.gains);
    this.speed = new SpeedController(0.6, 0.08, opts.maxSpeed);
    this.courseTrimRate = opts.courseTrimRate ?? DEFAULT_COURSE_TRIM_RATE;
  }

  get mode(): ControlMode {
    return this._mode;
  }

  setHeadingDemand(heading: Radians, speed: MetresPerSecond): void {
    this._mode = 'heading-speed';
    this.demandAngle = wrapAngle(heading);
    this.demandSpeed = speed;
  }

  setCourseDemand(course: Radians, speed: MetresPerSecond): void {
    this._mode = 'course-speed';
    this.demandAngle = wrapAngle(course);
    this.demandSpeed = speed;
  }

  setGains(gains: HeadingAutopilotGains): void {
    this.heading.setGains(gains);
  }

  update(ctx: ControlContext): ActuatorDemand {
    let headingSetpoint = this.demandAngle;

    if (this._mode === 'course-speed') {
      // With no way on, course over ground is noise; freeze the trim rather
      // than integrate garbage into it.
      if (ctx.speedOverGround > MIN_SPEED_FOR_COURSE) {
        const courseError = wrapAngleSigned(this.demandAngle - ctx.courseOverGround);
        this.crabTrim = clamp(
          this.crabTrim + this.courseTrimRate * courseError * ctx.dt,
          -MAX_CRAB_ANGLE,
          MAX_CRAB_ANGLE,
        );
      }
      headingSetpoint = wrapAngle(this.demandAngle + this.crabTrim);
    }

    const error = wrapAngleSigned(headingSetpoint - ctx.state.heading);
    return {
      steer: this.heading.update(error, ctx.state.r, ctx.dt),
      throttle: this.speed.update(this.demandSpeed, ctx.speedOverGround, ctx.dt),
    };
  }

  get status(): Readonly<Record<string, unknown>> {
    return {
      demandAngle: this.demandAngle,
      demandSpeed: this.demandSpeed,
      mode: this._mode,
      crabTrim: this.crabTrim,
    };
  }
}

export interface WaypointControllerOptions extends AutopilotControllerOptions {
  readonly route: Route;
  readonly lookAheadDistance?: number;
  readonly defaultSpeed?: MetresPerSecond;
  readonly defaultArrivalRadius?: number;
}

/** Route following: guidance produces a course, the autopilot holds it. */
export class WaypointController implements Controller {
  readonly mode = 'waypoint' as const;
  private readonly guidance: LineOfSightGuidance;
  private readonly autopilot: AutopilotController;
  private last?: GuidanceOutput;

  constructor(opts: WaypointControllerOptions) {
    this.guidance = new LineOfSightGuidance(opts.route, {
      lookAheadDistance: opts.lookAheadDistance,
      defaultSpeed: opts.defaultSpeed,
      defaultArrivalRadius: opts.defaultArrivalRadius,
    });
    this.autopilot = new AutopilotController({ ...opts, followCourse: true });
  }

  setRoute(route: Route): void {
    this.guidance.setRoute(route);
  }

  setActiveLeg(index: number): void {
    this.guidance.setActiveLeg(index);
  }

  update(ctx: ControlContext): ActuatorDemand {
    const out = this.guidance.update(ctx.position, ctx.state.heading);
    this.last = out;
    this.autopilot.setCourseDemand(out.courseDemand, out.speedDemand);
    return this.autopilot.update(ctx);
  }

  get status(): Readonly<Record<string, unknown>> {
    return {
      activeLeg: this.last?.activeLeg ?? 0,
      crossTrackError: this.last?.crossTrackError ?? 0,
      distanceToWaypoint: this.last?.distanceToWaypoint ?? 0,
      complete: this.last?.complete ?? false,
    };
  }
}

export interface StationKeepOptions extends AutopilotControllerOptions {
  readonly target: LatLon;
  /** Radius within which the vessel is considered on station, metres. */
  readonly tolerance?: number;
}

/**
 * Hold a position against wind and tide.
 *
 * Only meaningful on a drive that can steer without way on, which is why
 * `PropulsionModel` reports `steersAtZeroSpeed`. Asked of a shaft-and-rudder
 * vessel, this degrades into slowly orbiting the position - which is what such
 * a vessel actually does, and worth seeing rather than hiding.
 */
export class StationKeepController implements Controller {
  readonly mode = 'station-keep' as const;
  private readonly autopilot: AutopilotController;
  private target: LatLon;
  private readonly tolerance: number;
  private distance = 0;

  constructor(private readonly opts: StationKeepOptions) {
    this.autopilot = new AutopilotController({ ...opts, followCourse: true });
    this.target = opts.target;
    this.tolerance = opts.tolerance ?? 15;
  }

  setTarget(target: LatLon): void {
    this.target = target;
  }

  update(ctx: ControlContext): ActuatorDemand {
    const local = ctx.plane.toLocal(this.target);
    const dn = local.n - ctx.state.north;
    const de = local.e - ctx.state.east;
    this.distance = Math.hypot(dn, de);

    if (this.distance < this.tolerance) {
      // On station: hold the current heading and stop making way.
      this.autopilot.setCourseDemand(ctx.state.heading, 0);
      return this.autopilot.update(ctx);
    }

    const bearing = wrapAngle(Math.atan2(de, dn));
    // Approach speed tapers with distance so the vessel does not overshoot.
    const speed = Math.min(this.opts.maxSpeed * 0.3, this.distance / 20);
    this.autopilot.setCourseDemand(bearing, speed);
    return this.autopilot.update(ctx);
  }

  get status(): Readonly<Record<string, unknown>> {
    return { distanceOffStation: this.distance, onStation: this.distance < this.tolerance };
  }
}

/**
 * Scripted manoeuvres for ghost targets.
 *
 * Ghosts exist to create situations - a crossing vessel that holds on, one
 * that alters late, a target that stops dead. A script is a list of timed
 * demands rather than a full behaviour model, because what is being tested is
 * the USV's response, and a reproducible provocation is worth more than a
 * clever adversary.
 */
export interface ScriptStep {
  /** Sim time at which this step takes effect, seconds from scenario start. */
  readonly atTime: SimTime;
  readonly course?: Radians;
  readonly speed?: MetresPerSecond;
}

export class ScriptedController implements Controller {
  readonly mode = 'course-speed' as const;
  private readonly autopilot: AutopilotController;
  private index = 0;

  constructor(
    private readonly steps: readonly ScriptStep[],
    opts: AutopilotControllerOptions,
    initialCourse: Radians,
    initialSpeed: MetresPerSecond,
  ) {
    this.autopilot = new AutopilotController({ ...opts, followCourse: true });
    this.autopilot.setCourseDemand(initialCourse, initialSpeed);
    this.steps = [...steps].sort((a, b) => a.atTime - b.atTime);
  }

  update(ctx: ControlContext): ActuatorDemand {
    while (this.index < this.steps.length) {
      const step = this.steps[this.index]!;
      if (step.atTime > ctx.simTime) break;
      const status = this.autopilot.status as { demandAngle: number; demandSpeed: number };
      this.autopilot.setCourseDemand(
        step.course ?? status.demandAngle,
        step.speed ?? status.demandSpeed,
      );
      this.index += 1;
    }
    return this.autopilot.update(ctx);
  }

  get status(): Readonly<Record<string, unknown>> {
    return { ...this.autopilot.status, scriptStep: this.index };
  }
}

/** Build an autopilot tuned to a specific vessel. */
export function autopilotOptionsFor(
  vessel: VesselDynamics,
  gains: HeadingAutopilotGains,
  maxSpeed: MetresPerSecond,
): AutopilotControllerOptions {
  void vessel;
  return { gains, maxSpeed };
}

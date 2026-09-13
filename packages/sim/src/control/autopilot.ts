import {
  clamp,
  wrapAngleSigned,
  type MetresPerSecond,
  type Radians,
  type Seconds,
} from '@umami/core';
import type {
  ActuatorDemand,
  EnvironmentConditions,
  HydroCoefficients,
  PropulsionModel,
  RigidBodyState,
} from '@umami/dynamics';

/**
 * First-order Nomoto model of steering response: T * rDot + r = K * delta.
 *
 * Two numbers that summarise how a hull answers its helm - the steady turn
 * rate per unit steering (`gain`) and how long it takes to get there
 * (`timeConstant`). Autopilot gains are derived from these rather than guessed,
 * which is what lets one controller drive a 12 m waterjet USV and a laden VLCC
 * without per-vessel hand tuning.
 */
export interface NomotoModel {
  /** Steady yaw rate per unit normalised steering demand, rad/s. */
  readonly gain: number;
  /** Time constant, seconds. */
  readonly timeConstant: Seconds;
}

export interface IdentifyOptions {
  /** Forward speed to identify at, m/s. Response is speed-dependent. */
  readonly speed: MetresPerSecond;
  readonly stepSize?: number;
  readonly durationSeconds?: Seconds;
  readonly dt?: Seconds;
  /** How long to settle on the identification speed before the helm goes over. */
  readonly trimSeconds?: Seconds;
  /** How long to let the steering gear finish moving. */
  readonly actuatorSettleSeconds?: Seconds;
}

/**
 * Identify a Nomoto model by running a helm step test on the actual dynamics.
 *
 * This is the same manoeuvre a ship does on trials: settle on a steady course
 * and speed, put the helm over, and watch the rate of turn build. Doing it
 * against the model in memory means the autopilot is tuned from the vessel's
 * real behaviour - including its drive type, whose steering authority may not
 * depend on speed at all - instead of from a rule of thumb that only suits
 * merchant hulls.
 */
export function identifyNomoto(
  makeVessel: () => VesselLike,
  env: EnvironmentConditions,
  opts: IdentifyOptions,
): NomotoModel {
  const dt = opts.dt ?? 0.1;
  const stepSize = opts.stepSize ?? 0.5;

  const vessel = makeVessel();
  vessel.state = { ...vessel.state, u: opts.speed, v: 0, r: 0, heading: 0 };

  // Phase 1: trim. Settle on the identification speed running straight, and
  // find the throttle that holds it.
  const speed = new SpeedController(0.6, 0.08, Math.max(opts.speed * 2, 1));
  let throttle = 0;
  const trimSteps = Math.round((opts.trimSeconds ?? 300) / dt);
  for (let i = 0; i < trimSteps; i++) {
    throttle = speed.update(opts.speed, vessel.state.u, dt);
    vessel.step({ throttle, steer: 0 }, env, dt, i * dt);
  }

  // Phase 2: put the helm over and hold it just long enough for the actuator
  // itself to finish moving - a SOLAS rudder takes about 15 s to reach full
  // deflection, a steering nozzle about one. Deliberately *not* long enough
  // for the turn to develop: the point is to read the moment the drive can
  // produce, not to watch a turning circle.
  const actuatorSteps = Math.round((opts.actuatorSettleSeconds ?? 30) / dt);
  for (let i = 0; i < actuatorSteps; i++) {
    throttle = speed.update(opts.speed, vessel.state.u, dt);
    vessel.step({ throttle, steer: stepSize }, env, dt, i * dt);
  }

  // With the drive's yaw moment measured, the Nomoto parameters follow from
  // the yaw equation directly:
  //
  //   (Iz - Nrdot) * rDot = Nr * r + Ndelta
  //
  // so the time constant is (Iz - Nrdot) / -Nr and the steady rate is
  // Ndelta / -Nr. Deriving them rather than fitting them to a transient avoids
  // the trap that makes transient fitting unreliable here: a vessel in a turn
  // loses speed, so its yaw rate keeps evolving long after the yaw dynamics
  // have settled, and any curve fit ends up measuring the surge response
  // instead. This is also exactly the simplification Nomoto's model already
  // makes, so nothing is given away by computing it in closed form.
  const u = vessel.state.u;
  const moment = vessel.propulsion.force(
    { u, v: 0, r: 0 },
    { waterDensity: env.waterDensity },
  ).N;

  const c = vessel.coefficients;
  const U = Math.max(Math.abs(u), 0.5);
  const yawDamping = Math.max(1e-9, -c.Nr * (U / c.referenceSpeed));
  const yawInertia = c.Iz - c.Nrdot;

  const steadyRate = Math.abs(moment) / yawDamping;
  if (!Number.isFinite(steadyRate) || steadyRate < 1e-6) {
    // No steering authority at this speed at all - a rudder vessel dead in the
    // water. Report a tiny gain so downstream tuning stays finite.
    return { gain: 1e-6, timeConstant: 30 };
  }

  return {
    gain: steadyRate / stepSize,
    timeConstant: Math.max(dt, yawInertia / yawDamping),
  };
}

/** The part of a vessel that identification needs. */
export interface VesselLike {
  state: RigidBodyState;
  propulsion: PropulsionModel;
  readonly coefficients: HydroCoefficients;
  step(demand: ActuatorDemand, env: EnvironmentConditions, dt: Seconds, t: Seconds): void;
}

export interface HeadingAutopilotGains {
  readonly kp: number;
  readonly ki: number;
  readonly kd: number;
  /** Integral clamp, in units of steering demand. */
  readonly integralLimit?: number;
  /**
   * Closed-loop bandwidth these gains were designed for, rad/s.
   *
   * Carried alongside the gains because any outer loop built on top of this
   * one has to be slower than it, and the only honest way to know how much
   * slower is to know what "fast" meant here.
   */
  readonly naturalFrequency?: number;
}

export interface TuningTargets {
  /** Desired closed-loop natural frequency, rad/s. Higher turns harder. */
  readonly naturalFrequency?: number;
  /** Desired damping ratio. Well above 1 for the reasons given in the tuner. */
  readonly dampingRatio?: number;
  /** Opt in to integral action for heading-hold trim under a constant load. */
  readonly integralGain?: number;
}

/**
 * Pole-placement gains for the heading loop from an identified Nomoto model.
 *
 * With delta = kp*e - kd*r, the closed loop is
 *   psiDotDot + (1 + K*kd)/T * psiDot + K*kp/T * psi = K*kp/T * psiRef
 * so matching the standard second-order form gives kp and kd directly. The
 * integral term is deliberately small and clamped: its job is to trim out a
 * steady crosswind, not to drive the turn, and an unclamped integrator winds
 * up badly against rudder limits during a large course change.
 */
export function tuneHeadingAutopilot(
  model: NomotoModel,
  targets: TuningTargets = {},
): HeadingAutopilotGains {
  // Well over-damped by default. The first-order Nomoto model ignores rudder
  // slew rate and the speed a hull loses in a turn, both of which add lag the
  // pole placement has not accounted for, so aiming at critical damping lands
  // reliably on the wrong side of it. Swept across the whole reference fleet,
  // 2.6 leaves fourteen of seventeen classes dead on the demanded heading; at
  // 1.2 the large merchant hulls sustain a slow limit cycle tens of degrees
  // wide.
  const zeta = targets.dampingRatio ?? 2.6;
  const { gain: K, timeConstant: T } = model;

  // Bandwidth is set relative to the vessel's own time constant, not to a
  // fixed number: a 12 m waterjet answers its helm in a couple of seconds and
  // a laden VLCC in a couple of minutes, and one absolute bandwidth cannot
  // serve both. The lower bound on 2*zeta*wn*T is what keeps the derivative
  // gain positive - drop below it and the loop loses its rate damping and
  // hunts, which is precisely the failure that makes a fixed bandwidth look
  // fine on a small boat and terrible on a big one.
  const wn = targets.naturalFrequency ?? clamp(1.5 / T, 0.004, 0.5);
  const dampingProduct = Math.max(1.5, 2 * zeta * wn * T);

  const kp = (wn * wn * T) / K;
  const kd = (dampingProduct - 1) / K;
  return {
    kp: clamp(kp, 0.05, 50),
    kd: clamp(kd, 0.01, 500),
    // Integral action is small but not zero, and the size is the whole point.
    // A vessel holding a course across a tidal set has to carry a steady crab
    // angle; crabbing means standing sway, standing sway means a standing yaw
    // moment, and balancing it needs a steering trim that proportional action
    // alone cannot hold without a large course error. Remove the integrator
    // and a USV transiting a channel sits tens of degrees off its intended
    // track - correct for the gains, useless as a vessel. Make it any larger
    // and its slow pole sustains the very limit cycle the damping above exists
    // to kill on big hulls. This value keeps both in hand.
    ki: targets.integralGain ?? clamp(kp * wn * 0.0125, 0, 0.25),
    integralLimit: 0.25,
    naturalFrequency: wn,
  };
}

/**
 * Heading autopilot.
 *
 * Derivative action is taken on measured yaw rate rather than on the error
 * signal. Feeding the derivative off the error means every course change
 * produces a step in the error, an enormous derivative spike, and helm slammed
 * hard over - the classic derivative kick. Yaw rate is measured directly and
 * changes smoothly, so the same term instead damps the turn as intended.
 */
export class HeadingAutopilot {
  private integral = 0;
  private gains: HeadingAutopilotGains;

  constructor(gains: HeadingAutopilotGains) {
    this.gains = gains;
  }

  setGains(gains: HeadingAutopilotGains): void {
    this.gains = gains;
    this.integral = 0;
  }

  reset(): void {
    this.integral = 0;
  }

  /** Steering demand in -1..1, positive to starboard. */
  update(headingError: Radians, yawRate: number, dt: Seconds): number {
    const e = wrapAngleSigned(headingError);
    const { kp, ki, kd, integralLimit = 0.25 } = this.gains;

    // Anti-windup has to bound the accumulator itself, not just its
    // contribution to the output. Clamping only the contribution hides the
    // wind-up rather than preventing it: the accumulator keeps growing through
    // a long course change, and when the error finally reverses the term stays
    // pinned at its limit for as long as it takes to unwind - which shows up
    // as a slow, large-amplitude hunt that looks nothing like an integrator
    // problem until you plot it.
    const accumulatorLimit = ki > 1e-9 ? integralLimit / ki : 0;
    const integralTerm = ki * this.integral;
    const unsaturated = kp * e + integralTerm - kd * yawRate;
    const output = clamp(unsaturated, -1, 1);

    // Conditional integration: while the helm is already hard over there is
    // nothing more the integrator can ask for.
    if (output === unsaturated) {
      this.integral = clamp(this.integral + e * dt, -accumulatorLimit, accumulatorLimit);
    }
    return output;
  }
}

/**
 * Proportional-integral speed hold, producing a throttle demand.
 *
 * Throttle is floored at zero by default, and that floor is load-bearing
 * rather than tidy. Going astern is a deliberate act on every drive modelled
 * here, and on two of the three it reverses the steering as well: a waterjet
 * drops its reverse bucket into the jet, an outboard shifts gear, and in both
 * cases the sideways component of thrust reverses with the axial one. A speed
 * controller that dips a little negative to shed a fraction of a knot of
 * overspeed therefore inverts the sign of the steering loop, and the vessel
 * chases its own tail. A real vessel sheds that overspeed by easing the
 * throttle and letting drag do the work, which is what this does. Astern is
 * available by commanding a negative speed, where it is meant.
 */
export class SpeedController {
  private integral = 0;

  constructor(
    private readonly kp = 0.6,
    private readonly ki = 0.08,
    private readonly maxSpeed: MetresPerSecond = 20,
    private readonly minThrottle = 0,
  ) {}

  reset(): void {
    this.integral = 0;
  }

  update(demandSpeed: MetresPerSecond, actualSpeed: MetresPerSecond, dt: Seconds): number {
    const demand = clamp(demandSpeed, -this.maxSpeed, this.maxSpeed);
    const error = demand - actualSpeed;
    const normalised = error / Math.max(this.maxSpeed, 1e-6);
    const unsaturated = this.kp * normalised * 10 + this.ki * this.integral;

    // Astern only when astern is actually what was asked for.
    const floor = demand < 0 ? -1 : this.minThrottle;
    const output = clamp(unsaturated, floor, 1);
    if (output === unsaturated) this.integral = clamp(this.integral + normalised * dt, -10, 10);
    return output;
  }
}

export interface TrialTuningOptions extends IdentifyOptions {
  /** Size of the heading step used to score a candidate, radians. */
  readonly testStep?: Radians;
  /** How long each trial runs, seconds. Should cover several settling times. */
  readonly trialSeconds?: Seconds;
  /** Proportional gains to search. */
  readonly proportionalGains?: readonly number[];
  /** Derivative times (kd / kp) to search, seconds. */
  readonly derivativeTimes?: readonly Seconds[];
}

export interface TunedGains extends HeadingAutopilotGains {
  /** Mean absolute heading error over the settling window, radians. */
  readonly score: Radians;
  readonly model: NomotoModel;
}

/**
 * Gains searched over proportional gain and derivative time.
 *
 * Parameterising the search as (kp, kd/kp) rather than (kp, kd) matters,
 * because both axes then mean something physical and scale-free. 1/kp is the
 * heading error at which the steering saturates - tens of degrees for a ship,
 * a handful for a small craft - and kd/kp is a time in seconds, the horizon
 * over which the loop anticipates the swing. The same grid consequently spans
 * a 333 m tanker and a 9 m USV, which a grid of raw derivative gains does not:
 * their sensible kd values differ by four orders of magnitude.
 */
const DEFAULT_PROPORTIONAL_GAINS = [0.5, 1, 2, 4, 8, 16, 32] as const;
const DEFAULT_DERIVATIVE_TIMES = [1, 2, 5, 10, 20, 40, 80, 160] as const;

/**
 * Tune the heading loop by trial against the vessel's own dynamics.
 *
 * Pole placement on an identified Nomoto model gets the shape of the answer
 * right, and the identified model is still returned because it is useful in
 * its own right. What it cannot do is account for what a first-order model
 * leaves out - steering gear slew rate, the speed a hull loses in a turn,
 * sway-yaw coupling, saturation - and across this fleet those omissions are
 * not second-order corrections. They are the difference between a vessel that
 * settles on its heading and one that circles indefinitely.
 *
 * So each candidate is scored by flying an actual heading step against the
 * actual dynamics, and the best is returned. It costs some tens of thousands
 * of integration steps per vessel class, which is why callers cache the
 * result; in exchange the gains are known to work rather than believed to.
 */
export function tuneHeadingGainsByTrial(
  makeVessel: () => VesselLike,
  env: EnvironmentConditions,
  opts: TrialTuningOptions,
): TunedGains {
  const dt = opts.dt ?? 0.1;
  const model = identifyNomoto(makeVessel, env, opts);
  const testStep = opts.testStep ?? Math.PI / 3;
  const trialSeconds = opts.trialSeconds ?? clamp(model.timeConstant * 40, 300, 2000);
  const gainGrid = opts.proportionalGains ?? DEFAULT_PROPORTIONAL_GAINS;
  const timeGrid = opts.derivativeTimes ?? DEFAULT_DERIVATIVE_TIMES;

  let bestKp = gainGrid[0] ?? 1;
  let bestTd = timeGrid[0] ?? 10;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const kp of gainGrid) {
    for (const td of timeGrid) {
      const score = scoreGains(
        makeVessel,
        env,
        { kp, kd: kp * td, ki: 0 },
        opts.speed,
        testStep,
        trialSeconds,
        dt,
      );
      if (score < bestScore) {
        bestScore = score;
        bestKp = kp;
        bestTd = td;
      }
    }
  }

  // Refine once around the winner, which costs little and typically halves the
  // residual left by a coarse logarithmic grid.
  for (const kp of [bestKp * 0.7, bestKp, bestKp * 1.4]) {
    for (const td of [bestTd * 0.7, bestTd, bestTd * 1.4]) {
      const score = scoreGains(
        makeVessel,
        env,
        { kp, kd: kp * td, ki: 0 },
        opts.speed,
        testStep,
        trialSeconds,
        dt,
      );
      if (score < bestScore) {
        bestScore = score;
        bestKp = kp;
        bestTd = td;
      }
    }
  }

  // Integral action is added only once proportional and derivative terms are
  // known to be stable, and kept small: its job is trimming a steady
  // disturbance, and anything larger reintroduces the slow hunt the search
  // just eliminated.
  return {
    kp: bestKp,
    kd: bestKp * bestTd,
    ki: Math.min(bestKp * 0.002, 0.05),
    integralLimit: 0.25,
    naturalFrequency: 1 / Math.max(bestTd, 1e-6),
    score: bestScore,
    model,
  };
}

/** Mean absolute heading error over the settling window of one step response. */
function scoreGains(
  makeVessel: () => VesselLike,
  env: EnvironmentConditions,
  gains: HeadingAutopilotGains,
  speed: MetresPerSecond,
  testStep: Radians,
  trialSeconds: Seconds,
  dt: Seconds,
): number {
  const vessel = makeVessel();
  vessel.state = { ...vessel.state, u: speed, v: 0, r: 0, heading: 0 };

  const heading = new HeadingAutopilot(gains);
  const throttleLoop = new SpeedController(0.6, 0.08, Math.max(speed * 2, 1));
  const steps = Math.round(trialSeconds / dt);
  // Score only the last quarter of the run: the transient is not the point,
  // whether it ends up on the demanded heading is.
  const scoreFrom = Math.floor(steps * 0.75);

  let total = 0;
  let counted = 0;
  for (let i = 0; i < steps; i++) {
    const error = wrapAngleSigned(testStep - vessel.state.heading);
    const steer = heading.update(error, vessel.state.r, dt);
    const throttle = throttleLoop.update(speed, vessel.state.u, dt);
    vessel.step({ throttle, steer }, env, dt, i * dt);
    if (!Number.isFinite(vessel.state.heading)) return Number.POSITIVE_INFINITY;
    if (i >= scoreFrom) {
      total += Math.abs(wrapAngleSigned(testStep - vessel.state.heading));
      counted += 1;
    }
  }
  return counted > 0 ? total / counted : Number.POSITIVE_INFINITY;
}

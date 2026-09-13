import type { Seconds } from './units.js';

/**
 * Simulation time, seconds since the scenario epoch.
 *
 * Deliberately distinct from wall-clock time: the simulation may run paused,
 * in real time, or at 100x for batch algorithm evaluation, and every consumer
 * must be written against sim time so that all three behave identically.
 */
export type SimTime = Seconds;

/** Unix epoch milliseconds. Used only at the AIS and recording boundaries. */
export type UnixMillis = number;

export interface ClockOptions {
  /** Wall-clock instant that sim time zero corresponds to. */
  readonly epoch: UnixMillis;
  /** Fixed integration step. Defaults to 0.1 s (10 Hz). */
  readonly stepSeconds?: Seconds;
  /** Sim seconds per wall-clock second. 0 pauses. Defaults to 1. */
  readonly timeScale?: number;
}

/**
 * Fixed-step simulation clock.
 *
 * The integrator always advances by exactly `stepSeconds`, independent of
 * frame rate or wall-clock jitter. This is what makes a run reproducible:
 * the same scenario and seed produce bit-identical output whether it was
 * rendered at 60 fps on a phone or executed headless in CI.
 */
export class SimClock {
  readonly epoch: UnixMillis;
  readonly stepSeconds: Seconds;
  private _time: SimTime = 0;
  private _tick = 0;
  private _timeScale: number;
  /** Sim-time debt accumulated from wall-clock advance, not yet consumed by a step. */
  private accumulator: Seconds = 0;

  constructor(opts: ClockOptions) {
    this.epoch = opts.epoch;
    this.stepSeconds = opts.stepSeconds ?? 0.1;
    this._timeScale = opts.timeScale ?? 1;
  }

  get time(): SimTime {
    return this._time;
  }
  get tick(): number {
    return this._tick;
  }
  get timeScale(): number {
    return this._timeScale;
  }
  set timeScale(v: number) {
    this._timeScale = Math.max(0, v);
  }
  get paused(): boolean {
    return this._timeScale === 0;
  }
  /** Wall-clock instant corresponding to the current sim time. */
  get wallClock(): UnixMillis {
    return this.epoch + this._time * 1000;
  }

  /** Advance exactly one fixed step. The only place sim time moves. */
  advance(): SimTime {
    this._time += this.stepSeconds;
    this._tick += 1;
    return this._time;
  }

  /**
   * Convert elapsed wall-clock time into a whole number of fixed steps.
   *
   * `maxSteps` bounds the catch-up work after a stall (a backgrounded tab, a
   * slow frame) so the simulation degrades by slipping behind real time rather
   * than by freezing while it tries to replay minutes of backlog.
   */
  stepsForElapsed(wallDeltaSeconds: Seconds, maxSteps = 20): number {
    this.accumulator += wallDeltaSeconds * this._timeScale;
    const n = Math.floor(this.accumulator / this.stepSeconds);
    if (n <= 0) return 0;
    const capped = Math.min(n, maxSteps);
    this.accumulator -= capped * this.stepSeconds;
    if (capped < n) this.accumulator = 0; // dropped backlog; do not try to catch up
    return capped;
  }
}

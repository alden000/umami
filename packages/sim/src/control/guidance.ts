import {
  clamp,
  crossTrackDistance,
  haversineDistance,
  initialBearing,
  wrapAngle,
  type LatLon,
  type Metres,
  type MetresPerSecond,
  type Radians,
} from '@umami/core';

/** One point on a route. */
export interface Waypoint {
  readonly position: LatLon;
  /** Speed to make good on the leg approaching this point, m/s. */
  readonly speed?: MetresPerSecond;
  /** Radius at which the waypoint counts as reached, metres. */
  readonly arrivalRadius?: Metres;
  readonly name?: string;
}

export interface Route {
  readonly waypoints: readonly Waypoint[];
  /** Return to the first waypoint after the last. */
  readonly loop?: boolean;
}

export interface GuidanceOutput {
  /** Course to steer, radians from true north. */
  readonly courseDemand: Radians;
  readonly speedDemand: MetresPerSecond;
  /** Signed distance off the intended track, metres; positive to starboard. */
  readonly crossTrackError: Metres;
  readonly activeLeg: number;
  readonly distanceToWaypoint: Metres;
  readonly complete: boolean;
}

export interface LineOfSightOptions {
  /**
   * Look-ahead distance, metres.
   *
   * The controller aims at a point this far along the intended track rather
   * than at the waypoint itself. Short look-ahead converges fast but weaves;
   * long look-ahead is stable but cuts corners. Scaling it with vessel length
   * keeps the behaviour consistent across a 9 m USV and a 300 m ship.
   */
  readonly lookAheadDistance?: Metres;
  /** Default arrival radius when a waypoint does not set one, metres. */
  readonly defaultArrivalRadius?: Metres;
  /** Fallback speed when neither the waypoint nor the caller supplies one. */
  readonly defaultSpeed?: MetresPerSecond;
}

/**
 * Line-of-sight track-keeping guidance.
 *
 * Converts a route into a course and speed to steer, which the heading
 * autopilot then holds. Keeping guidance and control separate is what lets the
 * external interface expose both of the modes you asked for over one API: an
 * external system can supply waypoints and let this run, or bypass it entirely
 * and command course and speed directly into the same autopilot.
 *
 * Steering toward a point ahead on the track, rather than at the waypoint,
 * makes the vessel rejoin the intended line after being set off it by wind or
 * tide instead of merely aiming at the mark from wherever it has drifted to.
 */
export class LineOfSightGuidance {
  private legIndex = 0;
  private finished = false;

  constructor(
    private route: Route,
    private readonly opts: LineOfSightOptions = {},
  ) {}

  setRoute(route: Route): void {
    this.route = route;
    this.legIndex = 0;
    this.finished = false;
  }

  get activeLeg(): number {
    return this.legIndex;
  }

  get complete(): boolean {
    return this.finished;
  }

  /** Skip to a specific leg, as a bridge operator would. */
  setActiveLeg(index: number): void {
    this.legIndex = clamp(index, 0, Math.max(0, this.route.waypoints.length - 1));
    this.finished = false;
  }

  update(position: LatLon, fallbackCourse: Radians): GuidanceOutput {
    const wps = this.route.waypoints;
    const defaultSpeed = this.opts.defaultSpeed ?? 0;

    if (wps.length === 0 || this.finished) {
      return {
        courseDemand: fallbackCourse,
        speedDemand: this.finished ? 0 : defaultSpeed,
        crossTrackError: 0,
        activeLeg: this.legIndex,
        distanceToWaypoint: 0,
        complete: this.finished,
      };
    }

    const target = wps[Math.min(this.legIndex, wps.length - 1)]!;
    const distance = haversineDistance(position, target.position);
    const arrivalRadius = target.arrivalRadius ?? this.opts.defaultArrivalRadius ?? 50;

    if (distance <= arrivalRadius) {
      const next = this.legIndex + 1;
      if (next >= wps.length) {
        if (this.route.loop) {
          this.legIndex = 0;
        } else {
          this.finished = true;
          return {
            courseDemand: fallbackCourse,
            speedDemand: 0,
            crossTrackError: 0,
            activeLeg: this.legIndex,
            distanceToWaypoint: distance,
            complete: true,
          };
        }
      } else {
        this.legIndex = next;
      }
      return this.update(position, fallbackCourse);
    }

    // The leg being followed runs from the previous waypoint to the active one.
    // With no previous waypoint there is no track to keep, so steer direct.
    const previous = this.legIndex > 0 ? wps[this.legIndex - 1] : undefined;
    const bearingToTarget = initialBearing(position, target.position);

    let courseDemand = bearingToTarget;
    let xte = 0;

    if (previous) {
      xte = crossTrackDistance(position, previous.position, target.position);
      const legBearing = initialBearing(previous.position, target.position);
      const lookAhead = Math.max(1, this.opts.lookAheadDistance ?? 200);
      // Steer off the leg by an angle that closes the cross-track error over
      // the look-ahead distance, converging asymptotically onto the track.
      courseDemand = wrapAngle(legBearing + Math.atan2(-xte, lookAhead));
    }

    return {
      courseDemand,
      speedDemand: target.speed ?? defaultSpeed,
      crossTrackError: xte,
      activeLeg: this.legIndex,
      distanceToWaypoint: distance,
      complete: false,
    };
  }
}

/** Look-ahead distance scaled to vessel size, bounded to sensible limits. */
export function defaultLookAhead(loa: Metres): Metres {
  return clamp(loa * 8, 60, 2000);
}

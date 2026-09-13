import {
  degrees,
  knots,
  type LatLon,
  type MetresPerSecond,
  type Radians,
} from '@umami/core';
import {
  SEAWATER_DENSITY,
  VESSEL_CLASSES,
  createVessel,
  deriveHydroCoefficients,
  type EnvironmentConditions,
  type VesselClassId,
} from '@umami/dynamics';
import { World, type WorldOptions } from './world.js';
import {
  ActuatorController,
  AutopilotController,
  IdleController,
  ScriptedController,
  StationKeepController,
  WaypointController,
  courseTrimRateFor,
  tuneHeadingGainsByTrial,
  type Controller,
  type ScriptStep,
  type Waypoint,
} from './control/index.js';

/**
 * Scenario definition.
 *
 * Plain data, in marine units, so a scenario is something a mariner can write
 * and review rather than something only a programmer can produce. Degrees and
 * knots here; the loader converts once, at the boundary. Everything needed to
 * reproduce a run exactly is in this object, including the random seed.
 */
export interface ScenarioDefinition {
  readonly name: string;
  readonly description?: string;
  /** Chart datum position the tangent plane is anchored to. */
  readonly origin: { readonly lat: number; readonly lon: number };
  /** Wall-clock start, ISO 8601. Determines lighting and tidal phase downstream. */
  readonly startTime?: string;
  readonly seed?: number;
  readonly stepSeconds?: number;
  readonly environment?: ScenarioEnvironment;
  readonly ownShip?: ScenarioVessel;
  readonly ghosts?: readonly ScenarioVessel[];
  readonly ais?: ScenarioAisConfig;
}

export interface ScenarioEnvironment {
  /** Direction the wind blows from, compass degrees. */
  readonly windFromDegrees?: number;
  readonly windSpeedKnots?: number;
  /** Direction the tidal stream sets toward, compass degrees. */
  readonly currentSetDegrees?: number;
  readonly currentDriftKnots?: number;
  readonly significantWaveHeightMetres?: number;
  readonly wavePeriodSeconds?: number;
  readonly waveDirectionDegrees?: number;
}

export interface ScenarioVessel {
  readonly id?: string;
  readonly name?: string;
  readonly mmsi?: number;
  readonly vesselClass: VesselClassId;
  readonly position: { readonly lat: number; readonly lon: number };
  /** Initial heading, compass degrees. */
  readonly headingDegrees?: number;
  readonly speedKnots?: number;
  readonly control?: ScenarioControl;
  /** Override principal particulars, e.g. to match a real vessel. */
  readonly particulars?: {
    readonly loa?: number;
    readonly beam?: number;
    readonly draught?: number;
  };
}

export type ScenarioControl =
  | { readonly mode: 'idle' }
  | { readonly mode: 'actuator' }
  | { readonly mode: 'heading-speed'; readonly headingDegrees: number; readonly speedKnots: number }
  | { readonly mode: 'course-speed'; readonly courseDegrees: number; readonly speedKnots: number }
  | {
      readonly mode: 'waypoint';
      readonly waypoints: readonly {
        readonly lat: number;
        readonly lon: number;
        readonly speedKnots?: number;
        readonly arrivalRadiusMetres?: number;
        readonly name?: string;
      }[];
      readonly loop?: boolean;
    }
  | {
      readonly mode: 'station-keep';
      readonly lat: number;
      readonly lon: number;
      readonly toleranceMetres?: number;
    }
  | {
      readonly mode: 'script';
      readonly initialCourseDegrees: number;
      readonly initialSpeedKnots: number;
      readonly steps: readonly {
        readonly atSeconds: number;
        readonly courseDegrees?: number;
        readonly speedKnots?: number;
      }[];
    };

export interface ScenarioAisConfig {
  /** Which configured source to attach. Wiring lives in the host application. */
  readonly source?: 'aisstream' | 'replay' | 'none';
  readonly boundingBox?: {
    readonly south: number;
    readonly west: number;
    readonly north: number;
    readonly east: number;
  };
  /** Path or URL to a recording, for the replay source. */
  readonly recording?: string;
  readonly replaySpeed?: number;
}

function toEnvironment(env: ScenarioEnvironment | undefined): EnvironmentConditions {
  return {
    wind: {
      fromRadians: degrees(env?.windFromDegrees ?? 0),
      speed: knots(env?.windSpeedKnots ?? 0),
    },
    current: {
      setRadians: degrees(env?.currentSetDegrees ?? 0),
      driftSpeed: knots(env?.currentDriftKnots ?? 0),
    },
    sea: {
      significantWaveHeight: env?.significantWaveHeightMetres ?? 0,
      directionRadians: degrees(env?.waveDirectionDegrees ?? env?.windFromDegrees ?? 0),
      peakPeriod: env?.wavePeriodSeconds ?? 8,
    },
    waterDensity: SEAWATER_DENSITY,
  };
}

/**
 * Autopilot gains for a specific vessel, from a step test on its own dynamics.
 *
 * Results are cached per vessel class and speed because identification costs a
 * few thousand integration steps, and a scenario with fifty ghosts of the same
 * class would otherwise repeat identical work fifty times.
 */
const gainCache = new Map<string, ReturnType<typeof tuneHeadingGainsByTrial>>();

export function gainsForClass(
  vesselClass: VesselClassId,
  speed: MetresPerSecond,
): ReturnType<typeof tuneHeadingGainsByTrial> {
  const key = `${vesselClass}@${speed.toFixed(1)}`;
  const cached = gainCache.get(key);
  if (cached) return cached;

  const tuned = tuneHeadingGainsByTrial(() => createVessel(vesselClass), toEnvironment(undefined), {
    speed: Math.max(speed, 0.5),
  });
  gainCache.set(key, tuned);
  return tuned;
}

/**
 * The speed a controller is expected to operate at.
 *
 * Steering authority is speed-dependent for every drive type, but for
 * different reasons: a rudder's authority grows with the square of the flow
 * over it, while a waterjet's grows with throttle, which at low commanded
 * speed is barely open. Either way, gains identified at full speed leave a
 * vessel sluggish and overshooting when it is asked to proceed slowly, so
 * identification is done at the speed the vessel will actually be doing.
 */
function referenceSpeedFor(
  spec: ScenarioControl | undefined,
  maxSpeed: MetresPerSecond,
): MetresPerSecond {
  const fallback = maxSpeed * 0.6;
  switch (spec?.mode) {
    case 'heading-speed':
      return knots(spec.speedKnots);
    case 'course-speed':
      return knots(spec.speedKnots);
    case 'script':
      return knots(spec.initialSpeedKnots);
    case 'waypoint': {
      const speeds = spec.waypoints
        .map((w) => w.speedKnots)
        .filter((v): v is number => v !== undefined);
      return speeds.length ? knots(Math.max(...speeds)) : fallback;
    }
    case 'station-keep':
      // Station keeping happens at little or no way on.
      return maxSpeed * 0.25;
    default:
      return fallback;
  }
}

function buildController(
  spec: ScenarioControl | undefined,
  vesselClass: VesselClassId,
  maxSpeed: MetresPerSecond,
  loa: number,
): Controller {
  const gains = gainsForClass(vesselClass, referenceSpeedFor(spec, maxSpeed));
  const base = {
    gains,
    maxSpeed,
    courseTrimRate: courseTrimRateFor(gains.model, gains.kp),
  };

  switch (spec?.mode) {
    case 'actuator':
      return new ActuatorController();
    case 'heading-speed': {
      const c = new AutopilotController(base);
      c.setHeadingDemand(degrees(spec.headingDegrees), knots(spec.speedKnots));
      return c;
    }
    case 'course-speed': {
      const c = new AutopilotController({ ...base, followCourse: true });
      c.setCourseDemand(degrees(spec.courseDegrees), knots(spec.speedKnots));
      return c;
    }
    case 'waypoint': {
      const waypoints: Waypoint[] = spec.waypoints.map((w) => ({
        position: { lat: w.lat, lon: w.lon },
        speed: w.speedKnots === undefined ? undefined : knots(w.speedKnots),
        arrivalRadius: w.arrivalRadiusMetres,
        name: w.name,
      }));
      return new WaypointController({
        ...base,
        route: { waypoints, loop: spec.loop },
        lookAheadDistance: Math.max(60, loa * 8),
        defaultSpeed: maxSpeed * 0.6,
        defaultArrivalRadius: Math.max(30, loa * 2),
      });
    }
    case 'station-keep':
      return new StationKeepController({
        ...base,
        target: { lat: spec.lat, lon: spec.lon },
        tolerance: spec.toleranceMetres,
      });
    case 'script': {
      const steps: ScriptStep[] = spec.steps.map((s) => ({
        atTime: s.atSeconds,
        course: s.courseDegrees === undefined ? undefined : degrees(s.courseDegrees),
        speed: s.speedKnots === undefined ? undefined : knots(s.speedKnots),
      }));
      return new ScriptedController(
        steps,
        base,
        degrees(spec.initialCourseDegrees),
        knots(spec.initialSpeedKnots),
      );
    }
    default:
      return new IdleController();
  }
}

export interface LoadedScenario {
  readonly world: World;
  readonly definition: ScenarioDefinition;
}

/** Build a ready-to-run world from a scenario definition. */
export function loadScenario(
  definition: ScenarioDefinition,
  overrides: Partial<WorldOptions> = {},
): LoadedScenario {
  const origin: LatLon = definition.origin;
  const epoch = definition.startTime ? Date.parse(definition.startTime) : Date.now();

  const world = new World({
    origin,
    epoch: Number.isFinite(epoch) ? epoch : Date.now(),
    stepSeconds: definition.stepSeconds ?? 0.1,
    environment: toEnvironment(definition.environment),
    ...overrides,
  });

  const add = (spec: ScenarioVessel, kind: 'usv' | 'ghost'): void => {
    const dynamics = createVessel(spec.vesselClass, { particulars: spec.particulars });
    const maxSpeed = estimateMaxSpeed(spec.vesselClass);
    world.addEntity({
      id: (spec.id ?? `${kind}-${spec.name ?? spec.mmsi ?? Math.random().toString(36).slice(2, 8)}`) as never,
      kind,
      dynamics,
      controller: buildController(spec.control, spec.vesselClass, maxSpeed, dynamics.particulars.loa),
      identity: { name: spec.name, mmsi: spec.mmsi },
      initialPosition: spec.position,
      initialHeading: degrees(spec.headingDegrees ?? 0),
      initialSpeed: knots(spec.speedKnots ?? 0),
    });
  };

  if (definition.ownShip) add(definition.ownShip, 'usv');
  for (const ghost of definition.ghosts ?? []) add(ghost, 'ghost');

  return { world, definition };
}

/**
 * Top speed for a class, used to scale controller limits.
 *
 * Solved from the drag balance rather than read off the service speed, so it
 * reflects the thrust actually installed - including the margin over service
 * resistance. The class's own resistance coefficient must be used here: taking
 * the default instead understates drag for a small craft and overstates its
 * top speed by 30% or more, which then mistunes every controller built on it.
 */
function estimateMaxSpeed(vesselClass: VesselClassId): MetresPerSecond {
  const def = VESSEL_CLASSES[vesselClass];
  const vessel = createVessel(vesselClass);
  const coeffs = deriveHydroCoefficients(vessel.particulars, def.deriveOptions);
  const thrust = vessel.propulsion.maxAheadThrust;
  return Math.sqrt(Math.max(0, thrust / Math.abs(coeffs.Xuu)));
}

export type { Radians };

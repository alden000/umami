import type { LatLon, MetresPerSecond, Radians, SimTime, UnixMillis } from '@umami/core';

/** Where an object in the picture came from. */
export type ObjectSource = 'simulated' | 'ais';

export type ObjectKind = 'usv' | 'ghost' | 'ais-contact' | 'aton';

export interface ObjectIdentity {
  readonly mmsi?: number;
  readonly name?: string;
  readonly callSign?: string;
  readonly imoNumber?: number;
  /** AIS ship and cargo type. */
  readonly shipType?: number;
  readonly destination?: string;
}

export interface ObjectDimensions {
  readonly loa?: number;
  readonly beam?: number;
  readonly draught?: number;
}

/**
 * Attitude out of the horizontal plane.
 *
 * Carried but never fed back into the equations of motion: the simulation is
 * planar. It exists so a future 3D view has vessel attitude available without
 * the sim core growing a six-degree-of-freedom model, and so a 2D display can
 * show heel in a turn.
 */
export interface ObjectAttitude {
  readonly roll: Radians;
  readonly pitch: Radians;
  readonly heave: number;
}

/** One object as the renderer, the recorder and the control bridge all see it. */
export interface WorldObject {
  readonly id: string;
  readonly kind: ObjectKind;
  readonly source: ObjectSource;
  readonly position: LatLon;
  /** True heading where known. Undefined for contacts reporting course only. */
  readonly heading?: Radians;
  readonly cog?: Radians;
  readonly sog?: MetresPerSecond;
  readonly rateOfTurn?: number;
  readonly navigationStatus?: number;
  readonly identity: ObjectIdentity;
  readonly dimensions: ObjectDimensions;
  readonly attitude?: ObjectAttitude;
  /** Drive positions: nozzle angle, rudder angle, shaft fraction and so on. */
  readonly actuators?: Readonly<Record<string, number>>;
  /** True when the position is dead-reckoned rather than freshly reported. */
  readonly extrapolated?: boolean;
  /** Wall-clock time of the last real report, for AIS-derived objects. */
  readonly lastReportAt?: UnixMillis;
}

export interface EnvironmentSnapshot {
  readonly windFromRadians: Radians;
  readonly windSpeed: MetresPerSecond;
  readonly currentSetRadians: Radians;
  readonly currentDriftSpeed: MetresPerSecond;
  readonly significantWaveHeight: number;
}

/**
 * The complete observable state of the world at one instant.
 *
 * This is the only thing that crosses the boundary out of the simulation core.
 * Renderers, recorders, the external control bridge and any future 3D view all
 * consume snapshots and nothing else, which is what keeps the core free of any
 * dependency on how - or whether - it is being displayed. It is deliberately
 * plain JSON-serialisable data so the same snapshot can be drawn locally,
 * pushed down a WebSocket to a remote client, or written to a file for replay.
 */
export interface WorldSnapshot {
  readonly simTime: SimTime;
  readonly wallClock: UnixMillis;
  readonly tick: number;
  readonly timeScale: number;
  readonly ownShipId?: string;
  readonly objects: readonly WorldObject[];
  readonly environment: EnvironmentSnapshot;
}

/** Trim a snapshot to objects within a radius, for bandwidth-limited clients. */
export function filterByRange(
  snapshot: WorldSnapshot,
  centre: LatLon,
  radiusMetres: number,
  distance: (a: LatLon, b: LatLon) => number,
): WorldSnapshot {
  return {
    ...snapshot,
    objects: snapshot.objects.filter((o) => distance(centre, o.position) <= radiusMetres),
  };
}

import {
  EventBus,
  IdAllocator,
  SimClock,
  TangentPlane,
  entityId,
  knots,
  mmsiToEntityId,
  type EntityId,
  type LatLon,
  type MetresPerSecond,
  type Radians,
  type Seconds,
  type SimTime,
  type UnixMillis,
} from '@umami/core';
import {
  CALM_CONDITIONS,
  createVessel,
  vesselClassForAisType,
  type EnvironmentConditions,
  type VesselClassId,
} from '@umami/dynamics';
import { TrackManager, type AisContact, type AisMessage, type AisSource } from '@umami/ais';
import { SimulatedEntity, type SimulatedEntityOptions } from './entity.js';
import { IdleController, type Controller } from './control/controller.js';
import type { WorldObject, WorldSnapshot } from './snapshot.js';

export interface WorldOptions {
  /** Geodetic origin of the local tangent plane. Usually the area of interest. */
  readonly origin: LatLon;
  /** Wall-clock instant that sim time zero represents. */
  readonly epoch?: UnixMillis;
  readonly stepSeconds?: Seconds;
  readonly timeScale?: number;
  readonly environment?: EnvironmentConditions;
  readonly trackManager?: TrackManager;
  /** Radius beyond which the tangent plane is re-anchored, metres. */
  readonly rebaseRadius?: number;
}

export interface WorldEvents extends Record<string, unknown> {
  /** Emitted once per fixed step, after integration. */
  stepped: { readonly simTime: SimTime; readonly tick: number };
  entityAdded: { readonly id: EntityId };
  entityRemoved: { readonly id: EntityId };
  /** Emitted when the tangent plane is re-anchored; renderers may ignore it. */
  rebased: { readonly origin: LatLon };
}

/**
 * The simulated world.
 *
 * Holds three quite different populations and keeps them distinct on purpose:
 *
 *  - the own USV and any ghost targets, which are integrated forward by the
 *    dynamics model every step;
 *  - AIS contacts, which are observations of real or replayed vessels and are
 *    never integrated - only interpolated between the reports that arrive;
 *  - the environment, shared by all of them.
 *
 * Conflating the first two is the most tempting mistake available here, and it
 * quietly destroys the value of the tool: a real vessel's track is evidence,
 * and smoothing it through a motion model would turn measured behaviour into
 * modelled behaviour without anyone noticing.
 *
 * The world has no dependency on rendering, on a network, or on the platform.
 * It runs identically in a browser tab, in a Node process in CI, and inside a
 * server driving many clients.
 */
export class World {
  readonly clock: SimClock;
  readonly bus = new EventBus<WorldEvents>();
  readonly tracks: TrackManager;

  private _plane: TangentPlane;
  private readonly entities = new Map<EntityId, SimulatedEntity>();
  private readonly ids = new IdAllocator();
  private readonly sources = new Map<string, AisSource>();
  private readonly sourceCleanup = new Map<string, () => void>();
  private _environment: EnvironmentConditions;
  private _ownShipId?: EntityId;
  private readonly rebaseRadius: number;

  constructor(opts: WorldOptions) {
    this._plane = new TangentPlane(opts.origin);
    this.clock = new SimClock({
      epoch: opts.epoch ?? Date.now(),
      stepSeconds: opts.stepSeconds ?? 0.1,
      timeScale: opts.timeScale ?? 1,
    });
    this._environment = opts.environment ?? CALM_CONDITIONS;
    this.tracks = opts.trackManager ?? new TrackManager();
    this.rebaseRadius = opts.rebaseRadius ?? 50_000;
  }

  get plane(): TangentPlane {
    return this._plane;
  }

  get environment(): EnvironmentConditions {
    return this._environment;
  }

  setEnvironment(env: EnvironmentConditions): void {
    this._environment = env;
  }

  get ownShipId(): EntityId | undefined {
    return this._ownShipId;
  }

  get ownShip(): SimulatedEntity | undefined {
    return this._ownShipId ? this.entities.get(this._ownShipId) : undefined;
  }

  getEntity(id: EntityId): SimulatedEntity | undefined {
    return this.entities.get(id);
  }

  allEntities(): SimulatedEntity[] {
    return [...this.entities.values()];
  }

  /** Add a fully constructed entity. */
  addEntity(opts: SimulatedEntityOptions): SimulatedEntity {
    const entity = new SimulatedEntity(opts, this._plane);
    this.entities.set(entity.id, entity);
    if (entity.kind === 'usv' && !this._ownShipId) this._ownShipId = entity.id;
    this.bus.emit('entityAdded', { id: entity.id });
    return entity;
  }

  removeEntity(id: EntityId): boolean {
    const removed = this.entities.delete(id);
    if (removed) {
      if (this._ownShipId === id) this._ownShipId = undefined;
      this.bus.emit('entityRemoved', { id });
    }
    return removed;
  }

  /** Designate which vessel the external control interface drives. */
  setOwnShip(id: EntityId): void {
    if (this.entities.has(id)) this._ownShipId = id;
  }

  /**
   * Drop a ghost target onto the chart.
   *
   * Deliberately a one-call operation with everything optional: creating
   * traffic has to be as fast as pointing at the display, or nobody will build
   * the awkward situation they actually wanted to test and will settle for
   * whatever the feed happens to provide.
   */
  spawnGhost(opts: {
    readonly position: LatLon;
    readonly vesselClass?: VesselClassId;
    readonly heading?: Radians;
    readonly speed?: MetresPerSecond;
    readonly controller?: Controller;
    readonly name?: string;
    readonly mmsi?: number;
    readonly id?: EntityId;
  }): SimulatedEntity {
    const vesselClass = opts.vesselClass ?? 'general-cargo';
    const heading = opts.heading ?? 0;
    const speed = opts.speed ?? knots(8);
    return this.addEntity({
      id: opts.id ?? this.ids.next('ghost'),
      kind: 'ghost',
      dynamics: createVessel(vesselClass),
      controller: opts.controller ?? new IdleController(),
      identity: {
        name: opts.name ?? `GHOST ${vesselClass}`,
        mmsi: opts.mmsi,
      },
      initialPosition: opts.position,
      initialHeading: heading,
      initialSpeed: speed,
    });
  }

  /**
   * Promote an AIS contact into a controllable ghost.
   *
   * Takes the vessel's reported identity, dimensions and kinematics as the
   * starting condition, then hands it to the dynamics model. The use case is
   * specific and common: a real vessel on the live feed is about to do
   * something interesting, and you want to take it over and make it do
   * something worse.
   */
  promoteContactToGhost(mmsi: number, controller?: Controller): SimulatedEntity | undefined {
    const contact = this.tracks.get(mmsi);
    if (!contact) return undefined;

    const vesselClass = vesselClassForAisType(contact.shipType);
    const dynamics = createVessel(vesselClass, {
      particulars: {
        ...(contact.loa ? { loa: contact.loa } : {}),
        ...(contact.beam ? { beam: contact.beam } : {}),
        ...(contact.draught ? { draught: contact.draught } : {}),
      },
    });

    return this.addEntity({
      id: this.ids.next('ghost'),
      kind: 'ghost',
      dynamics,
      controller: controller ?? new IdleController(),
      identity: {
        mmsi: contact.mmsi,
        name: contact.name,
        callSign: contact.callSign,
        imoNumber: contact.imoNumber,
        shipType: contact.shipType,
        destination: contact.destination,
      },
      initialPosition: contact.position,
      initialHeading: contact.trueHeading ?? contact.cog ?? 0,
      initialSpeed: contact.sog ?? 0,
    });
  }

  /** Attach an AIS source. Its messages flow into the track manager. */
  attachAisSource(source: AisSource): void {
    if (this.sources.has(source.id)) return;
    this.sources.set(source.id, source);
    const off = source.on('message', (message: AisMessage) => this.tracks.ingest(message));
    this.sourceCleanup.set(source.id, off);
  }

  detachAisSource(sourceId: string): void {
    this.sourceCleanup.get(sourceId)?.();
    this.sourceCleanup.delete(sourceId);
    this.sources.delete(sourceId);
  }

  listAisSources(): AisSource[] {
    return [...this.sources.values()];
  }

  /**
   * Advance exactly one fixed step.
   *
   * The only way sim time moves. Renderers call `stepsForElapsed` to decide how
   * many times to call this; batch runs call it in a tight loop. Both produce
   * identical results for identical inputs, which is the entire point of
   * separating the clock from the frame rate.
   */
  step(): void {
    const dt = this.clock.stepSeconds;
    const simTime = this.clock.time;

    for (const entity of this.entities.values()) {
      entity.step(this._plane, this._environment, dt, simTime);
    }

    this.clock.advance();
    this.maybeRebase();
    this.bus.emit('stepped', { simTime: this.clock.time, tick: this.clock.tick });
  }

  /** Run a number of steps. Returns the sim time reached. */
  run(steps: number): SimTime {
    for (let i = 0; i < steps; i++) this.step();
    return this.clock.time;
  }

  /** Run for a duration of sim time. */
  runFor(seconds: Seconds): SimTime {
    return this.run(Math.round(seconds / this.clock.stepSeconds));
  }

  /**
   * Re-anchor the tangent plane when own ship strays too far from its origin.
   *
   * Every entity's local coordinates are rewritten in the new frame in the same
   * pass, so nothing observes a discontinuity. Without this, a long transit
   * accumulates flat-earth error until positions visibly disagree with the
   * chart.
   */
  private maybeRebase(): void {
    const own = this.ownShip ?? this.entities.values().next().value;
    if (!own) return;
    const local = { e: own.dynamics.state.east, n: own.dynamics.state.north };
    if (!this._plane.shouldRebase(local, this.rebaseRadius)) return;

    const geodetic: LatLon[] = [];
    const list = [...this.entities.values()];
    for (const entity of list) geodetic.push(entity.position(this._plane));

    const newOrigin = this._plane.toGeodetic(local);
    this._plane = new TangentPlane(newOrigin);

    list.forEach((entity, i) => {
      const p = this._plane.toLocal(geodetic[i]!);
      entity.dynamics.state = { ...entity.dynamics.state, north: p.n, east: p.e };
    });

    this.bus.emit('rebased', { origin: newOrigin });
  }

  /** Prune AIS contacts that have gone quiet. Call periodically, not every step. */
  pruneTracks(): number {
    return this.tracks.pruneStale(this.clock.wallClock);
  }

  /** Everything observable, as plain data. */
  snapshot(): WorldSnapshot {
    const objects: WorldObject[] = [];

    for (const entity of this.entities.values()) {
      objects.push(entity.toWorldObject(this._plane, this._environment));
    }

    const now = this.clock.wallClock;
    const simulatedMmsis = new Set(
      [...this.entities.values()].map((e) => e.identity.mmsi).filter((m): m is number => !!m),
    );

    for (const contact of this.tracks.all()) {
      // A contact that has been taken over as a ghost must not also appear as
      // a track, or it shows twice on the display and twice to the algorithm.
      if (simulatedMmsis.has(contact.mmsi)) continue;
      const object = contactToWorldObject(contact, this.tracks.extrapolate(contact, now), now);
      if (object) objects.push(object);
    }

    const env = this._environment;
    return {
      simTime: this.clock.time,
      wallClock: now,
      tick: this.clock.tick,
      timeScale: this.clock.timeScale,
      ownShipId: this._ownShipId,
      objects,
      environment: {
        windFromRadians: env.wind.fromRadians,
        windSpeed: env.wind.speed,
        currentSetRadians: env.current.setRadians,
        currentDriftSpeed: env.current.driftSpeed,
        significantWaveHeight: env.sea.significantWaveHeight,
      },
    };
  }
}

function contactToWorldObject(
  contact: AisContact,
  extrapolated: LatLon | undefined,
  now: UnixMillis,
): WorldObject | undefined {
  // Undefined means the contact has been silent past the extrapolation limit;
  // it is dropped from the picture rather than shown at a stale position.
  if (!extrapolated) return undefined;
  const moved = extrapolated !== contact.position;
  return {
    id: mmsiToEntityId(contact.mmsi),
    kind: contact.stationClass === 'aton' ? 'aton' : 'ais-contact',
    source: 'ais',
    position: extrapolated,
    heading: contact.trueHeading,
    cog: contact.cog,
    sog: contact.sog,
    rateOfTurn: contact.rateOfTurn,
    navigationStatus: contact.navigationStatus,
    identity: {
      mmsi: contact.mmsi,
      name: contact.name,
      callSign: contact.callSign,
      imoNumber: contact.imoNumber,
      shipType: contact.shipType,
      destination: contact.destination,
    },
    dimensions: { loa: contact.loa, beam: contact.beam, draught: contact.draught },
    extrapolated: moved && now > contact.positionUpdatedAt,
    lastReportAt: contact.positionUpdatedAt,
  };
}

export { entityId };

import {
  degrees,
  knots,
  toDegrees,
  toKnots,
  type EntityId,
  type MetresPerSecond,
} from '@umami/core';
import {
  ActuatorController,
  AutopilotController,
  IdleController,
  StationKeepController,
  WaypointController,
  courseTrimRateFor,
  type Controller,
  type World,
  type WorldObject,
  type WorldSnapshot,
} from '@umami/sim';
import type { HeadingAutopilotGains } from '@umami/sim';
import {
  PROTOCOL_VERSION,
  type AckMessage,
  type ClientMessage,
  type ControlCommand,
  type ErrorMessage,
  type ServerMessage,
  type StateMessage,
  type StateObject,
} from './protocol.js';

/** Anything that can carry protocol messages to one client. */
export interface BridgeTransport {
  send(message: ServerMessage): void;
  close?(): void;
}

export interface ControlBridgeOptions {
  readonly world: World;
  /**
   * Gains and speed limit for controllers the bridge creates.
   *
   * Supplied by the host rather than derived here, because tuning requires
   * running the vessel's dynamics and the host already does that once per
   * vessel class and caches it.
   */
  readonly controllerFactory: (
    objectId: EntityId,
  ) => { gains: HeadingAutopilotGains; maxSpeed: MetresPerSecond; yawTimeConstant: number };
  /** Identify the vessel a connecting client may command. */
  readonly ownShipId?: EntityId;
  /** Let clients create and drive ghost traffic. Off for a read-only client. */
  readonly allowGhostControl?: boolean;
  readonly now?: () => number;
}

/**
 * Serves the external control interface for one connected client.
 *
 * Deliberately a plain object driven by `handle` and `publish` rather than
 * something that owns a socket. The simulator can then expose the same
 * interface over a WebSocket, over stdio for a subprocess, or in-process with
 * no transport at all for a control algorithm written in TypeScript - and the
 * algorithm cannot tell the difference, which is what makes a test written
 * against one of them valid for the others.
 */
export class ControlBridge {
  private readonly world: World;
  private readonly opts: ControlBridgeOptions;
  private subscription = { rateHz: 4, rangeLimitNm: 0, include: ['simulated', 'ais'] as const };
  private lastPublish = 0;
  private greeted = false;

  constructor(
    private readonly transport: BridgeTransport,
    opts: ControlBridgeOptions,
  ) {
    this.world = opts.world;
    this.opts = opts;
  }

  private get now(): () => number {
    return this.opts.now ?? Date.now;
  }

  /** Handle one inbound message. Never throws; protocol errors are replies. */
  handle(raw: unknown): void {
    let message: ClientMessage;
    try {
      message = (typeof raw === 'string' ? JSON.parse(raw) : raw) as ClientMessage;
    } catch {
      this.error(undefined, 'bad-message', 'message was not valid JSON');
      return;
    }
    if (!message || typeof message.type !== 'string') {
      this.error(undefined, 'bad-message', 'message had no type');
      return;
    }

    try {
      this.dispatch(message);
    } catch (err) {
      this.error(
        (message as { id?: number }).id,
        'bad-message',
        err instanceof Error ? err.message : 'command failed',
      );
    }
  }

  private dispatch(message: ClientMessage): void {
    switch (message.type) {
      case 'hello': {
        // A mismatched major version is refused rather than tolerated: a
        // control algorithm silently talking to a simulator that means
        // something different by the same field is worse than no connection.
        const major = (v: string): string => v.split('.')[0] ?? '';
        if (major(message.protocolVersion) !== major(PROTOCOL_VERSION)) {
          this.error(
            undefined,
            'protocol-mismatch',
            `server speaks ${PROTOCOL_VERSION}, client offered ${message.protocolVersion}`,
          );
          return;
        }
        this.greeted = true;
        this.transport.send({
          type: 'welcome',
          protocolVersion: PROTOCOL_VERSION,
          sessionId: `sim-${this.now()}`,
          ownShipId: this.opts.ownShipId ?? this.world.ownShipId,
          capabilities: [
            'course-speed',
            'heading-speed',
            'waypoint',
            'station-keep',
            'actuator',
            ...(this.opts.allowGhostControl ? ['ghost-control'] : []),
          ],
        });
        return;
      }

      case 'subscribe':
        this.subscription = {
          rateHz: clampRate(message.rateHz ?? 4),
          rangeLimitNm: message.rangeLimitNm ?? 0,
          include: (message.include ?? ['simulated', 'ais']) as never,
        };
        this.ack(message.id);
        this.publish(true);
        return;

      case 'setControl': {
        const id = this.resolveTarget(message.objectId);
        if (!id) return this.error(message.id, 'unknown-object', 'no such object');
        this.applyControl(id, message.command);
        this.ack(message.id, id);
        return;
      }

      case 'setRoute': {
        const id = this.resolveTarget(message.objectId);
        if (!id) return this.error(message.id, 'unknown-object', 'no such object');
        const entity = this.world.getEntity(id);
        if (!entity) return this.error(message.id, 'unknown-object', 'no such object');
        const { gains, maxSpeed, yawTimeConstant } = this.opts.controllerFactory(id);
        const controller = new WaypointController({
          gains,
          maxSpeed,
          courseTrimRate: courseTrimRateFor({ gain: 1, timeConstant: yawTimeConstant }, gains.kp),
          route: {
            waypoints: message.waypoints.map((w) => ({
              position: { lat: w.lat, lon: w.lon },
              speed: w.speedKnots === undefined ? undefined : knots(w.speedKnots),
              arrivalRadius: w.arrivalRadiusMetres,
              name: w.name,
            })),
            loop: message.loop,
          },
          defaultSpeed: maxSpeed * 0.6,
          lookAheadDistance: Math.max(60, entity.dynamics.particulars.loa * 8),
        });
        if (message.activeLeg !== undefined) controller.setActiveLeg(message.activeLeg);
        entity.setController(controller);
        this.ack(message.id, id);
        return;
      }

      case 'spawnGhost': {
        if (!this.opts.allowGhostControl) {
          return this.error(message.id, 'not-permitted', 'ghost control is disabled');
        }
        const ghost =
          message.fromAisMmsi !== undefined
            ? this.world.promoteContactToGhost(message.fromAisMmsi)
            : this.world.spawnGhost({
                position: { lat: message.lat, lon: message.lon },
                vesselClass: message.vesselClass as never,
                heading: degrees(message.headingDegrees ?? 0),
                speed: knots(message.speedKnots ?? 0),
                name: message.name,
                mmsi: message.mmsi,
              });
        if (!ghost) {
          return this.error(message.id, 'unknown-object', 'no AIS contact with that MMSI');
        }
        this.ack(message.id, ghost.id);
        return;
      }

      case 'controlGhost': {
        if (!this.opts.allowGhostControl) {
          return this.error(message.id, 'not-permitted', 'ghost control is disabled');
        }
        const id = message.objectId as EntityId;
        if (!this.world.getEntity(id)) {
          return this.error(message.id, 'unknown-object', 'no such object');
        }
        this.applyControl(id, message.command);
        this.ack(message.id, id);
        return;
      }

      case 'removeObject': {
        if (!this.opts.allowGhostControl) {
          return this.error(message.id, 'not-permitted', 'ghost control is disabled');
        }
        this.world.removeEntity(message.objectId as EntityId);
        this.ack(message.id);
        return;
      }

      case 'setEnvironment': {
        const env = this.world.environment;
        this.world.setEnvironment({
          ...env,
          wind: {
            fromRadians:
              message.windFromDegrees === undefined
                ? env.wind.fromRadians
                : degrees(message.windFromDegrees),
            speed:
              message.windSpeedKnots === undefined ? env.wind.speed : knots(message.windSpeedKnots),
          },
          current: {
            setRadians:
              message.currentSetDegrees === undefined
                ? env.current.setRadians
                : degrees(message.currentSetDegrees),
            driftSpeed:
              message.currentDriftKnots === undefined
                ? env.current.driftSpeed
                : knots(message.currentDriftKnots),
          },
          sea: {
            ...env.sea,
            significantWaveHeight:
              message.significantWaveHeightMetres ?? env.sea.significantWaveHeight,
          },
        });
        this.ack(message.id);
        return;
      }

      case 'setTimeScale':
        this.world.clock.timeScale = message.timeScale;
        this.ack(message.id);
        return;

      case 'ping':
        this.transport.send({
          type: 'pong',
          id: message.id,
          sentAt: message.sentAt,
          serverTime: this.now(),
        });
        return;

      default:
        this.error(
          (message as { id?: number }).id,
          'bad-message',
          `unknown message type: ${(message as { type?: string }).type}`,
        );
    }
  }

  private resolveTarget(objectId: string | undefined): EntityId | undefined {
    const id = (objectId ?? this.opts.ownShipId ?? this.world.ownShipId) as EntityId | undefined;
    if (!id) return undefined;
    if (!this.opts.allowGhostControl && objectId && objectId !== (this.opts.ownShipId ?? this.world.ownShipId)) {
      return undefined;
    }
    return this.world.getEntity(id) ? id : undefined;
  }

  private applyControl(id: EntityId, command: ControlCommand): void {
    const entity = this.world.getEntity(id);
    if (!entity) return;
    const { gains, maxSpeed, yawTimeConstant } = this.opts.controllerFactory(id);
    const courseTrimRate = courseTrimRateFor({ gain: 1, timeConstant: yawTimeConstant }, gains.kp);
    entity.setController(buildController(command, { gains, maxSpeed, courseTrimRate }));
  }

  /** Emit a state message if the subscription's interval has elapsed. */
  publish(force = false): void {
    if (!this.greeted && !force) return;
    const now = this.now();
    const interval = 1000 / this.subscription.rateHz;
    if (!force && now - this.lastPublish < interval) return;
    this.lastPublish = now;
    this.transport.send(this.buildState(this.world.snapshot()));
  }

  private buildState(snapshot: WorldSnapshot): StateMessage {
    const include = new Set(this.subscription.include);
    const objects = snapshot.objects
      .filter((o) => include.has(o.source))
      .map(toStateObject);
    return {
      type: 'state',
      simTime: snapshot.simTime,
      wallClock: snapshot.wallClock,
      timeScale: snapshot.timeScale,
      ownShipId: snapshot.ownShipId,
      objects,
      environment: {
        windFromDegrees: toDegrees(snapshot.environment.windFromRadians),
        windSpeedKnots: toKnots(snapshot.environment.windSpeed),
        currentSetDegrees: toDegrees(snapshot.environment.currentSetRadians),
        currentDriftKnots: toKnots(snapshot.environment.currentDriftSpeed),
        significantWaveHeightMetres: snapshot.environment.significantWaveHeight,
      },
    };
  }

  private ack(id: number | undefined, objectId?: string): void {
    const message: AckMessage = { type: 'ack', id, objectId };
    this.transport.send(message);
  }

  private error(id: number | undefined, code: ErrorMessage['code'], text: string): void {
    this.transport.send({ type: 'error', id, code, message: text });
  }
}

function buildController(
  command: ControlCommand,
  opts: {
    gains: HeadingAutopilotGains;
    maxSpeed: MetresPerSecond;
    courseTrimRate: number;
  },
): Controller {
  switch (command.mode) {
    case 'course-speed': {
      const c = new AutopilotController({ ...opts, followCourse: true });
      c.setCourseDemand(degrees(command.courseDegrees), knots(command.speedKnots));
      return c;
    }
    case 'heading-speed': {
      const c = new AutopilotController(opts);
      c.setHeadingDemand(degrees(command.headingDegrees), knots(command.speedKnots));
      return c;
    }
    case 'station-keep':
      return new StationKeepController({
        ...opts,
        target: { lat: command.lat, lon: command.lon },
        tolerance: command.toleranceMetres,
      });
    case 'actuator': {
      const c = new ActuatorController();
      c.set({ throttle: command.throttle, steer: command.steer });
      return c;
    }
    case 'idle':
    default:
      return new IdleController();
  }
}

function toStateObject(o: WorldObject): StateObject {
  return {
    id: o.id,
    kind: o.kind,
    source: o.source,
    lat: o.position.lat,
    lon: o.position.lon,
    headingDegrees: o.heading === undefined ? undefined : toDegrees(o.heading),
    courseDegrees: o.cog === undefined ? undefined : toDegrees(o.cog),
    speedKnots: o.sog === undefined ? undefined : toKnots(o.sog),
    rateOfTurnDegPerMin: o.rateOfTurn === undefined ? undefined : toDegrees(o.rateOfTurn) * 60,
    name: o.identity.name,
    mmsi: o.identity.mmsi,
    shipType: o.identity.shipType,
    loa: o.dimensions.loa,
    beam: o.dimensions.beam,
    actuators: o.actuators,
    extrapolated: o.extrapolated,
  };
}

function clampRate(hz: number): number {
  // Faster than 20 Hz saturates a WebSocket with no benefit: the simulation
  // steps at 10 Hz by default and nothing changes between steps.
  return Math.max(0.2, Math.min(20, hz));
}

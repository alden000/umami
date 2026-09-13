import type { Degrees, MetresPerSecond, SimTime, UnixMillis } from '@umami/core';

/**
 * Wire protocol for the external control interface.
 *
 * The contract between the simulation and whatever is being tested against it.
 * Three properties are deliberate:
 *
 *  - It is transport-agnostic JSON. WebSocket is the default because it works
 *    unchanged from a browser, a Python script and a C++ process, but nothing
 *    here depends on it; the same messages run over a Unix socket, TCP, or an
 *    in-process channel for a control algorithm written in TypeScript.
 *  - It speaks marine units - degrees and knots - not SI. This is the boundary
 *    where a human writes and reads values, and where an existing autopilot or
 *    ground station is most likely to be adapted in. Conversion happens once,
 *    on entry.
 *  - Commands are explicit about which control mode they select, so a client
 *    cannot leave the vessel in an ambiguous state by sending a course while
 *    the vessel believes it is following a route.
 *
 * Versioned from the start: an external control algorithm may be developed
 * against one revision of the simulator and run against a later one.
 */
export const PROTOCOL_VERSION = '1.0';

export type ClientMessage =
  | HelloMessage
  | SubscribeMessage
  | SetControlMessage
  | SetRouteMessage
  | SpawnGhostMessage
  | ControlGhostMessage
  | RemoveObjectMessage
  | SetEnvironmentMessage
  | SetTimeScaleMessage
  | PingMessage;

export type ServerMessage =
  | WelcomeMessage
  | StateMessage
  | AckMessage
  | ErrorMessage
  | PongMessage;

export interface HelloMessage {
  readonly type: 'hello';
  readonly protocolVersion: string;
  /** Free-form identification, shown in the simulator UI. */
  readonly clientName?: string;
}

export interface WelcomeMessage {
  readonly type: 'welcome';
  readonly protocolVersion: string;
  readonly sessionId: string;
  /** Entity the client is permitted to command. */
  readonly ownShipId?: string;
  readonly capabilities: readonly string[];
}

export interface SubscribeMessage {
  readonly type: 'subscribe';
  readonly id?: number;
  /** State updates per second. The simulation's own step rate is unaffected. */
  readonly rateHz?: number;
  /** Omit distant objects, in nautical miles from own ship. */
  readonly rangeLimitNm?: number;
  /** Include vessels the simulation is integrating, AIS contacts, or both. */
  readonly include?: readonly ('simulated' | 'ais')[];
}

/**
 * Select a control mode and its setpoint.
 *
 * Both of the modes requested are here, plus direct actuator access, and they
 * are mutually exclusive by construction rather than by convention.
 */
export type ControlCommand =
  | { readonly mode: 'idle' }
  | {
      readonly mode: 'course-speed';
      /** Course over ground to make good, compass degrees. */
      readonly courseDegrees: Degrees;
      readonly speedKnots: number;
    }
  | {
      readonly mode: 'heading-speed';
      readonly headingDegrees: Degrees;
      readonly speedKnots: number;
    }
  | {
      readonly mode: 'station-keep';
      readonly lat: number;
      readonly lon: number;
      readonly toleranceMetres?: number;
    }
  | {
      readonly mode: 'actuator';
      /** Thrust demand, -1 to 1. Ahead positive. */
      readonly throttle: number;
      /** Steering demand, -1 to 1. Starboard positive, whatever the drive. */
      readonly steer: number;
    };

export interface SetControlMessage {
  readonly type: 'setControl';
  readonly id?: number;
  /** Defaults to the client's own ship. */
  readonly objectId?: string;
  readonly command: ControlCommand;
}

export interface RouteWaypoint {
  readonly lat: number;
  readonly lon: number;
  readonly speedKnots?: number;
  readonly arrivalRadiusMetres?: number;
  readonly name?: string;
}

export interface SetRouteMessage {
  readonly type: 'setRoute';
  readonly id?: number;
  readonly objectId?: string;
  readonly waypoints: readonly RouteWaypoint[];
  readonly loop?: boolean;
  /** Resume from a specific leg rather than the first. */
  readonly activeLeg?: number;
}

export interface SpawnGhostMessage {
  readonly type: 'spawnGhost';
  readonly id?: number;
  readonly lat: number;
  readonly lon: number;
  readonly vesselClass?: string;
  readonly headingDegrees?: Degrees;
  readonly speedKnots?: number;
  readonly name?: string;
  readonly mmsi?: number;
  /** Take over a vessel already on AIS rather than inventing a new one. */
  readonly fromAisMmsi?: number;
}

export interface ControlGhostMessage {
  readonly type: 'controlGhost';
  readonly id?: number;
  readonly objectId: string;
  readonly command: ControlCommand;
}

export interface RemoveObjectMessage {
  readonly type: 'removeObject';
  readonly id?: number;
  readonly objectId: string;
}

export interface SetEnvironmentMessage {
  readonly type: 'setEnvironment';
  readonly id?: number;
  readonly windFromDegrees?: Degrees;
  readonly windSpeedKnots?: number;
  readonly currentSetDegrees?: Degrees;
  readonly currentDriftKnots?: number;
  readonly significantWaveHeightMetres?: number;
}

export interface SetTimeScaleMessage {
  readonly type: 'setTimeScale';
  readonly id?: number;
  /** Sim seconds per wall-clock second. 0 pauses. */
  readonly timeScale: number;
}

export interface PingMessage {
  readonly type: 'ping';
  readonly id?: number;
  readonly sentAt?: UnixMillis;
}

export interface PongMessage {
  readonly type: 'pong';
  readonly id?: number;
  readonly sentAt?: UnixMillis;
  readonly serverTime: UnixMillis;
}

/** One object as seen by an external client. Marine units throughout. */
export interface StateObject {
  readonly id: string;
  readonly kind: string;
  readonly source: 'simulated' | 'ais';
  readonly lat: number;
  readonly lon: number;
  readonly headingDegrees?: Degrees;
  readonly courseDegrees?: Degrees;
  readonly speedKnots?: number;
  readonly rateOfTurnDegPerMin?: number;
  readonly name?: string;
  readonly mmsi?: number;
  readonly shipType?: number;
  readonly loa?: number;
  readonly beam?: number;
  /** Drive positions. Names depend on the drive fitted. */
  readonly actuators?: Readonly<Record<string, number>>;
  /** True when an AIS position is dead-reckoned rather than freshly reported. */
  readonly extrapolated?: boolean;
}

export interface StateMessage {
  readonly type: 'state';
  readonly simTime: SimTime;
  readonly wallClock: UnixMillis;
  readonly timeScale: number;
  readonly ownShipId?: string;
  readonly objects: readonly StateObject[];
  readonly environment: {
    readonly windFromDegrees: Degrees;
    readonly windSpeedKnots: number;
    readonly currentSetDegrees: Degrees;
    readonly currentDriftKnots: number;
    readonly significantWaveHeightMetres: number;
  };
}

export interface AckMessage {
  readonly type: 'ack';
  readonly id?: number;
  /** Identifier of anything the command created. */
  readonly objectId?: string;
}

export interface ErrorMessage {
  readonly type: 'error';
  readonly id?: number;
  readonly code:
    | 'bad-message'
    | 'unknown-object'
    | 'not-permitted'
    | 'unsupported-mode'
    | 'protocol-mismatch';
  readonly message: string;
}

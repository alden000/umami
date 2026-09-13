import { degrees, knots } from '@umami/core';
import {
  BackoffPolicy,
  BaseAisSource,
  isInsideBoundingBox,
  type AisSubscription,
} from '../source.js';
import {
  NavigationStatus,
  type AisDimensions,
  type AisMessage,
  type AisPositionMessage,
  type AisStaticMessage,
} from '../types.js';

/**
 * aisstream.io live feed.
 *
 * The feed delivers already-decoded JSON rather than raw AIVDM, so this
 * adapter is a field-mapping exercise, not a decoder. Everything
 * provider-specific - their capitalisation, their units, their message type
 * names - stops at this file.
 *
 * Provider constraints this implements, from their documentation:
 *  - a complete subscription must be sent within 3 s of the socket opening,
 *    or the server closes it;
 *  - at most one subscription update per second per connection;
 *  - 3 connections per account and per IP;
 *  - reconnect with exponential backoff and jitter.
 *
 * The API key is a server-side credential. Do not construct this source in a
 * browser: the key would ship to every user in the bundle and be readable in
 * devtools. Run it in the headless runner, the desktop app or a small relay,
 * and have browser clients consume the relay. See
 * `docs/adr/0004-ais-ingest-and-sources.md`.
 */
export interface AisStreamOptions {
  readonly id?: string;
  readonly apiKey: string;
  readonly url?: string;
  /** Injected so this is testable without a network, and usable in Node and the browser. */
  readonly webSocketFactory?: (url: string) => AisStreamSocket;
  readonly backoff?: BackoffPolicy;
  /** Clock injection keeps replay and tests deterministic. */
  readonly now?: () => number;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

/** The slice of the WebSocket API this adapter needs. */
export interface AisStreamSocket {
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

const DEFAULT_URL = 'wss://stream.aisstream.io/v0/stream';

/** Message type names the feed uses, verbatim. */
const POSITION_TYPES = new Set([
  'PositionReport',
  'StandardClassBPositionReport',
  'ExtendedClassBPositionReport',
  'LongRangeAisBroadcastMessage',
]);

export class AisStreamSource extends BaseAisSource {
  readonly kind = 'aisstream.io';

  private socket?: AisStreamSocket;
  private subscription?: AisSubscription;
  private readonly opts: AisStreamOptions;
  private readonly backoff: BackoffPolicy;
  private reconnectHandle?: unknown;
  private stopped = false;

  constructor(opts: AisStreamOptions) {
    super(opts.id ?? 'aisstream');
    this.opts = opts;
    this.backoff = opts.backoff ?? new BackoffPolicy(1000, 60_000);
  }

  private get now(): () => number {
    return this.opts.now ?? Date.now;
  }

  async start(subscription: AisSubscription = {}): Promise<void> {
    this.stopped = false;
    this.subscription = subscription;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectHandle !== undefined) {
      (this.opts.clearTimeout ?? clearTimeout)(this.reconnectHandle as never);
      this.reconnectHandle = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
    this.setState('stopped');
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState(this.backoff.attempts === 0 ? 'connecting' : 'reconnecting');

    const factory =
      this.opts.webSocketFactory ??
      ((url: string) => new WebSocket(url) as unknown as AisStreamSocket);

    let socket: AisStreamSocket;
    try {
      socket = factory(this.opts.url ?? DEFAULT_URL);
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : 'socket construction failed');
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      // Must arrive within 3 s or the server hangs up, so it is sent
      // immediately on open rather than after any other setup.
      socket.send(JSON.stringify(this.buildSubscriptionMessage()));
      this.backoff.reset();
      this.setState('live');
    };

    socket.onmessage = (event) => {
      this.handleRaw(event.data);
    };

    socket.onerror = (event) => {
      this.setState('reconnecting', `socket error: ${describe(event)}`);
    };

    socket.onclose = () => {
      if (this.stopped) return;
      this.scheduleReconnect('connection closed');
    };
  }

  private scheduleReconnect(detail: string): void {
    if (this.stopped) return;
    const delay = this.backoff.nextDelayMs();
    this.setState('reconnecting', `${detail}; retrying in ${Math.round(delay / 1000)}s`);
    this.reconnectHandle = (this.opts.setTimeout ?? setTimeout)(() => this.connect(), delay);
  }

  private buildSubscriptionMessage(): Record<string, unknown> {
    const sub = this.subscription ?? {};
    // The provider expects corner pairs as [[lat, lon], [lat, lon]] and
    // requires at least one box; default to the whole world.
    const boxes = (sub.boundingBoxes ?? []).map((b) => [
      [b.south, b.west],
      [b.north, b.east],
    ]);
    const message: Record<string, unknown> = {
      APIKey: this.opts.apiKey,
      BoundingBoxes: boxes.length > 0 ? boxes : [[[-90, -180], [90, 180]]],
    };
    if (sub.mmsiFilter?.length) {
      // Their filter takes MMSIs as strings and caps the list at 200.
      message.FiltersShipMMSI = sub.mmsiFilter.slice(0, 200).map(String);
    }
    return message;
  }

  private handleRaw(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = typeof data === 'string' ? JSON.parse(data) : data;
    } catch {
      this.fail('malformed JSON frame', data);
      return;
    }
    const message = this.adapt(parsed);
    if (message) this.publish(message);
  }

  /** Map one provider frame onto the normalised model. */
  private adapt(frame: unknown): AisMessage | undefined {
    if (!isRecord(frame)) return undefined;
    const messageType = asString(frame.MessageType);
    if (!messageType || messageType === 'SubscriptionConfirmation') return undefined;

    const metadata = isRecord(frame.MetaData) ? frame.MetaData : {};
    const payloads = isRecord(frame.Message) ? frame.Message : {};
    const payload = isRecord(payloads[messageType]) ? (payloads[messageType] as Record<string, unknown>) : {};

    const mmsi = asNumber(metadata.MMSI) ?? asNumber(payload.UserID);
    if (mmsi === undefined) {
      this.fail('frame carried no MMSI', frame);
      return undefined;
    }

    const receivedAt = parseTimestamp(metadata.time_utc) ?? this.now();
    const base = { mmsi, sourceId: this.id, receivedAt };

    if (POSITION_TYPES.has(messageType)) {
      return this.adaptPosition(messageType, payload, metadata, base);
    }
    if (messageType === 'ShipStaticData' || messageType === 'StaticDataReport') {
      return adaptStatic(messageType, payload, metadata, base);
    }
    // Every other type is decoded by the provider but not modelled here.
    return undefined;
  }

  private adaptPosition(
    messageType: string,
    payload: Record<string, unknown>,
    metadata: Record<string, unknown>,
    base: { mmsi: number; sourceId: string; receivedAt: number },
  ): AisPositionMessage | undefined {
    const lat = asNumber(payload.Latitude) ?? asNumber(metadata.latitude) ?? asNumber(metadata.Latitude);
    const lon = asNumber(payload.Longitude) ?? asNumber(metadata.longitude) ?? asNumber(metadata.Longitude);
    if (lat === undefined || lon === undefined) return undefined;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      this.fail('position out of range', payload);
      return undefined;
    }

    // Provider-side filtering is authoritative, but a locally configured box
    // may be narrower than what was subscribed, so apply it again here.
    const boxes = this.subscription?.boundingBoxes;
    if (boxes?.length && !boxes.some((b) => isInsideBoundingBox(lat, lon, b))) return undefined;

    const sog = asNumber(payload.Sog);
    const cog = asNumber(payload.Cog);
    const heading = asNumber(payload.TrueHeading);
    const rot = asNumber(payload.RateOfTurn);
    const status = asNumber(payload.NavigationalStatus);

    return {
      ...base,
      kind: 'position',
      stationClass: messageType === 'PositionReport' ? 'A' : 'B',
      position: { lat, lon },
      // The feed reports speed in knots and angles in degrees; convert once,
      // here, so nothing downstream has to remember which units a source used.
      sog: sog === undefined || sog >= 102.3 ? undefined : knots(sog),
      cog: cog === undefined || cog >= 360 ? undefined : degrees(cog),
      trueHeading: heading === undefined || heading >= 511 ? undefined : degrees(heading),
      rateOfTurn: rot === undefined || rot === -128 ? undefined : degrees(rot / 60),
      navigationStatus: status === undefined ? undefined : (status as NavigationStatus),
      positionAccuracyHigh: asBoolean(payload.PositionAccuracy),
    };
  }
}

/**
 * Static data mapping.
 *
 * The provider's field names for this message are modelled on the ITU-R M.1371
 * message 5 structure. Each field is read defensively with a fallback, so an
 * unexpected name degrades that one field rather than dropping the vessel's
 * identity altogether. Verify against a live feed before relying on draught or
 * ETA; position reports, which matter far more, are confirmed.
 */
function adaptStatic(
  _messageType: string,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>,
  base: { mmsi: number; sourceId: string; receivedAt: number },
): AisStaticMessage {
  const dim = isRecord(payload.Dimension) ? payload.Dimension : undefined;
  const eta = isRecord(payload.Eta) ? payload.Eta : undefined;
  const dimensions: AisDimensions | undefined = dim
    ? {
        toBow: asNumber(dim.A) ?? 0,
        toStern: asNumber(dim.B) ?? 0,
        toPort: asNumber(dim.C) ?? 0,
        toStarboard: asNumber(dim.D) ?? 0,
      }
    : undefined;

  const draught = asNumber(payload.MaximumStaticDraught);
  return {
    ...base,
    kind: 'static',
    stationClass: 'A',
    name: asString(payload.Name)?.trim() || asString(metadata.ShipName)?.trim() || undefined,
    callSign: asString(payload.CallSign)?.trim() || undefined,
    imoNumber: asNumber(payload.ImoNumber) || undefined,
    shipType: asNumber(payload.Type) ?? asNumber(payload.ShipType) ?? undefined,
    dimensions:
      dimensions && dimensions.toBow + dimensions.toStern > 0 ? dimensions : undefined,
    draught: draught && draught > 0 ? draught : undefined,
    destination: asString(payload.Destination)?.trim() || undefined,
    eta: eta
      ? {
          month: asNumber(eta.Month) || undefined,
          day: asNumber(eta.Day) || undefined,
          hour: asNumber(eta.Hour),
          minute: asNumber(eta.Minute),
        }
      : undefined,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function asBoolean(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}
function parseTimestamp(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v.replace(' +0000 UTC', 'Z').replace(' ', 'T'));
  return Number.isFinite(t) ? t : undefined;
}
function describe(event: unknown): string {
  if (isRecord(event) && typeof event.message === 'string') return event.message;
  return 'unknown';
}

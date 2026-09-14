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

/** The provider accepts at most one subscription per second per connection. */
const SUBSCRIPTION_MIN_INTERVAL_MS = 1000;

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
  /**
   * Whether the socket has opened and not yet closed.
   *
   * Tracked rather than read off the socket because `send` on a WebSocket that
   * is still CONNECTING throws `InvalidStateError`, and the socket is assigned
   * the moment it is constructed - so every reconnect leaves a window in which
   * a caller following the map view would throw. See `sendSubscription`.
   */
  private socketOpen = false;
  private subscription?: AisSubscription;
  private readonly opts: AisStreamOptions;
  private readonly backoff: BackoffPolicy;
  private reconnectHandle?: unknown;
  private stopped = false;
  /** When the last subscription went out, for the provider's rate limit. */
  private lastSubscriptionAt = 0;
  private pendingSubscriptionHandle?: unknown;

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

  /**
   * Replace the active subscription, typically to follow the operator's view.
   *
   * The provider closes a connection that receives more than one subscription
   * per second, so the limit is enforced here rather than left to the caller:
   * an update inside the window is held and sent when the window opens, and a
   * newer one supersedes it. Panning a map generates updates far faster than
   * once a second, and a dropped connection is a worse outcome than a slightly
   * stale bounding box.
   */
  updateSubscription(subscription: AisSubscription): void {
    this.subscription = subscription;
    if (this.stopped || !this.socket) return;

    if (this.pendingSubscriptionHandle !== undefined) return; // already queued

    const sinceLast = this.now() - this.lastSubscriptionAt;
    if (sinceLast >= SUBSCRIPTION_MIN_INTERVAL_MS) {
      this.sendSubscription();
      return;
    }
    this.pendingSubscriptionHandle = (this.opts.setTimeout ?? setTimeout)(() => {
      this.pendingSubscriptionHandle = undefined;
      if (!this.stopped && this.socket) this.sendSubscription();
    }, SUBSCRIPTION_MIN_INTERVAL_MS - sinceLast);
  }

  /**
   * Send the current subscription, if there is anywhere to send it.
   *
   * This must never throw. `updateSubscription` is called from a map's
   * `moveend` handler, which MapLibre runs inside its render task queue; an
   * exception escaping from there leaves that queue flagged as still running
   * and every subsequent frame fails on the check, so the chart freezes
   * permanently while the rest of the page carries on. A rate-limited feed is
   * a nuisance; a dead chart is the tool not working.
   *
   * Nothing is lost by not sending: the subscription is already stored, and
   * `onopen` sends whatever is current the moment the socket is usable.
   */
  private sendSubscription(): void {
    if (!this.socket || !this.socketOpen) return;
    try {
      this.socket.send(JSON.stringify(this.buildSubscriptionMessage()));
    } catch (err) {
      // A socket that rejects a send is not a socket worth keeping.
      this.socketOpen = false;
      this.scheduleReconnect(
        `subscription failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.lastSubscriptionAt = this.now();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const handle of [this.reconnectHandle, this.pendingSubscriptionHandle]) {
      if (handle !== undefined) (this.opts.clearTimeout ?? clearTimeout)(handle as never);
    }
    this.reconnectHandle = undefined;
    this.pendingSubscriptionHandle = undefined;
    this.socketOpen = false;
    this.socket?.close();
    this.socket = undefined;
    this.setState('stopped');
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState(this.backoff.attempts === 0 ? 'connecting' : 'reconnecting');

    const factory =
      this.opts.webSocketFactory ??
      ((url: string) => {
        const socket = new WebSocket(url);
        // The service sends binary frames. Without this a browser delivers
        // them as Blobs, which can only be read asynchronously; an ArrayBuffer
        // is decoded in place and keeps frame handling synchronous.
        socket.binaryType = 'arraybuffer';
        return socket as unknown as AisStreamSocket;
      });

    let socket: AisStreamSocket;
    try {
      socket = factory(this.opts.url ?? DEFAULT_URL);
    } catch (err) {
      this.scheduleReconnect(err instanceof Error ? err.message : 'socket construction failed');
      return;
    }
    this.socket = socket;
    // Not usable yet. The socket is CONNECTING until `onopen`, and sending on
    // it before then throws.
    this.socketOpen = false;

    socket.onopen = () => {
      this.socketOpen = true;
      // Must arrive within 3 s or the server hangs up, so it is sent
      // immediately on open rather than after any other setup.
      this.sendSubscription();
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
      this.socketOpen = false;
      // Drop the reference as well: a closed socket that is still held looks
      // like a live one to anything that only checks for its presence.
      if (this.socket === socket) this.socket = undefined;
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

  /**
   * Decode one frame, whatever form the transport delivered it in.
   *
   * aisstream.io sends JSON over *binary* WebSocket frames, not text ones.
   * That matters because the two runtimes hand binary over differently: Node's
   * `ws` gives a Buffer, while a browser gives a Blob by default and an
   * ArrayBuffer once `binaryType` is set. Treating anything non-string as
   * already-parsed - which is what this did - meant every frame in a browser
   * arrived as a Blob, produced an object with no MessageType, and was dropped
   * without a word. The connection looked healthy and nothing ever came out.
   */
  private handleRaw(data: unknown): void {
    if (typeof data === 'string') {
      this.parseAndPublish(data, data);
      return;
    }

    if (data instanceof ArrayBuffer) {
      this.parseAndPublish(new TextDecoder().decode(data), data);
      return;
    }

    if (ArrayBuffer.isView(data)) {
      // Covers a Node Buffer and any typed-array view a transport might use.
      this.parseAndPublish(new TextDecoder().decode(data as Uint8Array), data);
      return;
    }

    // A Blob can only be read asynchronously, so it is handled last and out of
    // band. Setting binaryType to 'arraybuffer' avoids this path, but a caller
    // supplying its own socket may not have.
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
      void data
        .text()
        .then((text) => this.parseAndPublish(text, data))
        .catch(() => this.fail('could not read binary frame', data));
      return;
    }

    this.fail(`frame of unsupported type: ${typeof data}`, data);
  }

  private parseAndPublish(text: string, raw: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.fail('malformed JSON frame', raw);
      return;
    }
    const message = this.adapt(parsed);
    if (message) this.publish(message);
  }

  /** Map one provider frame onto the normalised model. */
  private adapt(frame: unknown): AisMessage | undefined {
    if (!isRecord(frame)) {
      this.fail('frame was not a JSON object', frame);
      return undefined;
    }
    const messageType = asString(frame.MessageType);
    if (!messageType) {
      // Every documented frame carries a MessageType. One without it means the
      // shape is not what this adapter was built for, and saying so is the
      // difference between a visible failure and a feed that silently never
      // produces anything.
      this.fail('frame carried no MessageType', frame);
      return undefined;
    }
    if (messageType === 'SubscriptionConfirmation') return undefined;

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

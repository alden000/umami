import { EventBus, type Unsubscribe } from '@umami/core';
import type { AisMessage } from './types.js';

export type AisSourceState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'reconnecting'
  | 'stopped'
  | 'failed';

export interface AisSourceStatus {
  readonly state: AisSourceState;
  /** Human-readable detail for the status line. */
  readonly detail?: string;
  /** Messages accepted since start. */
  readonly messageCount: number;
  /** Wall-clock time of the most recent message. */
  readonly lastMessageAt?: number;
}

export interface AisSourceEvents extends Record<string, unknown> {
  message: AisMessage;
  status: AisSourceStatus;
  /** A message arrived but could not be decoded. Surfaced, never silently dropped. */
  decodeError: { readonly reason: string; readonly raw: unknown };
}

/**
 * Geographic area of interest.
 *
 * What this means depends on the source. Where the provider filters - a live
 * feed subscribed to a box - it is a request sent upstream, and whatever comes
 * back is accepted: a report that arrives is a real vessel that really
 * reported, and re-checking it against our own copy of the box only discards
 * genuine observations. Where there is no provider to ask - replaying a
 * recording - it is applied locally, because otherwise it would do nothing.
 */
export interface AisBoundingBox {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

export interface AisSubscription {
  readonly boundingBoxes?: readonly AisBoundingBox[];
  /** Restrict to specific vessels. Providers commonly cap this; aisstream.io allows 200. */
  readonly mmsiFilter?: readonly number[];
}

/**
 * A source of AIS messages.
 *
 * The contract is deliberately thin - start, stop, emit normalised messages -
 * because the set of sources is expected to grow: a national coastal receiver,
 * a satellite provider, a ship's own transponder over NMEA 0183, a recorded
 * exercise. Anything that can produce `AisMessage` values can drive the
 * simulation, and the simulation cannot tell the difference.
 *
 * Implementations must:
 *  - never throw out of `start`; report failure through `status` instead, since
 *    a feed dropping out mid-exercise is normal and must not stop the sim;
 *  - emit `decodeError` rather than discard malformed input silently;
 *  - be idempotent for repeated `stop` calls.
 */
export interface AisSource {
  readonly id: string;
  readonly kind: string;
  readonly status: AisSourceStatus;
  start(subscription?: AisSubscription): Promise<void>;
  stop(): Promise<void>;
  on<K extends keyof AisSourceEvents>(
    event: K,
    handler: (payload: AisSourceEvents[K]) => void,
  ): Unsubscribe;
}

/** Shared plumbing: event bus, status bookkeeping, reconnect timing. */
export abstract class BaseAisSource implements AisSource {
  abstract readonly kind: string;
  readonly id: string;
  protected readonly bus = new EventBus<AisSourceEvents>();
  private _status: AisSourceStatus = { state: 'idle', messageCount: 0 };

  constructor(id: string) {
    this.id = id;
  }

  get status(): AisSourceStatus {
    return this._status;
  }

  on<K extends keyof AisSourceEvents>(
    event: K,
    handler: (payload: AisSourceEvents[K]) => void,
  ): Unsubscribe {
    return this.bus.on(event, handler);
  }

  protected setState(state: AisSourceState, detail?: string): void {
    this._status = { ...this._status, state, detail };
    this.bus.emit('status', this._status);
  }

  protected publish(message: AisMessage): void {
    this._status = {
      ...this._status,
      messageCount: this._status.messageCount + 1,
      lastMessageAt: message.receivedAt,
    };
    this.bus.emit('message', message);
  }

  protected fail(reason: string, raw: unknown): void {
    this.bus.emit('decodeError', { reason, raw });
  }

  abstract start(subscription?: AisSubscription): Promise<void>;
  abstract stop(): Promise<void>;
}

/**
 * Exponential backoff with full jitter.
 *
 * Jitter matters here rather than being a nicety: when a provider restarts,
 * every client reconnects at once, and synchronised retries are what turn a
 * brief outage into a sustained one. aisstream.io asks for exactly this.
 */
export class BackoffPolicy {
  private attempt = 0;

  constructor(
    private readonly baseMs = 1000,
    private readonly maxMs = 60_000,
    private readonly random: () => number = Math.random,
  ) {}

  nextDelayMs(): number {
    const ceiling = Math.min(this.maxMs, this.baseMs * 2 ** this.attempt);
    this.attempt += 1;
    return Math.round(this.random() * ceiling);
  }

  reset(): void {
    this.attempt = 0;
  }

  get attempts(): number {
    return this.attempt;
  }
}

export function isInsideBoundingBox(
  lat: number,
  lon: number,
  box: AisBoundingBox,
): boolean {
  if (lat < box.south || lat > box.north) return false;
  // A box spanning the antimeridian has west > east.
  return box.west <= box.east
    ? lon >= box.west && lon <= box.east
    : lon >= box.west || lon <= box.east;
}

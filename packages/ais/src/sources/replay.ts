import { BaseAisSource, isInsideBoundingBox, type AisSubscription } from '../source.js';
import { NmeaAssembler } from '../aivdm.js';
import type { AisMessage } from '../types.js';

export interface ReplayOptions {
  readonly id?: string;
  /**
   * Playback rate relative to the recording's own timeline. 1 replays at the
   * speed it was captured; 60 compresses an hour into a minute; `Infinity`
   * delivers everything immediately, which is what batch evaluation wants.
   */
  readonly speed?: number;
  readonly loop?: boolean;
  /** Start at this offset into the recording, milliseconds. */
  readonly startOffsetMs?: number;
  readonly setTimeout?: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly now?: () => number;
}

/**
 * Replays recorded AIS with its original timing.
 *
 * Preserving inter-message gaps is the point. Real AIS is irregular - a Class A
 * vessel reports every 2 to 10 seconds depending on speed and turn rate, Class B
 * every 30 seconds, and coverage drops out - and an algorithm tuned against
 * evenly spaced synthetic updates will behave differently the first time it
 * meets a real feed. Replaying a captured incident at 60x is also the only
 * practical way to regression-test against a case that took an hour to unfold.
 */
export class ReplayAisSource extends BaseAisSource {
  readonly kind = 'replay';

  private readonly messages: readonly AisMessage[];
  private readonly opts: ReplayOptions;
  private index = 0;
  private handle?: unknown;
  private stopped = true;
  private subscription?: AisSubscription;

  constructor(messages: readonly AisMessage[], opts: ReplayOptions = {}) {
    super(opts.id ?? 'replay');
    this.messages = [...messages].sort((a, b) => a.receivedAt - b.receivedAt);
    this.opts = opts;
  }

  get length(): number {
    return this.messages.length;
  }

  /** Recording duration in milliseconds. */
  get durationMs(): number {
    if (this.messages.length < 2) return 0;
    const first = this.messages[0]?.receivedAt ?? 0;
    const last = this.messages[this.messages.length - 1]?.receivedAt ?? 0;
    return last - first;
  }

  async start(subscription: AisSubscription = {}): Promise<void> {
    this.subscription = subscription;
    this.stopped = false;
    this.index = 0;
    if (this.opts.startOffsetMs) {
      const from = (this.messages[0]?.receivedAt ?? 0) + this.opts.startOffsetMs;
      while (this.index < this.messages.length) {
        const at = this.messages[this.index]?.receivedAt ?? 0;
        if (at >= from) break;
        this.index += 1;
      }
    }
    this.setState('live', `${this.messages.length} messages`);
    this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.handle !== undefined) {
      (this.opts.clearTimeout ?? clearTimeout)(this.handle as never);
      this.handle = undefined;
    }
    this.setState('stopped');
  }

  /** Deliver everything remaining at once. Used by headless batch runs. */
  drain(): void {
    while (this.index < this.messages.length) {
      const message = this.messages[this.index];
      this.index += 1;
      if (message && this.passesFilter(message)) this.publish(message);
    }
    this.setState('stopped', 'recording exhausted');
  }

  private pump(): void {
    if (this.stopped) return;
    const speed = this.opts.speed ?? 1;
    if (!Number.isFinite(speed)) {
      this.drain();
      return;
    }

    const message = this.messages[this.index];
    if (!message) {
      if (this.opts.loop && this.messages.length > 0) {
        this.index = 0;
        this.pump();
      } else {
        this.setState('stopped', 'recording exhausted');
      }
      return;
    }

    if (this.passesFilter(message)) this.publish(message);
    this.index += 1;

    const next = this.messages[this.index];
    if (!next) {
      this.pump();
      return;
    }
    const gapMs = Math.max(0, (next.receivedAt - message.receivedAt) / Math.max(speed, 1e-6));
    this.handle = (this.opts.setTimeout ?? setTimeout)(() => this.pump(), gapMs);
  }

  private passesFilter(message: AisMessage): boolean {
    const sub = this.subscription;
    if (!sub) return true;
    if (sub.mmsiFilter?.length && !sub.mmsiFilter.includes(message.mmsi)) return false;
    if (sub.boundingBoxes?.length && 'position' in message) {
      const { lat, lon } = message.position;
      if (!sub.boundingBoxes.some((b) => isInsideBoundingBox(lat, lon, b))) return false;
    }
    return true;
  }
}

/** Parse a newline-delimited JSON recording produced by the AIS recorder. */
export function parseJsonlRecording(text: string): AisMessage[] {
  const out: AisMessage[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as AisMessage);
    } catch {
      // A truncated final line is normal when a recording is cut short.
    }
  }
  return out;
}

/** Parse a raw NMEA sentence log into normalised messages. */
export function parseNmeaRecording(
  text: string,
  sourceId = 'replay',
  startTime = Date.now(),
): AisMessage[] {
  const assembler = new NmeaAssembler({ sourceId, receivedAt: startTime });
  const out: AisMessage[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Some logs prefix each sentence with an epoch timestamp.
    const match = /^(\d{10,13})[,\s]+(.*)$/.exec(trimmed);
    const receivedAt = match ? Number(match[1]) : startTime;
    const sentence = match ? (match[2] ?? '') : trimmed;
    const message = assembler.push(sentence, receivedAt < 1e12 ? receivedAt * 1000 : receivedAt);
    if (message) out.push(message);
  }
  return out;
}

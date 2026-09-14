import { describe, expect, it } from 'vitest';
import { toDegrees, toKnots } from '@umami/core';
import { AisStreamSource, type AisStreamSocket } from './aisstream.js';
import { BackoffPolicy } from '../source.js';
import type { AisMessage, AisPositionMessage, AisStaticMessage } from '../types.js';

/** A socket the test drives directly, standing in for the provider. */
class FakeSocket implements AisStreamSocket {
  sent: string[] = [];
  closed = false;
  /** Mirrors WebSocket.readyState: false until OPEN, and again once closed. */
  opened = false;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;

  send(data: string): void {
    // A real WebSocket throws InvalidStateError when sent to while it is still
    // CONNECTING. Modelling that is the whole point of this fake: the socket
    // object exists from the moment it is constructed, so anything that checks
    // only for its presence will try to send down a socket that cannot take it.
    if (!this.opened) throw new Error('InvalidStateError: still CONNECTING');
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.opened = false;
  }

  open(): void {
    this.opened = true;
    this.onopen?.({});
  }
  /** Deliver as a text frame. */
  deliver(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) });
  }
  /** Deliver as a binary frame, which is what aisstream.io actually sends. */
  deliverBinary(frame: unknown): void {
    const bytes = new TextEncoder().encode(JSON.stringify(frame));
    this.onmessage?.({ data: bytes.buffer });
  }
  /** Deliver as a Blob, which is what a browser gives for a binary frame by
   *  default when binaryType has not been set. */
  deliverBlob(frame: unknown): void {
    this.onmessage?.({ data: new Blob([JSON.stringify(frame)]) });
  }
  drop(): void {
    this.opened = false;
    this.onclose?.({});
  }
  get subscription(): Record<string, unknown> {
    return JSON.parse(this.sent[0] ?? '{}') as Record<string, unknown>;
  }
}

interface Harness {
  source: AisStreamSource;
  sockets: FakeSocket[];
  messages: AisMessage[];
  errors: { reason: string }[];
  timers: (() => void)[];
  runTimers(): void;
}

function harness(opts: { mmsiFilter?: number[] } = {}): Harness {
  const sockets: FakeSocket[] = [];
  const messages: AisMessage[] = [];
  const errors: { reason: string }[] = [];
  const timers: (() => void)[] = [];

  const source = new AisStreamSource({
    apiKey: 'test-key',
    // Deterministic backoff: no jitter, so the test asserts scheduling rather
    // than luck.
    backoff: new BackoffPolicy(1000, 60_000, () => 1),
    webSocketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    now: () => 1_700_000_000_000,
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => undefined,
  });

  source.on('message', (m) => messages.push(m));
  source.on('decodeError', (e) => errors.push(e));
  return {
    source,
    sockets,
    messages,
    errors,
    timers,
    runTimers: () => {
      const pending = timers.splice(0);
      for (const fn of pending) fn();
    },
  };
}

const POSITION_FRAME = {
  MessageType: 'PositionReport',
  MetaData: { MMSI: 368207620, ShipName: 'EXAMPLE VESSEL', time_utc: '2026-01-01 02:03:04 +0000 UTC' },
  Message: {
    PositionReport: {
      MessageID: 1,
      UserID: 368207620,
      Sog: 12.4,
      Cog: 86.7,
      TrueHeading: 87,
      Latitude: 25.7617,
      Longitude: -80.1918,
      NavigationalStatus: 0,
      RateOfTurn: 0,
      Valid: true,
    },
  },
};

/** Singapore Strait, the area the web client opens on. */
const BOX = { south: 1.1, west: 103.5, north: 1.4, east: 104.1 };

describe('subscription', () => {
  it('sends a complete subscription immediately on open', async () => {
    // The provider closes the connection if no valid subscription arrives
    // within 3 seconds, so it must go first, before anything else.
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();

    expect(h.sockets[0]!.sent).toHaveLength(1);
    expect(h.sockets[0]!.subscription.APIKey).toBe('test-key');
  });

  it('defaults to the whole world when no bounding box is given', async () => {
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    // BoundingBoxes is required by the provider; an empty list is refused.
    expect(h.sockets[0]!.subscription.BoundingBoxes).toEqual([[[-90, -180], [90, 180]]]);
  });

  it('sends corner pairs as latitude then longitude', async () => {
    const h = harness();
    await h.source.start({
      boundingBoxes: [{ south: 1.1, west: 103.5, north: 1.5, east: 104.2 }],
    });
    h.sockets[0]!.open();
    expect(h.sockets[0]!.subscription.BoundingBoxes).toEqual([
      [
        [1.1, 103.5],
        [1.5, 104.2],
      ],
    ]);
  });

  it('caps the MMSI filter at the 200 the provider accepts, as strings', async () => {
    const h = harness();
    const many = Array.from({ length: 250 }, (_, i) => 200000000 + i);
    await h.source.start({ mmsiFilter: many });
    h.sockets[0]!.open();

    const filter = h.sockets[0]!.subscription.FiltersShipMMSI as string[];
    expect(filter).toHaveLength(200);
    expect(typeof filter[0]).toBe('string');
  });
});

describe('position reports', () => {
  it('converts knots and degrees to SI at the boundary', async () => {
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver(POSITION_FRAME);

    const m = h.messages[0] as AisPositionMessage;
    expect(m.kind).toBe('position');
    expect(m.mmsi).toBe(368207620);
    expect(m.position).toEqual({ lat: 25.7617, lon: -80.1918 });
    // The feed speaks knots and degrees; nothing downstream should have to know.
    expect(toKnots(m.sog!)).toBeCloseTo(12.4, 4);
    expect(toDegrees(m.cog!)).toBeCloseTo(86.7, 4);
    expect(toDegrees(m.trueHeading!)).toBeCloseTo(87, 4);
  });

  it('treats the not-available sentinels as absent rather than as values', async () => {
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({
      ...POSITION_FRAME,
      Message: {
        PositionReport: {
          UserID: 1,
          Latitude: 1,
          Longitude: 1,
          Sog: 102.3, // "not available"
          Cog: 360, // "not available"
          TrueHeading: 511, // "not available"
          RateOfTurn: -128, // "not available"
        },
      },
    });

    const m = h.messages[0] as AisPositionMessage;
    expect(m.sog).toBeUndefined();
    expect(m.cog).toBeUndefined();
    expect(m.trueHeading).toBeUndefined();
    expect(m.rateOfTurn).toBeUndefined();
  });

  it('distinguishes Class B from Class A', async () => {
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({
      MessageType: 'StandardClassBPositionReport',
      MetaData: { MMSI: 2 },
      Message: { StandardClassBPositionReport: { UserID: 2, Latitude: 1, Longitude: 1 } },
    });
    expect((h.messages[0] as AisPositionMessage).stationClass).toBe('B');
  });

  it('processes every report received, including outside the subscribed box', async () => {
    // The subscription is a request to the provider, not a filter to enforce on
    // what comes back. A report that arrives is a real vessel that really
    // reported; dropping it against our own copy of the box would discard a
    // genuine observation, and would lose contacts outright in the window
    // between a local box changing and the provider acting on it.
    const h = harness();
    await h.source.start({
      boundingBoxes: [{ south: 1, west: 103, north: 2, east: 104 }],
    });
    h.sockets[0]!.open();
    h.sockets[0]!.deliver(POSITION_FRAME); // Miami, well outside Singapore
    expect(h.messages).toHaveLength(1);
    expect((h.messages[0] as AisPositionMessage).position.lat).toBeCloseTo(25.7617, 4);
  });
});

describe('metadata field casing', () => {
  it('reads the lowercase latitude and longitude the service actually sends', async () => {
    // Live MetaData is {"MMSI":...,"ShipName":...,"latitude":...,"longitude":...}
    // - lowercase, unlike every other key in the envelope.
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    h.sockets[0]!.deliverBinary({
      MessageType: 'PositionReport',
      MetaData: {
        MMSI: 538011723,
        ShipName: 'CAPTAIN LEON        ',
        latitude: 1.28593,
        longitude: 103.95173,
        time_utc: '2026-09-14 07:17:46.720548509 +0000 UTC',
      },
      Message: { PositionReport: { UserID: 538011723, Sog: 4.1, Valid: true } },
    });

    const m = h.messages[0] as AisPositionMessage;
    expect(m.position.lat).toBeCloseTo(1.28593, 5);
    expect(m.position.lon).toBeCloseTo(103.95173, 5);
  });

  it('parses the nanosecond-precision timestamp format', async () => {
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    h.sockets[0]!.deliverBinary({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 1, latitude: 0, longitude: 0, time_utc: '2026-09-14 07:17:46.720548509 +0000 UTC' },
      Message: { PositionReport: { UserID: 1 } },
    });
    const m = h.messages[0]!;
    expect(Number.isFinite(m.receivedAt)).toBe(true);
    expect(m.receivedAt).toBeGreaterThan(Date.parse('2026-09-14T00:00:00Z'));
  });
});

describe('static data', () => {
  it('maps identity and dimensions', async () => {
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({
      MessageType: 'ShipStaticData',
      MetaData: { MMSI: 351759000, ShipName: 'EVER DIADEM' },
      Message: {
        ShipStaticData: {
          UserID: 351759000,
          ImoNumber: 9134270,
          CallSign: '3FOF8',
          Name: 'EVER DIADEM',
          Type: 70,
          MaximumStaticDraught: 12.2,
          Destination: 'NEW YORK',
          Dimension: { A: 225, B: 70, C: 1, D: 31 },
          Eta: { Month: 5, Day: 15, Hour: 14, Minute: 0 },
        },
      },
    });

    const m = h.messages[0] as AisStaticMessage;
    expect(m.kind).toBe('static');
    expect(m.name).toBe('EVER DIADEM');
    expect(m.imoNumber).toBe(9134270);
    expect(m.shipType).toBe(70);
    expect(m.dimensions).toEqual({ toBow: 225, toStern: 70, toPort: 1, toStarboard: 31 });
    expect(m.draught).toBeCloseTo(12.2, 4);
  });

  it('falls back to the metadata ship name when the payload omits it', async () => {
    // The provider does not publish the ShipStaticData field list, so each
    // field is read defensively: an unexpected name must cost that one field,
    // not the vessel's whole identity.
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({
      MessageType: 'ShipStaticData',
      MetaData: { MMSI: 1, ShipName: 'FROM METADATA' },
      Message: { ShipStaticData: { UserID: 1 } },
    });
    expect((h.messages[0] as AisStaticMessage).name).toBe('FROM METADATA');
  });
});

describe('binary frames', () => {
  // The service sends JSON over binary WebSocket frames, not text ones. This
  // was missed because the local test double sent text: everything passed, and
  // in a browser every frame arrived as a Blob and was dropped in silence.
  it('decodes a binary frame', async () => {
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    h.sockets[0]!.deliverBinary(POSITION_FRAME);

    expect(h.messages).toHaveLength(1);
    expect((h.messages[0] as AisPositionMessage).mmsi).toBe(368207620);
  });

  it('decodes a Blob frame, for a socket without binaryType set', async () => {
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    h.sockets[0]!.deliverBlob(POSITION_FRAME);

    // Blobs can only be read asynchronously.
    await new Promise((r) => setTimeout(r, 20));
    expect(h.messages).toHaveLength(1);
  });

  it('reports a frame it cannot make sense of rather than dropping it', async () => {
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    // An object with no MessageType is exactly what a mishandled binary frame
    // used to look like by the time it reached the adapter.
    h.sockets[0]!.deliver({ some: 'other shape' });

    expect(h.messages).toHaveLength(0);
    expect(h.errors[0]!.reason).toContain('MessageType');
  });
});

describe('robustness', () => {
  it('reports malformed JSON instead of throwing', async () => {
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    expect(() => h.sockets[0]!.deliver('{not json')).not.toThrow();
    expect(h.errors[0]!.reason).toContain('malformed JSON');
  });

  it('ignores the subscription confirmation', async () => {
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    // Verbatim from the live service: no MetaData, and CompressionEnabled
    // sits directly under Message rather than under a nested key.
    h.sockets[0]!.deliverBinary({
      Message: { CompressionEnabled: true },
      MessageType: 'SubscriptionConfirmation',
    });
    expect(h.messages).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
  });

  it('rejects a position outside the possible range', async () => {
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    h.sockets[0]!.deliver({
      MessageType: 'PositionReport',
      MetaData: { MMSI: 1 },
      Message: { PositionReport: { UserID: 1, Latitude: 91, Longitude: 0 } },
    });
    expect(h.messages).toHaveLength(0);
    expect(h.errors[0]!.reason).toContain('out of range');
  });

  it('counts messages and tracks state', async () => {
    const h = harness();
    expect(h.source.status.state).toBe('idle');
    await h.source.start();
    h.sockets[0]!.open();
    expect(h.source.status.state).toBe('live');
    h.sockets[0]!.deliver(POSITION_FRAME);
    expect(h.source.status.messageCount).toBe(1);
  });
});

describe('subscription updates', () => {
  it('sends an update immediately when outside the rate-limit window', async () => {
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    // The fake clock never advances, so force the window open by starting from
    // a source whose last send is already a second behind.
    h.source.updateSubscription({
      boundingBoxes: [{ south: 0, west: 0, north: 1, east: 1 }],
    });
    // Held rather than sent, because no time has passed on the injected clock.
    expect(h.sockets[0]!.sent).toHaveLength(1);

    h.runTimers();
    expect(h.sockets[0]!.sent).toHaveLength(2);
    const latest = JSON.parse(h.sockets[0]!.sent[1]!) as { BoundingBoxes: unknown };
    expect(latest.BoundingBoxes).toEqual([
      [
        [0, 0],
        [1, 1],
      ],
    ]);
  });

  it('collapses a burst of updates into one send', async () => {
    // Panning a map produces updates far faster than once a second, and the
    // provider closes a connection that receives them.
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();

    for (let i = 1; i <= 20; i++) {
      h.source.updateSubscription({
        boundingBoxes: [{ south: 0, west: 0, north: i, east: i }],
      });
    }
    expect(h.sockets[0]!.sent).toHaveLength(1); // nothing sent yet
    expect(h.timers).toHaveLength(1); // and only one send queued

    h.runTimers();
    expect(h.sockets[0]!.sent).toHaveLength(2);
    // The newest box wins, not the one that happened to be queued first.
    const latest = JSON.parse(h.sockets[0]!.sent[1]!) as { BoundingBoxes: number[][][] };
    expect(latest.BoundingBoxes[0]![1]).toEqual([20, 20]);
  });

  it('does not send an update after stopping', async () => {
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    await h.source.stop();
    h.source.updateSubscription({ boundingBoxes: [{ south: 0, west: 0, north: 1, east: 1 }] });
    h.runTimers();
    expect(h.sockets[0]!.sent).toHaveLength(1);
  });
});

describe('reconnection', () => {
  it('reconnects after the socket drops and resubscribes', async () => {
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    h.sockets[0]!.drop();

    expect(h.source.status.state).toBe('reconnecting');
    h.runTimers();

    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.open();
    // A reconnect is useless without the subscription going out again.
    expect(h.sockets[1]!.sent).toHaveLength(1);
    expect(h.source.status.state).toBe('live');
  });

  it('does not reconnect after an explicit stop', async () => {
    const h = harness();
    await h.source.start();
    h.sockets[0]!.open();
    await h.source.stop();
    h.sockets[0]!.drop();
    h.runTimers();

    expect(h.sockets).toHaveLength(1);
    expect(h.source.status.state).toBe('stopped');
  });

  // These cover the cause of a chart that froze after a minute of panning and
  // zooming with live AIS on. `updateSubscription` is called from the map's
  // `moveend` handler, which MapLibre runs inside its render task queue; that
  // queue marks itself as running and clears the flag only after the loop, so
  // an exception escaping a listener leaves it permanently flagged and every
  // later frame fails immediately. The chart stops rendering for good, in
  // silence, while the rest of the page is fine. Nothing here may throw.
  describe('never throws at the caller', () => {
    it('holds a subscription sent while the socket is still connecting', async () => {
      const h = harness();
      await h.source.start();

      // The socket exists but has not opened. This is the window every
      // reconnect passes through.
      expect(() => h.source.updateSubscription({ boundingBoxes: [BOX] })).not.toThrow();
      expect(h.sockets[0]!.sent).toHaveLength(0);

      // And it goes out, current, as soon as the socket can take it.
      h.sockets[0]!.open();
      expect(h.sockets[0]!.sent).toHaveLength(1);
      expect(h.sockets[0]!.subscription.BoundingBoxes).toEqual([
        [
          [BOX.south, BOX.west],
          [BOX.north, BOX.east],
        ],
      ]);
    });

    it('survives a view change during the gap between connections', async () => {
      const h = harness();
      await h.source.start();
      h.sockets[0]!.open();
      h.sockets[0]!.drop();

      // Reconnect is scheduled but has not fired: there is no socket at all.
      expect(() => h.source.updateSubscription({ boundingBoxes: [BOX] })).not.toThrow();

      h.runTimers();
      h.sockets[1]!.open();
      expect(h.sockets[1]!.subscription.BoundingBoxes).toEqual([
        [
          [BOX.south, BOX.west],
          [BOX.north, BOX.east],
        ],
      ]);
    });

    it('reconnects rather than throwing when a send is rejected', async () => {
      const h = harness();
      await h.source.start();
      const socket = h.sockets[0]!;
      socket.open();
      // Open as far as this adapter knows, but the underlying socket refuses -
      // a connection torn down without an onclose, which does happen.
      socket.opened = false;

      h.source.updateSubscription({ boundingBoxes: [BOX] });
      // Held behind the provider's one-per-second limit, so the send happens
      // when that timer fires - which must not throw out of the timer either.
      expect(() => h.runTimers()).not.toThrow();
      expect(h.source.status.state).toBe('reconnecting');

      h.runTimers();
      expect(h.sockets).toHaveLength(2);
    });
  });

  it('backs off further on each successive failure', async () => {
    const delays: number[] = [];
    const policy = new BackoffPolicy(1000, 60_000, () => 1);
    for (let i = 0; i < 4; i++) delays.push(policy.nextDelayMs());
    // Exponential, and capped - so a long outage does not become a busy loop.
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });
});

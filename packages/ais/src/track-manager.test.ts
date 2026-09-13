import { describe, expect, it } from 'vitest';
import { degrees, haversineDistance, knots } from '@umami/core';
import { TrackManager } from './track-manager.js';
import type { AisMessage } from './types.js';

const T0 = 1_700_000_000_000;
const MMSI = 123456789;

function position(over: Record<string, unknown> = {}): AisMessage {
  return {
    kind: 'position',
    mmsi: MMSI,
    sourceId: 'test',
    stationClass: 'A',
    receivedAt: T0,
    position: { lat: 1.26, lon: 103.84 },
    sog: knots(10),
    cog: degrees(90),
    ...over,
  } as AisMessage;
}

describe('TrackManager', () => {
  it('creates a contact on first report and updates it thereafter', () => {
    const tm = new TrackManager();
    const events: string[] = [];
    tm.on('added', () => events.push('added'));
    tm.on('updated', () => events.push('updated'));

    tm.ingest(position());
    tm.ingest(position({ receivedAt: T0 + 10_000, position: { lat: 1.26, lon: 103.8409 } }));

    expect(events).toEqual(['added', 'updated']);
    expect(tm.size).toBe(1);
    expect(tm.get(MMSI)?.reportCount).toBe(2);
  });

  it('merges static data into the kinematic picture without losing position', () => {
    const tm = new TrackManager();
    tm.ingest(position());
    tm.ingest({
      kind: 'static',
      mmsi: MMSI,
      sourceId: 'test',
      stationClass: 'A',
      receivedAt: T0 + 1000,
      name: 'TEST VESSEL',
      shipType: 70,
      dimensions: { toBow: 150, toStern: 50, toPort: 15, toStarboard: 15 },
    });

    const c = tm.get(MMSI);
    expect(c?.name).toBe('TEST VESSEL');
    expect(c?.category).toBe('cargo');
    expect(c?.loa).toBe(200);
    expect(c?.beam).toBe(30);
    expect(c?.position.lon).toBeCloseTo(103.84, 6);
  });

  it('merges the two halves of a Class B static report', () => {
    const tm = new TrackManager();
    tm.ingest(position({ stationClass: 'B' }));
    tm.ingest({
      kind: 'static',
      mmsi: MMSI,
      sourceId: 'test',
      stationClass: 'B',
      receivedAt: T0 + 1000,
      name: 'SMALL CRAFT',
    });
    tm.ingest({
      kind: 'static',
      mmsi: MMSI,
      sourceId: 'test',
      stationClass: 'B',
      receivedAt: T0 + 2000,
      shipType: 37,
      dimensions: { toBow: 8, toStern: 4, toPort: 2, toStarboard: 2 },
    });

    const c = tm.get(MMSI);
    expect(c?.name).toBe('SMALL CRAFT'); // part B must not clobber part A
    expect(c?.shipType).toBe(37);
    expect(c?.category).toBe('pleasure');
    expect(c?.loa).toBe(12);
  });

  it('rejects a position jump that would need an impossible speed', () => {
    const tm = new TrackManager();
    const rejected: string[] = [];
    tm.on('rejected', (e) => rejected.push(e.reason));

    tm.ingest(position());
    tm.ingest(position({ receivedAt: T0 + 1000, position: { lat: 2.16, lon: 103.84 } }));

    expect(rejected).toHaveLength(1);
    expect(tm.get(MMSI)?.position.lat).toBeCloseTo(1.26, 6);
  });

  it('accepts fast but plausible movement', () => {
    const tm = new TrackManager();
    tm.ingest(position());
    tm.ingest(position({ receivedAt: T0 + 10_000, position: { lat: 1.26, lon: 103.8409 } }));
    expect(tm.get(MMSI)?.position.lon).toBeCloseTo(103.8409, 5);
  });

  it('dead-reckons between reports along the reported course', () => {
    const tm = new TrackManager();
    tm.ingest(position({ sog: knots(10), cog: degrees(90) }));
    const c = tm.get(MMSI)!;

    const after60s = tm.extrapolate(c, T0 + 60_000)!;
    expect(after60s.lon).toBeGreaterThan(c.position.lon);
    expect(after60s.lat).toBeCloseTo(c.position.lat, 4);
    expect(haversineDistance(c.position, after60s)).toBeCloseTo(309, 0);
  });

  it('refuses to extrapolate a contact that has been silent too long', () => {
    const tm = new TrackManager({ maxExtrapolationMs: 60_000 });
    tm.ingest(position());
    const c = tm.get(MMSI)!;
    expect(tm.extrapolate(c, T0 + 30_000)).toBeDefined();
    expect(tm.extrapolate(c, T0 + 120_000)).toBeUndefined();
  });

  it('prunes contacts that have gone quiet', () => {
    const tm = new TrackManager({ staleAfterMs: 60_000 });
    const removed: number[] = [];
    tm.on('removed', (e) => removed.push(e.mmsi));

    tm.ingest(position());
    expect(tm.pruneStale(T0 + 30_000)).toBe(0);
    expect(tm.pruneStale(T0 + 120_000)).toBe(1);
    expect(removed).toEqual([MMSI]);
    expect(tm.size).toBe(0);
  });
});

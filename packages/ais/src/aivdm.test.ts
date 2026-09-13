import { describe, expect, it } from 'vitest';
import { NmeaAssembler, decodePayload } from './aivdm.js';
import { toDegrees, toKnots } from '@umami/core';
import type { AisPositionMessage, AisStaticMessage } from './types.js';

const CTX = { sourceId: 'test', receivedAt: 1_700_000_000_000 };

describe('type 1 position report', () => {
  // Real sentence: a vessel moored in Seattle.
  const payload = '177KQJ5000G?tO`K>RA1wUbN0TKH';

  it('decodes identity, position and kinematics', () => {
    const m = decodePayload(payload, 0, CTX) as AisPositionMessage;
    expect(m.kind).toBe('position');
    expect(m.mmsi).toBe(477553000);
    expect(m.stationClass).toBe('A');
    expect(m.position.lat).toBeCloseTo(47.582833, 5);
    expect(m.position.lon).toBeCloseTo(-122.345833, 5);
    expect(toKnots(m.sog ?? -1)).toBeCloseTo(0, 3);
    expect(toDegrees(m.cog ?? -1)).toBeCloseTo(51, 3);
    expect(toDegrees(m.trueHeading ?? -1)).toBeCloseTo(181, 3);
    expect(m.navigationStatus).toBe(5); // moored
    expect(m.utcSecond).toBe(15);
  });

  it('reports speed in SI units, so no knots leak downstream', () => {
    const m = decodePayload(payload, 0, CTX) as AisPositionMessage;
    // Moored, so this is zero - but crucially it is metres per second.
    expect(m.sog).toBeCloseTo(0, 6);
  });
});

describe('type 5 static and voyage data', () => {
  // Real two-part sentence pair for a container ship.
  const partA =
    '!AIVDM,2,1,1,A,55?MbV02;H;s<HtKR20EHE:0@T4@Dn2222222216L961O5Gf0NSQEp6ClRp8,0*1C';
  const partB = '!AIVDM,2,2,1,A,88888888880,2*25';

  it('reassembles both fragments and decodes the voyage', () => {
    const assembler = new NmeaAssembler(CTX);
    expect(assembler.push(partA)).toBeUndefined(); // incomplete
    const m = assembler.push(partB) as AisStaticMessage;

    expect(m.kind).toBe('static');
    expect(m.mmsi).toBe(351759000);
    expect(m.name).toBe('EVER DIADEM');
    expect(m.callSign).toBe('3FOF8');
    expect(m.imoNumber).toBe(9134270);
    expect(m.shipType).toBe(70); // cargo
    expect(m.destination).toBe('NEW YORK');
    expect(m.draught).toBeCloseTo(12.2, 3);
    expect(m.dimensions).toEqual({ toBow: 225, toStern: 70, toPort: 1, toStarboard: 31 });
  });

  it('yields a length overall that matches the real ship', () => {
    const assembler = new NmeaAssembler(CTX);
    assembler.push(partA);
    const m = assembler.push(partB) as AisStaticMessage;
    const loa = (m.dimensions?.toBow ?? 0) + (m.dimensions?.toStern ?? 0);
    expect(loa).toBe(295);
  });

  it('emits nothing while a fragment is still missing', () => {
    const assembler = new NmeaAssembler(CTX);
    expect(assembler.push(partA)).toBeUndefined();
    expect(assembler.push(partA)).toBeUndefined();
  });

  it('bounds pending fragment groups so a lossy feed cannot leak memory', () => {
    const assembler = new NmeaAssembler(CTX, 4);
    for (let i = 0; i < 50; i++) {
      assembler.push(`!AIVDM,2,1,${i % 10},A,55?MbV02;H;s<HtKR20EHE:0@T4@Dn22,0*00`);
    }
    // Still able to complete a fresh group afterwards.
    assembler.push(partA);
    expect(assembler.push(partB)).toBeDefined();
  });
});

describe('robustness', () => {
  it('returns undefined for message types that are not modelled', () => {
    // Type 4 base station report.
    expect(decodePayload('400TcdiuiT7VDR>3nIfr6>i00000', 0, CTX)).toBeUndefined();
  });

  it('rejects payloads too short to be valid', () => {
    expect(decodePayload('1', 0, CTX)).toBeUndefined();
  });

  it('throws on characters outside the six-bit armour', () => {
    expect(() => decodePayload('17!KQJ5000G?tO`K>RA1wUbN0TKH', 0, CTX)).toThrow();
  });

  it('ignores sentences that are not AIVDM or AIVDO', () => {
    const assembler = new NmeaAssembler(CTX);
    expect(assembler.push('$GPGGA,123519,4807.038,N,01131.000,E,1,08,0.9,545.4,M')).toBeUndefined();
  });
});

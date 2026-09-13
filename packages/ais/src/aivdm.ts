import { degrees, knots, type UnixMillis } from '@umami/core';
import {
  NavigationStatus,
  type AisAtonMessage,
  type AisDimensions,
  type AisMessage,
  type AisPositionMessage,
  type AisStaticMessage,
} from './types.js';

/**
 * AIVDM/AIVDO decoding, ITU-R M.1371.
 *
 * Needed for every source that carries raw AIS rather than pre-decoded JSON:
 * a ship's own transponder over NMEA 0183, a coastal receiver, and the large
 * body of recorded data that exists only as NMEA sentence logs. The
 * aisstream.io feed is already decoded and does not pass through here.
 */

/** Reads big-endian bit fields out of the 6-bit armoured payload. */
export class BitReader {
  private readonly bits: Uint8Array;

  constructor(payload: string, fillBits = 0) {
    this.bits = new Uint8Array(payload.length * 6);
    for (let i = 0; i < payload.length; i++) {
      let value = payload.charCodeAt(i) - 48;
      if (value > 40) value -= 8;
      if (value < 0 || value > 63) throw new Error(`bad AIS armour character at ${i}`);
      for (let b = 0; b < 6; b++) {
        this.bits[i * 6 + b] = (value >> (5 - b)) & 1;
      }
    }
    if (fillBits > 0) this.bits = this.bits.subarray(0, this.bits.length - fillBits);
  }

  get length(): number {
    return this.bits.length;
  }

  /** Unsigned integer field. */
  u(start: number, len: number): number {
    let value = 0;
    for (let i = 0; i < len; i++) {
      value = value * 2 + (this.bits[start + i] ?? 0);
    }
    return value;
  }

  /** Two's-complement signed integer field. */
  i(start: number, len: number): number {
    const raw = this.u(start, len);
    const sign = 1 << (len - 1);
    return raw >= sign ? raw - 2 * sign : raw;
  }

  b(start: number): boolean {
    return this.bits[start] === 1;
  }

  /** Six-bit ASCII text field, trailing '@' and spaces stripped. */
  text(start: number, len: number): string {
    const chars: string[] = [];
    for (let i = 0; i + 6 <= len; i += 6) {
      const code = this.u(start + i, 6);
      chars.push(code < 32 ? String.fromCharCode(code + 64) : String.fromCharCode(code));
    }
    return chars.join('').replace(/[@\s]+$/, '').trim();
  }
}

const LATLON_SCALE = 600_000; // 1/10000 minute
const SOG_UNAVAILABLE = 1023;
const COG_UNAVAILABLE = 3600;
const HEADING_UNAVAILABLE = 511;
const ROT_UNAVAILABLE = -128;
const LAT_UNAVAILABLE = 91 * LATLON_SCALE;
const LON_UNAVAILABLE = 181 * LATLON_SCALE;

/**
 * Rate of turn, decoded from the AIS eighth-root scale.
 *
 * The wire value is `4.733 * sqrt(deg/min)`, so it is neither linear nor in
 * useful units. Values of 127 and -127 mean "turning faster than 708 deg/min",
 * not an actual rate.
 */
function decodeRateOfTurn(raw: number): number | undefined {
  if (raw === ROT_UNAVAILABLE) return undefined;
  const degPerMin = Math.sign(raw) * (raw / 4.733) ** 2;
  return degrees(degPerMin / 60);
}

function decodeDimensions(r: BitReader, offset: number): AisDimensions | undefined {
  const toBow = r.u(offset, 9);
  const toStern = r.u(offset + 9, 9);
  const toPort = r.u(offset + 18, 6);
  const toStarboard = r.u(offset + 24, 6);
  if (toBow + toStern + toPort + toStarboard === 0) return undefined;
  return { toBow, toStern, toPort, toStarboard };
}

export interface DecodeContext {
  readonly sourceId: string;
  readonly receivedAt: UnixMillis;
}

/** Decode one assembled AIVDM payload. Returns undefined for types not modelled. */
export function decodePayload(
  payload: string,
  fillBits: number,
  ctx: DecodeContext,
): AisMessage | undefined {
  const r = new BitReader(payload, fillBits);
  if (r.length < 38) return undefined;
  const type = r.u(0, 6);
  const mmsi = r.u(8, 30);
  const base = { mmsi, sourceId: ctx.sourceId, receivedAt: ctx.receivedAt };

  switch (type) {
    case 1:
    case 2:
    case 3:
      return decodeClassAPosition(r, base);
    case 5:
      return decodeStaticAndVoyage(r, base);
    case 18:
      return decodeClassBPosition(r, base);
    case 19:
      return decodeExtendedClassBPosition(r, base);
    case 21:
      return decodeAton(r, base);
    case 24:
      return decodeStaticDataReport(r, base);
    default:
      return undefined;
  }
}

type Base = { mmsi: number; sourceId: string; receivedAt: UnixMillis };

function position(r: BitReader, lonStart: number, latStart: number) {
  const rawLon = r.i(lonStart, 28);
  const rawLat = r.i(latStart, 27);
  if (Math.abs(rawLon) >= LON_UNAVAILABLE || Math.abs(rawLat) >= LAT_UNAVAILABLE) return undefined;
  return { lat: rawLat / LATLON_SCALE, lon: rawLon / LATLON_SCALE };
}

function decodeClassAPosition(r: BitReader, base: Base): AisPositionMessage | undefined {
  if (r.length < 168) return undefined;
  const pos = position(r, 61, 89);
  if (!pos) return undefined;
  const sog = r.u(50, 10);
  const cog = r.u(116, 12);
  const hdg = r.u(128, 9);
  return {
    ...base,
    kind: 'position',
    stationClass: 'A',
    position: pos,
    sog: sog === SOG_UNAVAILABLE ? undefined : knots(sog / 10),
    cog: cog >= COG_UNAVAILABLE ? undefined : degrees(cog / 10),
    trueHeading: hdg === HEADING_UNAVAILABLE ? undefined : degrees(hdg),
    rateOfTurn: decodeRateOfTurn(r.i(42, 8)),
    navigationStatus: r.u(38, 4) as NavigationStatus,
    positionAccuracyHigh: r.b(60),
    utcSecond: r.u(137, 6),
  };
}

function decodeClassBPosition(r: BitReader, base: Base): AisPositionMessage | undefined {
  if (r.length < 168) return undefined;
  const pos = position(r, 57, 85);
  if (!pos) return undefined;
  const sog = r.u(46, 10);
  const cog = r.u(112, 12);
  const hdg = r.u(124, 9);
  return {
    ...base,
    kind: 'position',
    stationClass: 'B',
    position: pos,
    sog: sog === SOG_UNAVAILABLE ? undefined : knots(sog / 10),
    cog: cog >= COG_UNAVAILABLE ? undefined : degrees(cog / 10),
    trueHeading: hdg === HEADING_UNAVAILABLE ? undefined : degrees(hdg),
    positionAccuracyHigh: r.b(56),
    utcSecond: r.u(133, 6),
  };
}

function decodeExtendedClassBPosition(r: BitReader, base: Base): AisPositionMessage | undefined {
  if (r.length < 312) return undefined;
  const pos = position(r, 57, 85);
  if (!pos) return undefined;
  const sog = r.u(46, 10);
  const cog = r.u(112, 12);
  const hdg = r.u(124, 9);
  return {
    ...base,
    kind: 'position',
    stationClass: 'B',
    position: pos,
    sog: sog === SOG_UNAVAILABLE ? undefined : knots(sog / 10),
    cog: cog >= COG_UNAVAILABLE ? undefined : degrees(cog / 10),
    trueHeading: hdg === HEADING_UNAVAILABLE ? undefined : degrees(hdg),
    positionAccuracyHigh: r.b(56),
    utcSecond: r.u(133, 6),
  };
}

function decodeStaticAndVoyage(r: BitReader, base: Base): AisStaticMessage | undefined {
  if (r.length < 420) return undefined;
  const draught = r.u(294, 8) / 10;
  return {
    ...base,
    kind: 'static',
    stationClass: 'A',
    imoNumber: r.u(40, 30) || undefined,
    callSign: r.text(70, 42) || undefined,
    name: r.text(112, 120) || undefined,
    shipType: r.u(232, 8) || undefined,
    dimensions: decodeDimensions(r, 240),
    eta: {
      month: r.u(274, 4) || undefined,
      day: r.u(278, 5) || undefined,
      hour: r.u(283, 5),
      minute: r.u(288, 6),
    },
    draught: draught > 0 ? draught : undefined,
    destination: r.text(302, 120) || undefined,
  };
}

function decodeAton(r: BitReader, base: Base): AisAtonMessage | undefined {
  if (r.length < 272) return undefined;
  const pos = position(r, 164, 192);
  if (!pos) return undefined;
  return {
    ...base,
    kind: 'aton',
    stationClass: 'aton',
    position: pos,
    atonType: r.u(38, 5) || undefined,
    name: r.text(43, 120) || undefined,
    dimensions: decodeDimensions(r, 219),
    offPosition: r.b(259),
    virtual: r.length > 269 ? r.b(269) : undefined,
  };
}

/**
 * Type 24 static data report, sent by Class B in two halves.
 *
 * Part A carries only the name and Part B only the dimensions and type, so
 * neither is complete on its own. Merging them is the track manager's job -
 * it already holds per-MMSI state, and duplicating that here would mean two
 * places could disagree about a vessel's identity.
 */
function decodeStaticDataReport(r: BitReader, base: Base): AisStaticMessage | undefined {
  if (r.length < 160) return undefined;
  const part = r.u(38, 2);
  if (part === 0) {
    return { ...base, kind: 'static', stationClass: 'B', name: r.text(40, 120) || undefined };
  }
  return {
    ...base,
    kind: 'static',
    stationClass: 'B',
    shipType: r.u(40, 8) || undefined,
    callSign: r.text(90, 42) || undefined,
    dimensions: decodeDimensions(r, 132),
  };
}

/**
 * Reassembles multi-part AIVDM sentences.
 *
 * A type 5 static report does not fit in one sentence, so it arrives split
 * across two or three that must be joined before decoding. Fragments are keyed
 * by the sequential message id the sentence carries, and incomplete groups are
 * evicted so a dropped fragment cannot leak memory over a long run.
 */
export class NmeaAssembler {
  private readonly groups = new Map<string, { parts: string[]; fill: number; seen: number }>();

  constructor(
    private readonly ctx: DecodeContext,
    private readonly maxPendingGroups = 64,
  ) {}

  /** Feed one NMEA sentence. Returns a message once a group completes. */
  push(sentence: string, receivedAt = this.ctx.receivedAt): AisMessage | undefined {
    const body = sentence.startsWith('!') || sentence.startsWith('$') ? sentence.slice(1) : sentence;
    const withoutChecksum = body.split('*')[0] ?? body;
    const fields = withoutChecksum.split(',');
    if (fields.length < 6) return undefined;
    const talker = fields[0] ?? '';
    if (!talker.endsWith('VDM') && !talker.endsWith('VDO')) return undefined;

    const total = Number(fields[1]);
    const index = Number(fields[2]);
    const groupId = fields[3] ?? '';
    const payload = fields[5] ?? '';
    const fill = Number(fields[6] ?? 0) || 0;
    if (!Number.isFinite(total) || !Number.isFinite(index) || payload === '') return undefined;

    const ctx: DecodeContext = { sourceId: this.ctx.sourceId, receivedAt };
    if (total === 1) return decodePayload(payload, fill, ctx);

    const key = `${talker}:${groupId}:${total}`;
    let group = this.groups.get(key);
    if (!group) {
      if (this.groups.size >= this.maxPendingGroups) {
        const oldest = this.groups.keys().next();
        if (!oldest.done) this.groups.delete(oldest.value);
      }
      group = { parts: new Array<string>(total).fill(''), fill: 0, seen: 0 };
      this.groups.set(key, group);
    }
    if (group.parts[index - 1] === '') group.seen += 1;
    group.parts[index - 1] = payload;
    if (index === total) group.fill = fill;

    if (group.seen < total) return undefined;
    this.groups.delete(key);
    return decodePayload(group.parts.join(''), group.fill, ctx);
  }
}

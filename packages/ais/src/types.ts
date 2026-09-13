import type { Degrees, MetresPerSecond, Radians, UnixMillis } from '@umami/core';

/**
 * Normalised AIS domain model.
 *
 * Every source - a live aisstream.io feed, a recorded file, a serial NMEA
 * receiver, the simulation's own vessels - is adapted into these types at the
 * edge. Nothing downstream knows or cares where a contact came from, which is
 * what makes the same collision-avoidance code testable against live traffic,
 * a replayed incident and a synthetic scenario without modification.
 */

/** Navigational status, ITU-R M.1371 table 45. */
export enum NavigationStatus {
  UnderWayUsingEngine = 0,
  AtAnchor = 1,
  NotUnderCommand = 2,
  RestrictedManoeuvrability = 3,
  ConstrainedByDraught = 4,
  Moored = 5,
  Aground = 6,
  EngagedInFishing = 7,
  UnderWaySailing = 8,
  AisSartActive = 14,
  Undefined = 15,
}

/** Which AIS station class a report came from. Class B is less frequent and less complete. */
export type AisStationClass = 'A' | 'B' | 'base-station' | 'aton' | 'sar-aircraft';

export interface AisMessageBase {
  /** Maritime Mobile Service Identity. The identity key for everything. */
  readonly mmsi: number;
  /** When the receiving system saw this report. */
  readonly receivedAt: UnixMillis;
  /** Which configured source produced it. */
  readonly sourceId: string;
  readonly stationClass: AisStationClass;
}

/** A kinematic report: message types 1, 2, 3, 18, 19. */
export interface AisPositionMessage extends AisMessageBase {
  readonly kind: 'position';
  readonly position: { readonly lat: Degrees; readonly lon: Degrees };
  /** Speed over ground, m/s. Undefined when the transmitter reports "not available". */
  readonly sog?: MetresPerSecond;
  /** Course over ground, radians from true north. */
  readonly cog?: Radians;
  /** True heading from a compass, radians. Distinct from course: a vessel in a
   * cross-current is not pointing where it is going, and a USV that conflates
   * the two will misjudge every crossing situation. */
  readonly trueHeading?: Radians;
  /** Rate of turn, radians per second. Positive to starboard. */
  readonly rateOfTurn?: number;
  readonly navigationStatus?: NavigationStatus;
  /** Whether the position came from a differential or high-accuracy fix. */
  readonly positionAccuracyHigh?: boolean;
  /** UTC second of the report as transmitted, 0-59; 60+ encode fix status. */
  readonly utcSecond?: number;
}

/** Reported hull dimensions, measured from the position-reporting antenna. */
export interface AisDimensions {
  /** Distance from the antenna to the bow, metres. */
  readonly toBow: number;
  /** Distance from the antenna to the stern, metres. */
  readonly toStern: number;
  /** Distance from the antenna to port, metres. */
  readonly toPort: number;
  /** Distance from the antenna to starboard, metres. */
  readonly toStarboard: number;
}

export function dimensionsToLoa(d: AisDimensions | undefined): number | undefined {
  if (!d) return undefined;
  const loa = d.toBow + d.toStern;
  return loa > 0 ? loa : undefined;
}

export function dimensionsToBeam(d: AisDimensions | undefined): number | undefined {
  if (!d) return undefined;
  const beam = d.toPort + d.toStarboard;
  return beam > 0 ? beam : undefined;
}

/** Identity and voyage data: message types 5, 24. */
export interface AisStaticMessage extends AisMessageBase {
  readonly kind: 'static';
  readonly name?: string;
  readonly callSign?: string;
  readonly imoNumber?: number;
  /** Ship and cargo type, ITU-R M.1371 table 50. */
  readonly shipType?: number;
  readonly dimensions?: AisDimensions;
  /** Maximum present static draught, metres. */
  readonly draught?: number;
  readonly destination?: string;
  /** Estimated time of arrival as transmitted; the year is not carried by AIS. */
  readonly eta?: {
    readonly month?: number;
    readonly day?: number;
    readonly hour?: number;
    readonly minute?: number;
  };
}

/** Aid to navigation report: message type 21. Buoys, beacons, platforms. */
export interface AisAtonMessage extends AisMessageBase {
  readonly kind: 'aton';
  readonly position: { readonly lat: Degrees; readonly lon: Degrees };
  readonly name?: string;
  /** Aid type, ITU-R M.1371 table 52. */
  readonly atonType?: number;
  readonly dimensions?: AisDimensions;
  /** True when the aid is a virtual AIS transmission with no physical mark. */
  readonly virtual?: boolean;
  /** True when the aid is reported off its charted position. */
  readonly offPosition?: boolean;
}

export type AisMessage = AisPositionMessage | AisStaticMessage | AisAtonMessage;

/** Broad category used for display symbology and for picking a dynamics model. */
export type AisShipCategory =
  | 'cargo'
  | 'tanker'
  | 'passenger'
  | 'high-speed'
  | 'fishing'
  | 'tug'
  | 'pleasure'
  | 'sailing'
  | 'military'
  | 'special'
  | 'unknown';

export function categoriseShipType(shipType: number | undefined): AisShipCategory {
  if (shipType === undefined || shipType <= 0) return 'unknown';
  if (shipType >= 80 && shipType <= 89) return 'tanker';
  if (shipType >= 70 && shipType <= 79) return 'cargo';
  if (shipType >= 60 && shipType <= 69) return 'passenger';
  if (shipType >= 40 && shipType <= 49) return 'high-speed';
  switch (shipType) {
    case 30:
      return 'fishing';
    case 31:
    case 32:
    case 52:
      return 'tug';
    case 35:
      return 'military';
    case 36:
      return 'sailing';
    case 37:
      return 'pleasure';
    case 33:
    case 34:
    case 50:
    case 51:
    case 53:
    case 54:
    case 55:
      return 'special';
    default:
      return 'unknown';
  }
}

/**
 * Country of registration, from the first three digits of the MMSI.
 *
 * Only the Maritime Identification Digits are decoded here, not the full
 * country table: the display needs a flag grouping, not a gazetteer.
 */
export function midFromMmsi(mmsi: number): number | undefined {
  const s = String(Math.trunc(mmsi));
  if (s.length !== 9) return undefined;
  const mid = Number(s.slice(0, 3));
  return mid >= 201 && mid <= 775 ? mid : undefined;
}

/** True for MMSIs that identify something other than a ship station. */
export function isNonShipMmsi(mmsi: number): boolean {
  const s = String(Math.trunc(mmsi));
  // 00xxxxxxx coast station, 99xxxxxxx aid to navigation, 98 craft associated
  // with a parent ship, 111xxxxxx SAR aircraft.
  return s.startsWith('00') || s.startsWith('99') || s.startsWith('98') || s.startsWith('111');
}

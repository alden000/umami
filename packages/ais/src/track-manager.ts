import {
  destinationPoint,
  haversineDistance,
  wrapAngle,
  type Degrees,
  type LatLon,
  type MetresPerSecond,
  type Radians,
  type UnixMillis,
} from '@umami/core';
import {
  categoriseShipType,
  dimensionsToBeam,
  dimensionsToLoa,
  type AisDimensions,
  type AisMessage,
  type AisShipCategory,
  type AisStationClass,
  type NavigationStatus,
} from './types.js';

/** A vessel as currently understood, merged from every report received. */
export interface AisContact {
  readonly mmsi: number;
  readonly stationClass: AisStationClass;
  readonly position: LatLon;
  readonly sog?: MetresPerSecond;
  readonly cog?: Radians;
  readonly trueHeading?: Radians;
  readonly rateOfTurn?: number;
  readonly navigationStatus?: NavigationStatus;
  readonly name?: string;
  readonly callSign?: string;
  readonly imoNumber?: number;
  readonly shipType?: number;
  readonly category: AisShipCategory;
  readonly dimensions?: AisDimensions;
  readonly loa?: number;
  readonly beam?: number;
  readonly draught?: number;
  readonly destination?: string;
  /** When the position last came from an actual report, not extrapolation. */
  readonly positionUpdatedAt: UnixMillis;
  /** When any field last changed. */
  readonly updatedAt: UnixMillis;
  /** Which source the most recent report arrived on. */
  readonly sourceId: string;
  /** Number of position reports received. Low counts mean low confidence. */
  readonly reportCount: number;
}

export interface TrackManagerOptions {
  /**
   * How long a contact may go without a position report before it is dropped.
   * The IMO performance standard for radar target tracking treats a target as
   * lost after a comparable interval; AIS coverage gaps of a minute or two are
   * routine, so this defaults generously.
   */
  readonly staleAfterMs?: number;
  /** How long a position may be dead-reckoned before it is no longer offered. */
  readonly maxExtrapolationMs?: number;
  /** Ignore reports whose position jumps implausibly far since the last one. */
  readonly maxPlausibleSpeed?: MetresPerSecond;
}

export interface TrackManagerEvents extends Record<string, unknown> {
  added: AisContact;
  updated: AisContact;
  removed: { readonly mmsi: number; readonly reason: 'stale' | 'cleared' };
  rejected: { readonly message: AisMessage; readonly reason: string };
}

/**
 * Maintains the current picture from a stream of AIS reports.
 *
 * AIS is not a state feed; it is a stream of partial, irregular, sometimes
 * wrong observations. This class is where that becomes a usable picture:
 * merging Class B's two-part static reports into one identity, holding
 * identity across position updates, rejecting implausible jumps, extrapolating
 * between reports so targets do not visibly stutter, and forgetting contacts
 * that have gone quiet. Everything downstream - the display, the collision
 * assessment, the USV's own situational awareness - reads contacts from here.
 */
export class TrackManager {
  private readonly contacts = new Map<number, AisContact>();
  private readonly opts: Required<TrackManagerOptions>;
  private readonly listeners = new Map<keyof TrackManagerEvents, Set<(p: never) => void>>();

  constructor(opts: TrackManagerOptions = {}) {
    this.opts = {
      staleAfterMs: opts.staleAfterMs ?? 10 * 60_000,
      maxExtrapolationMs: opts.maxExtrapolationMs ?? 3 * 60_000,
      maxPlausibleSpeed: opts.maxPlausibleSpeed ?? 40, // ~78 knots
    };
  }

  on<K extends keyof TrackManagerEvents>(
    event: K,
    handler: (payload: TrackManagerEvents[K]) => void,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (p: never) => void);
    return () => void set.delete(handler as (p: never) => void);
  }

  private emit<K extends keyof TrackManagerEvents>(event: K, payload: TrackManagerEvents[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of [...set]) (handler as (p: TrackManagerEvents[K]) => void)(payload);
  }

  get size(): number {
    return this.contacts.size;
  }

  get(mmsi: number): AisContact | undefined {
    return this.contacts.get(mmsi);
  }

  all(): AisContact[] {
    return [...this.contacts.values()];
  }

  clear(): void {
    for (const mmsi of this.contacts.keys()) this.emit('removed', { mmsi, reason: 'cleared' });
    this.contacts.clear();
  }

  /** Apply one report. */
  ingest(message: AisMessage): void {
    const existing = this.contacts.get(message.mmsi);

    if (message.kind === 'position' || message.kind === 'aton') {
      const rejection = this.implausible(existing, message.position, message.receivedAt);
      if (rejection) {
        this.emit('rejected', { message, reason: rejection });
        return;
      }
    }

    const next = this.merge(existing, message);
    this.contacts.set(message.mmsi, next);
    this.emit(existing ? 'updated' : 'added', next);
  }

  /**
   * Reject a position that would require an impossible speed.
   *
   * Bad MMSI programming and multipath both produce occasional wild fixes, and
   * a single one is enough to make a target appear to jump across a traffic
   * separation scheme - which a collision-avoidance algorithm will faithfully
   * react to. Cheap to check, and it removes a whole class of spurious alerts.
   */
  private implausible(
    existing: AisContact | undefined,
    position: LatLon,
    at: UnixMillis,
  ): string | undefined {
    if (!existing) return undefined;
    const dtSeconds = (at - existing.positionUpdatedAt) / 1000;
    if (dtSeconds <= 0) return undefined;
    const distance = haversineDistance(existing.position, position);
    const impliedSpeed = distance / dtSeconds;
    if (impliedSpeed > this.opts.maxPlausibleSpeed && distance > 100) {
      return `implied speed ${impliedSpeed.toFixed(1)} m/s over ${dtSeconds.toFixed(1)} s`;
    }
    return undefined;
  }

  private merge(existing: AisContact | undefined, message: AisMessage): AisContact {
    const base: AisContact = existing ?? {
      mmsi: message.mmsi,
      stationClass: message.stationClass,
      position: { lat: 0, lon: 0 },
      category: 'unknown',
      positionUpdatedAt: 0,
      updatedAt: message.receivedAt,
      sourceId: message.sourceId,
      reportCount: 0,
    };

    if (message.kind === 'position') {
      return {
        ...base,
        stationClass: message.stationClass,
        position: message.position,
        sog: message.sog ?? base.sog,
        cog: message.cog ?? base.cog,
        trueHeading: message.trueHeading ?? base.trueHeading,
        rateOfTurn: message.rateOfTurn ?? base.rateOfTurn,
        navigationStatus: message.navigationStatus ?? base.navigationStatus,
        positionUpdatedAt: message.receivedAt,
        updatedAt: message.receivedAt,
        sourceId: message.sourceId,
        reportCount: base.reportCount + 1,
      };
    }

    if (message.kind === 'aton') {
      return {
        ...base,
        stationClass: 'aton',
        position: message.position,
        name: message.name ?? base.name,
        dimensions: message.dimensions ?? base.dimensions,
        positionUpdatedAt: message.receivedAt,
        updatedAt: message.receivedAt,
        sourceId: message.sourceId,
        reportCount: base.reportCount + 1,
      };
    }

    // Static data. Fields are merged rather than replaced, because Class B
    // sends identity in two separate half-messages and either may arrive first.
    const dimensions = message.dimensions ?? base.dimensions;
    const shipType = message.shipType ?? base.shipType;
    return {
      ...base,
      name: message.name ?? base.name,
      callSign: message.callSign ?? base.callSign,
      imoNumber: message.imoNumber ?? base.imoNumber,
      shipType,
      category: categoriseShipType(shipType),
      dimensions,
      loa: dimensionsToLoa(dimensions) ?? base.loa,
      beam: dimensionsToBeam(dimensions) ?? base.beam,
      draught: message.draught ?? base.draught,
      destination: message.destination ?? base.destination,
      updatedAt: message.receivedAt,
      sourceId: message.sourceId,
    };
  }

  /**
   * Position a contact is estimated to occupy now.
   *
   * Straight-line dead reckoning on course and speed over ground. Returns
   * undefined past `maxExtrapolationMs`: showing a target that has not
   * reported for five minutes at a confidently extrapolated position is worse
   * than showing nothing, because it looks like knowledge.
   */
  extrapolate(contact: AisContact, at: UnixMillis): LatLon | undefined {
    const ageMs = at - contact.positionUpdatedAt;
    if (ageMs < 0) return contact.position;
    if (ageMs > this.opts.maxExtrapolationMs) return undefined;
    if (!contact.sog || !contact.cog || contact.sog < 0.1) return contact.position;
    return destinationPoint(contact.position, contact.cog, contact.sog * (ageMs / 1000));
  }

  /** Drop contacts that have gone quiet. Call periodically from the sim loop. */
  pruneStale(now: UnixMillis): number {
    let removed = 0;
    for (const [mmsi, contact] of this.contacts) {
      if (now - contact.positionUpdatedAt > this.opts.staleAfterMs) {
        this.contacts.delete(mmsi);
        this.emit('removed', { mmsi, reason: 'stale' });
        removed += 1;
      }
    }
    return removed;
  }
}

/** Heading to use for drawing a contact: true heading if known, else course. */
export function displayHeading(contact: AisContact): Radians | undefined {
  return contact.trueHeading ?? contact.cog;
}

/** Bearing from one position to another, in compass degrees. */
export function bearingDegrees(from: LatLon, to: LatLon): Degrees {
  const dLon = ((to.lon - from.lon) * Math.PI) / 180;
  const lat1 = (from.lat * Math.PI) / 180;
  const lat2 = (to.lat * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (wrapAngle(Math.atan2(y, x)) * 180) / Math.PI;
}

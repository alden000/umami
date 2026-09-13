/** Opaque identifier for anything the simulation tracks. */
export type EntityId = string & { readonly __brand: 'EntityId' };

export const entityId = (s: string): EntityId => s as EntityId;

/**
 * Deterministic id allocator.
 *
 * Ids are derived from a monotonic counter rather than a random source so
 * that two runs of the same scenario name the same objects, which is what
 * lets recorded runs be diffed against each other.
 */
export class IdAllocator {
  private counters = new Map<string, number>();

  next(prefix: string): EntityId {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return entityId(`${prefix}-${n}`);
  }

  /** Restore the allocator when resuming from a snapshot. */
  restore(counters: Readonly<Record<string, number>>): void {
    this.counters = new Map(Object.entries(counters));
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }
}

/** Stable id for an AIS-derived contact. MMSI is the natural key. */
export const mmsiToEntityId = (mmsi: number): EntityId => entityId(`ais-${mmsi}`);

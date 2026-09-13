import type { LatLon } from '@umami/core';

/**
 * An ENC cell, identified the way the IHO S-57 exchange format identifies one.
 *
 * The cell name encodes everything needed to decide precedence between
 * overlapping charts: `GB5X01SW` is producer GB, usage band 5 (harbour), and
 * a cell identifier. Usage band, not file order, decides which chart wins
 * where two cover the same water - a harbour chart must draw over the coastal
 * chart beneath it, always.
 */
export interface EncCell {
  /** Cell name, e.g. "GB5X01SW". Unique within a producer. */
  readonly name: string;
  /** Two-letter producer code, e.g. "GB", "NO", "SG". */
  readonly producer: string;
  /** Usage band 1-6; see `UsageBand`. */
  readonly usageBand: UsageBand;
  /** Edition number from the exchange set. */
  readonly edition: number;
  /** Highest update number applied, 0 for a base cell. */
  readonly updateNumber: number;
  /** Issue date, ISO 8601. */
  readonly issueDate: string;
  /** Compilation scale denominator, e.g. 22000 for 1:22 000. */
  readonly compilationScale: number;
  readonly bounds: CellBounds;
  /** Where the built tiles for this cell live, relative to the chart root. */
  readonly tileSource?: string;
}

export interface CellBounds {
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

/**
 * S-57 navigational purpose, encoded as the third character of the cell name.
 *
 * Determines both the scale at which a cell should be shown and, critically,
 * which cell takes precedence where several overlap.
 */
export enum UsageBand {
  Overview = 1,
  General = 2,
  Coastal = 3,
  Approach = 4,
  Harbour = 5,
  Berthing = 6,
}

/** Scale range each usage band is intended to be displayed over. */
export const USAGE_BAND_SCALES: Readonly<Record<UsageBand, { min: number; max: number }>> = {
  [UsageBand.Overview]: { min: 1_500_000, max: 10_000_000 },
  [UsageBand.General]: { min: 350_000, max: 1_500_000 },
  [UsageBand.Coastal]: { min: 90_000, max: 350_000 },
  [UsageBand.Approach]: { min: 22_000, max: 90_000 },
  [UsageBand.Harbour]: { min: 4_000, max: 22_000 },
  [UsageBand.Berthing]: { min: 1_000, max: 4_000 },
};

/** Parse the usage band out of a cell name. Returns undefined if malformed. */
export function usageBandFromCellName(name: string): UsageBand | undefined {
  const digit = Number(name.charAt(2));
  return digit >= 1 && digit <= 6 ? (digit as UsageBand) : undefined;
}

export function producerFromCellName(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

export function boundsContain(bounds: CellBounds, p: LatLon): boolean {
  return (
    p.lat >= bounds.south && p.lat <= bounds.north && p.lon >= bounds.west && p.lon <= bounds.east
  );
}

export function boundsOverlap(a: CellBounds, b: CellBounds): boolean {
  return !(a.east < b.west || a.west > b.east || a.north < b.south || a.south > b.north);
}

/**
 * The set of chart cells currently installed, and where their tiles are.
 *
 * Written by the ingest pipeline and read by the renderer. Keeping it as a
 * plain manifest file is what makes chart updates a data operation rather than
 * a code change: a new exchange set is ingested, the manifest is rewritten,
 * and the application picks up new coverage on reload without being rebuilt.
 * It is also what lets a deployment carry only the cells it is licensed for.
 */
export interface ChartCatalogue {
  /** Catalogue schema version, so a future format can be migrated. */
  readonly version: number;
  /** When the catalogue was generated, ISO 8601. */
  readonly generatedAt: string;
  readonly cells: readonly EncCell[];
  /** Tile URL template, e.g. "charts/{cell}.pmtiles". */
  readonly tileTemplate?: string;
}

export const EMPTY_CATALOGUE: ChartCatalogue = {
  version: 1,
  generatedAt: new Date(0).toISOString(),
  cells: [],
};

/**
 * Cells covering a position, best first.
 *
 * "Best" means the largest usage band - the most detailed chart - because that
 * is the one a mariner is required to use where it exists. Ordering rather
 * than selecting a single cell lets the caller fall back when a detailed cell
 * turns out not to carry the feature being looked for.
 */
export function cellsAt(catalogue: ChartCatalogue, p: LatLon): EncCell[] {
  return catalogue.cells
    .filter((c) => boundsContain(c.bounds, p))
    .sort((a, b) => b.usageBand - a.usageBand);
}

/** Cells that should be drawn at a given display scale denominator. */
export function cellsForScale(
  catalogue: ChartCatalogue,
  scaleDenominator: number,
  within?: CellBounds,
): EncCell[] {
  return catalogue.cells
    .filter((c) => {
      if (within && !boundsOverlap(c.bounds, within)) return false;
      const range = USAGE_BAND_SCALES[c.usageBand];
      return scaleDenominator >= range.min * 0.5 && scaleDenominator <= range.max * 2;
    })
    .sort((a, b) => a.usageBand - b.usageBand);
}

/**
 * Merge a newly ingested catalogue into an installed one.
 *
 * Update semantics follow S-57: a cell is replaced when the incoming edition
 * is newer, or the same edition carries a higher update number. Anything older
 * is ignored rather than applied, because ENC updates are strictly sequential
 * and applying them out of order silently corrupts the chart - the failure
 * mode being a chart that looks fine and is wrong.
 */
export function mergeCatalogue(
  installed: ChartCatalogue,
  incoming: ChartCatalogue,
): { catalogue: ChartCatalogue; added: string[]; updated: string[]; skipped: string[] } {
  const byName = new Map(installed.cells.map((c) => [c.name, c]));
  const added: string[] = [];
  const updated: string[] = [];
  const skipped: string[] = [];

  for (const cell of incoming.cells) {
    const existing = byName.get(cell.name);
    if (!existing) {
      byName.set(cell.name, cell);
      added.push(cell.name);
      continue;
    }
    const newer =
      cell.edition > existing.edition ||
      (cell.edition === existing.edition && cell.updateNumber > existing.updateNumber);
    if (newer) {
      byName.set(cell.name, cell);
      updated.push(cell.name);
    } else {
      skipped.push(cell.name);
    }
  }

  return {
    catalogue: {
      version: installed.version,
      generatedAt: new Date().toISOString(),
      cells: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
      tileTemplate: incoming.tileTemplate ?? installed.tileTemplate,
    },
    added,
    updated,
    skipped,
  };
}

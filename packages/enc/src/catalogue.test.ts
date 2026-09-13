import { describe, expect, it } from 'vitest';
import {
  EMPTY_CATALOGUE,
  UsageBand,
  cellsAt,
  cellsForScale,
  mergeCatalogue,
  producerFromCellName,
  usageBandFromCellName,
  type ChartCatalogue,
  type EncCell,
} from './catalogue.js';

const cell = (over: Partial<EncCell> & { name: string }): EncCell => ({
  producer: producerFromCellName(over.name),
  usageBand: usageBandFromCellName(over.name) ?? UsageBand.Coastal,
  edition: 1,
  updateNumber: 0,
  issueDate: '2026-01-01',
  compilationScale: 50_000,
  bounds: { south: 1.0, west: 103.5, north: 1.5, east: 104.2 },
  ...over,
});

const catalogue = (cells: EncCell[]): ChartCatalogue => ({
  version: 1,
  generatedAt: '2026-01-01T00:00:00Z',
  cells,
});

describe('cell naming', () => {
  it('reads producer and usage band from the cell name', () => {
    expect(producerFromCellName('SG5MP01')).toBe('SG');
    expect(usageBandFromCellName('SG5MP01')).toBe(UsageBand.Harbour);
    expect(usageBandFromCellName('GB3ABCDE')).toBe(UsageBand.Coastal);
  });

  it('returns undefined for a malformed name rather than guessing', () => {
    expect(usageBandFromCellName('BAD')).toBeUndefined();
    expect(usageBandFromCellName('SG9XX')).toBeUndefined();
  });
});

describe('cell selection', () => {
  it('prefers the most detailed chart covering a position', () => {
    const cat = catalogue([
      cell({ name: 'SG2OVERVW' }),
      cell({ name: 'SG5HARBOR' }),
      cell({ name: 'SG3COASTL' }),
    ]);
    const found = cellsAt(cat, { lat: 1.26, lon: 103.84 });
    expect(found[0]!.usageBand).toBe(UsageBand.Harbour);
    expect(found.map((c) => c.usageBand)).toEqual([
      UsageBand.Harbour,
      UsageBand.Coastal,
      UsageBand.General,
    ]);
  });

  it('excludes cells that do not cover the position', () => {
    const cat = catalogue([
      cell({ name: 'SG5HARBOR' }),
      cell({ name: 'GB5ELSEWH', bounds: { south: 50, west: -2, north: 51, east: 0 } }),
    ]);
    expect(cellsAt(cat, { lat: 1.26, lon: 103.84 })).toHaveLength(1);
  });

  it('picks cells appropriate to the display scale', () => {
    const cat = catalogue([cell({ name: 'SG5HARBOR' }), cell({ name: 'SG2GENERL' })]);
    const zoomedIn = cellsForScale(cat, 10_000).map((c) => c.name);
    const zoomedOut = cellsForScale(cat, 1_000_000).map((c) => c.name);
    expect(zoomedIn).toContain('SG5HARBOR');
    expect(zoomedOut).toContain('SG2GENERL');
    expect(zoomedOut).not.toContain('SG5HARBOR');
  });
});

describe('chart updates', () => {
  it('installs cells that are not yet present', () => {
    const result = mergeCatalogue(EMPTY_CATALOGUE, catalogue([cell({ name: 'SG5MP01' })]));
    expect(result.added).toEqual(['SG5MP01']);
    expect(result.catalogue.cells).toHaveLength(1);
  });

  it('applies a newer edition', () => {
    const installed = catalogue([cell({ name: 'SG5MP01', edition: 1 })]);
    const result = mergeCatalogue(installed, catalogue([cell({ name: 'SG5MP01', edition: 2 })]));
    expect(result.updated).toEqual(['SG5MP01']);
    expect(result.catalogue.cells[0]!.edition).toBe(2);
  });

  it('applies a higher update number within the same edition', () => {
    const installed = catalogue([cell({ name: 'SG5MP01', edition: 2, updateNumber: 3 })]);
    const result = mergeCatalogue(
      installed,
      catalogue([cell({ name: 'SG5MP01', edition: 2, updateNumber: 4 })]),
    );
    expect(result.updated).toEqual(['SG5MP01']);
    expect(result.catalogue.cells[0]!.updateNumber).toBe(4);
  });

  it('refuses to apply an older edition over a newer one', () => {
    // ENC updates are strictly sequential; applying one out of order produces
    // a chart that looks correct and is wrong.
    const installed = catalogue([cell({ name: 'SG5MP01', edition: 3 })]);
    const result = mergeCatalogue(installed, catalogue([cell({ name: 'SG5MP01', edition: 2 })]));
    expect(result.skipped).toEqual(['SG5MP01']);
    expect(result.catalogue.cells[0]!.edition).toBe(3);
  });

  it('refuses to apply an earlier update within the same edition', () => {
    const installed = catalogue([cell({ name: 'SG5MP01', edition: 2, updateNumber: 5 })]);
    const result = mergeCatalogue(
      installed,
      catalogue([cell({ name: 'SG5MP01', edition: 2, updateNumber: 2 })]),
    );
    expect(result.skipped).toEqual(['SG5MP01']);
    expect(result.catalogue.cells[0]!.updateNumber).toBe(5);
  });

  it('leaves unrelated cells untouched when applying an update', () => {
    const installed = catalogue([cell({ name: 'SG5MP01' }), cell({ name: 'SG5MP02' })]);
    const result = mergeCatalogue(installed, catalogue([cell({ name: 'SG5MP01', edition: 2 })]));
    expect(result.catalogue.cells).toHaveLength(2);
    expect(result.catalogue.cells.find((c) => c.name === 'SG5MP02')!.edition).toBe(1);
  });
});

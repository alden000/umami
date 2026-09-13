import type { CellBounds, ChartCatalogue } from './catalogue.js';
import type { ChartFeature } from './s57.js';
import type { LatLon, Metres } from '@umami/core';

/**
 * Source of chart data at runtime.
 *
 * An interface rather than a concrete reader because the same application has
 * to get charts from genuinely different places: bundled tiles on a phone with
 * no network, a tile server in a shore facility, an in-memory fixture in a
 * unit test. The simulation and the renderer only ever see `ChartFeature`.
 *
 * This is also the seam that keeps S-57 from being load-bearing. S-101 is
 * coming and is a different encoding of similar content; when it arrives it
 * becomes another provider and another ingest path, not a rewrite.
 */
export interface ChartProvider {
  readonly id: string;
  /** Cells installed and available through this provider. */
  catalogue(): Promise<ChartCatalogue>;
  /** Features intersecting a bounding box, for drawing or for querying. */
  features(bounds: CellBounds, options?: FeatureQuery): Promise<ChartFeature[]>;
  /** Features at a position, for a chart-object pick. */
  featuresAt(position: LatLon, toleranceMetres?: Metres): Promise<ChartFeature[]>;
}

export interface FeatureQuery {
  /** Restrict to these object classes. */
  readonly objectClasses?: readonly string[];
  /** Display scale denominator, so SCAMIN can be honoured. */
  readonly scaleDenominator?: number;
  /** Cap the number of features returned; the closest are kept. */
  readonly limit?: number;
}

/** In-memory provider, for tests, fixtures and small hand-built areas. */
export class MemoryChartProvider implements ChartProvider {
  readonly id: string;

  constructor(
    private readonly cat: ChartCatalogue,
    private readonly featureList: readonly ChartFeature[],
    id = 'memory',
  ) {
    this.id = id;
  }

  async catalogue(): Promise<ChartCatalogue> {
    return this.cat;
  }

  async features(bounds: CellBounds, options: FeatureQuery = {}): Promise<ChartFeature[]> {
    const classes = options.objectClasses ? new Set(options.objectClasses) : undefined;
    const out = this.featureList.filter((f) => {
      if (classes && !classes.has(f.objectClass)) return false;
      if (
        options.scaleDenominator !== undefined &&
        f.minScale !== undefined &&
        options.scaleDenominator > f.minScale
      ) {
        return false;
      }
      return intersectsBounds(f, bounds);
    });
    return options.limit ? out.slice(0, options.limit) : out;
  }

  async featuresAt(position: LatLon, toleranceMetres = 50): Promise<ChartFeature[]> {
    // Degrees of latitude are ~111 km everywhere; longitude shrinks with
    // latitude, so the box is widened accordingly rather than assuming square.
    const dLat = toleranceMetres / 111_320;
    const dLon = dLat / Math.max(0.01, Math.cos((position.lat * Math.PI) / 180));
    return this.features({
      south: position.lat - dLat,
      north: position.lat + dLat,
      west: position.lon - dLon,
      east: position.lon + dLon,
    });
  }
}

function intersectsBounds(feature: ChartFeature, bounds: CellBounds): boolean {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  const visit = (coords: unknown): void => {
    if (Array.isArray(coords) && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      const lon = coords[0] as number;
      const lat = coords[1] as number;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      return;
    }
    if (Array.isArray(coords)) for (const c of coords) visit(c);
  };
  visit(feature.geometry.coordinates);

  return !(
    maxLon < bounds.west ||
    minLon > bounds.east ||
    maxLat < bounds.south ||
    minLat > bounds.north
  );
}

import { toDegrees } from '@umami/core';
import type { WorldObject } from '@umami/sim';
import type { ColourTable } from '@umami/s52';

/**
 * Vessel and target symbology as GeoJSON, following S-52 conventions.
 *
 * Three distinctions the display must make, because a mariner reads them
 * instantly and an algorithm depends on them:
 *
 *  - Own ship is drawn to scale when the zoom allows it, as an outline of the
 *    actual hull, not as a symbol. At close quarters the difference between a
 *    marker and a 300 m ship is the difference between clearing and not.
 *  - A target's heading line shows where the bow points; its velocity vector
 *    shows where it is going. In a current these differ, and conflating them
 *    is how crossing situations are misjudged.
 *  - A dead-reckoned AIS contact is drawn differently from one reporting now.
 *    Showing an extrapolated position with the same confidence as a fresh fix
 *    presents a guess as knowledge.
 */

export interface SymbolOptions {
  readonly colours: ColourTable;
  /** Length of the velocity vector, in minutes of travel. */
  readonly vectorMinutes: number;
  /** Metres per screen pixel, for deciding when to draw to scale. */
  readonly metresPerPixel: number;
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: unknown[];
}

const EARTH_METRES_PER_DEG_LAT = 111_320;

function offset(
  lat: number,
  lon: number,
  bearingRad: number,
  distanceMetres: number,
): [number, number] {
  const dNorth = distanceMetres * Math.cos(bearingRad);
  const dEast = distanceMetres * Math.sin(bearingRad);
  const dLat = dNorth / EARTH_METRES_PER_DEG_LAT;
  const dLon =
    dEast / (EARTH_METRES_PER_DEG_LAT * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));
  return [lon + dLon, lat + dLat];
}

/** Hull outline: a ship-shaped polygon of the vessel's real dimensions. */
function hullOutline(o: WorldObject): [number, number][] | undefined {
  const loa = o.dimensions.loa;
  const beam = o.dimensions.beam;
  if (!loa || !beam || o.heading === undefined) return undefined;

  const h = o.heading;
  const half = beam / 2;
  // Measured from the centre: stern square, parallel body, then a pointed bow.
  const shape: [number, number][] = [
    [-loa / 2, -half],
    [loa / 4, -half],
    [loa / 2, 0],
    [loa / 4, half],
    [-loa / 2, half],
    [-loa / 2, -half],
  ];
  return shape.map(([x, y]) => {
    const distance = Math.hypot(x, y);
    const angle = Math.atan2(y, x);
    return offset(o.position.lat, o.position.lon, h + angle, distance);
  });
}

export function buildVesselFeatures(
  objects: readonly WorldObject[],
  ownShipId: string | undefined,
  opts: SymbolOptions,
): {
  hulls: GeoJsonFeatureCollection;
  points: GeoJsonFeatureCollection;
  vectors: GeoJsonFeatureCollection;
} {
  const hulls: unknown[] = [];
  const points: unknown[] = [];
  const vectors: unknown[] = [];

  for (const o of objects) {
    const isOwn = o.id === ownShipId;
    const category = isOwn ? 'own' : o.source === 'ais' ? 'ais' : 'ghost';

    // Draw to scale only when the hull would be more than a few pixels long;
    // below that it is a smear and the symbol carries the information better.
    const loa = o.dimensions.loa ?? 0;
    const drawToScale = loa / Math.max(opts.metresPerPixel, 1e-6) > 12;
    const outline = drawToScale ? hullOutline(o) : undefined;

    if (outline) {
      hulls.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [outline] },
        properties: { category, extrapolated: Boolean(o.extrapolated) },
      });
    }

    points.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [o.position.lon, o.position.lat] },
      properties: {
        id: o.id,
        category,
        name: o.identity.name ?? '',
        mmsi: o.identity.mmsi ?? 0,
        headingDeg: o.heading === undefined ? 0 : toDegrees(o.heading),
        hasHeading: o.heading !== undefined,
        extrapolated: Boolean(o.extrapolated),
        drawnToScale: Boolean(outline),
      },
    });

    // Velocity vector: where the vessel will be after `vectorMinutes`.
    if (o.cog !== undefined && o.sog !== undefined && o.sog > 0.05) {
      const distance = o.sog * opts.vectorMinutes * 60;
      vectors.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [o.position.lon, o.position.lat],
            offset(o.position.lat, o.position.lon, o.cog, distance),
          ],
        },
        properties: { category, kind: 'velocity' },
      });
    }

    // Heading line: where the bow points. Distinct from the vector above.
    if (o.heading !== undefined) {
      const length = Math.max(loa * 1.5, opts.metresPerPixel * 30);
      vectors.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [o.position.lon, o.position.lat],
            offset(o.position.lat, o.position.lon, o.heading, length),
          ],
        },
        properties: { category, kind: 'heading' },
      });
    }
  }

  return {
    hulls: { type: 'FeatureCollection', features: hulls },
    points: { type: 'FeatureCollection', features: points },
    vectors: { type: 'FeatureCollection', features: vectors },
  };
}

/** Layer definitions for the vessel sources. Colours resolve from the palette. */
export function vesselLayers(colours: ColourTable): unknown[] {
  const byCategory = (own: string, ghost: string, ais: string): unknown[] => [
    'match',
    ['get', 'category'],
    'own',
    own,
    'ghost',
    ghost,
    ais,
  ];

  return [
    {
      id: 'vessel-hulls',
      type: 'fill',
      source: 'vessel-hulls',
      paint: {
        'fill-color': byCategory(colours.SHIPS, colours.CHMGF, colours.ARPAT),
        'fill-opacity': ['case', ['get', 'extrapolated'], 0.25, 0.55],
      },
    },
    {
      id: 'vessel-hull-outline',
      type: 'line',
      source: 'vessel-hulls',
      paint: {
        'line-color': byCategory(colours.SHIPS, colours.CHMGD, colours.ARPAT),
        'line-width': 1.5,
      },
    },
    // Heading line and velocity vector are separate layers rather than one
    // layer switching on a property, because `line-dasharray` is not a
    // data-driven property in MapLibre - an expression there is rejected at
    // style validation and the whole layer fails to add.
    {
      id: 'vessel-heading-lines',
      type: 'line',
      source: 'vessel-vectors',
      filter: ['==', ['get', 'kind'], 'heading'],
      paint: {
        'line-color': byCategory(colours.SHIPS, colours.CHMGD, colours.ARPAT),
        'line-width': 1.8,
      },
    },
    {
      id: 'vessel-velocity-vectors',
      type: 'line',
      source: 'vessel-vectors',
      filter: ['==', ['get', 'kind'], 'velocity'],
      paint: {
        'line-color': byCategory(colours.SHIPS, colours.CHMGD, colours.ARPAT),
        'line-width': 1.2,
        // Dashed, because a velocity vector is a projection rather than an
        // observation - it says where the vessel will be if nothing changes.
        'line-dasharray': [3, 2],
      },
    },
    {
      id: 'vessel-points',
      type: 'circle',
      source: 'vessel-points',
      // Hide the marker where the hull is already drawn to scale.
      filter: ['!', ['get', 'drawnToScale']],
      paint: {
        'circle-radius': ['case', ['==', ['get', 'category'], 'own'], 7, 5],
        'circle-color': byCategory(colours.SHIPS, colours.CHMGF, colours.ARPAT),
        'circle-stroke-color': byCategory(colours.SHIPS, colours.CHMGD, colours.ARPAT),
        'circle-stroke-width': 1.5,
        'circle-opacity': ['case', ['get', 'extrapolated'], 0.35, 1],
      },
    },
  ];
}

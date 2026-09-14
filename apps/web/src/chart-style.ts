import type { ColourScheme, ColourTable } from '@umami/s52';
import type { DisplaySettings } from '@umami/s52';

/**
 * Optional web basemap, for when no ENC covers the area of interest.
 *
 * 'none' is the default and the only one that works offline.
 */
export type Basemap = 'none' | 'osm' | 'osm-seamarks';

/**
 * Raster basemap sources.
 *
 * Both carry their attribution on the source itself, so MapLibre's attribution
 * control renders it whenever the layer is active. The OSM Foundation's tile
 * policy requires attribution that is visible and not hidden behind a toggle,
 * and this is the mechanism that guarantees it: the credit cannot be present
 * without the tiles, or the tiles without the credit.
 *
 * Neither is suitable for heavy or commercial use against these public
 * endpoints. The OSMF policy states plainly that commercial services "should be
 * especially aware that access may be withdrawn at any point", and forbids any
 * pre-emptive fetching of tiles the user is not actively viewing - which rules
 * out caching a region for offline use. Set VITE_BASEMAP_TILE_URL and
 * VITE_SEAMARK_TILE_URL to point at your own tile server, which is what the
 * policy recommends for anything beyond individual interactive use.
 */
const OSM_TILE_URL =
  import.meta.env.VITE_BASEMAP_TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const SEAMARK_TILE_URL =
  import.meta.env.VITE_SEAMARK_TILE_URL ?? 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png';

export const BASEMAP_SOURCES = {
  osm: {
    type: 'raster',
    tiles: [OSM_TILE_URL],
    tileSize: 256,
    maxzoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  seamarks: {
    type: 'raster',
    tiles: [SEAMARK_TILE_URL],
    tileSize: 256,
    maxzoom: 18,
    attribution: '&copy; <a href="https://www.openseamap.org/">OpenSeaMap</a> contributors',
  },
} as const;

/**
 * How hard to knock the basemap back, per colour scheme.
 *
 * Web map tiles are drawn for a bright screen in daylight and are far louder
 * than an ECDIS palette. Dropping them straight onto a night display would
 * undo the reason the night scheme exists - a bright chart destroys dark
 * adaptation for twenty minutes - so the raster is dimmed and desaturated to
 * sit behind the S-52 colours rather than compete with them.
 */
const BASEMAP_TONE: Readonly<
  Record<ColourScheme, { opacity: number; saturation: number; brightnessMax: number }>
> = {
  DAY_BRIGHT: { opacity: 0.85, saturation: -0.35, brightnessMax: 1 },
  DUSK: { opacity: 0.7, saturation: -0.55, brightnessMax: 0.6 },
  NIGHT: { opacity: 0.55, saturation: -0.75, brightnessMax: 0.35 },
};

/** Layers drawing the selected basemap. Empty when none is selected. */
export function basemapLayers(basemap: Basemap, scheme: ColourScheme): unknown[] {
  if (basemap === 'none') return [];
  const tone = BASEMAP_TONE[scheme];
  const paint = {
    'raster-opacity': tone.opacity,
    'raster-saturation': tone.saturation,
    'raster-brightness-max': tone.brightnessMax,
  };

  const layers: unknown[] = [
    { id: 'basemap-osm', type: 'raster', source: 'basemap-osm', paint },
  ];
  if (basemap === 'osm-seamarks') {
    // Seamarks are an overlay by design: transparent tiles carrying only the
    // marks, meant to sit on top of a base map.
    layers.push({
      id: 'basemap-seamarks',
      type: 'raster',
      source: 'basemap-seamarks',
      paint: { ...paint, 'raster-opacity': Math.min(1, tone.opacity + 0.15) },
    });
  }
  return layers;
}

/**
 * MapLibre style built from the active S-52 colour table.
 *
 * Every colour comes from the palette, never from a literal, so switching
 * between day, dusk and night - or swapping in the official Presentation
 * Library - restyles the whole chart with no other change.
 *
 * The background is NODTA - "no data" - and never a depth shade. Everything
 * not covered by a depth area is, by definition, water of unknown depth:
 * outside the cell, inside a coverage hole, or under a pier the survey did not
 * sound. Painting that DEPDW would state that unsurveyed water is deep water,
 * which is the same class of error as treating an unknown sounding as safe.
 * With no ENC at all the whole display is NODTA, which is the honest picture of
 * having no chart. When tiles are present, `encLayers` draws over it.
 */
export function baseChartStyle(colours: ColourTable): maplibregl.StyleSpecification {
  return {
    version: 8,
    // No `glyphs` or `sprite` entry at all - deliberately, and omitted rather
    // than set to undefined, which MapLibre rejects. Both point at remote
    // servers, and this application has to work with no network on a vessel;
    // a style that quietly needs one is a style that fails at sea. Text labels
    // therefore need a bundled glyph set before they can be added.
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': colours.NODTA },
      },
    ],
  } as unknown as maplibregl.StyleSpecification;
}

/**
 * Chart layers drawn from ingested ENC tiles.
 *
 * Ordered as S-52 requires: depth areas, then contours, then land, then
 * everything drawn on top of it. Layer order is not cosmetic - a depth area
 * painted over a coastline hides the thing the mariner most needs to see.
 */
export function encLayers(
  colours: ColourTable,
  settings: DisplaySettings,
  sourceId = 'enc',
): unknown[] {
  const depthFill: unknown[] = [
    'case',
    ['<', ['coalesce', ['get', 'DRVAL1'], -999], 0],
    colours.DEPIT,
    ['<', ['coalesce', ['get', 'DRVAL1'], 999], settings.shallowContour],
    colours.DEPVS,
    ['<', ['coalesce', ['get', 'DRVAL1'], 999], settings.safetyContour],
    settings.fourShades ? colours.DEPMS : colours.DEPVS,
    ['<', ['coalesce', ['get', 'DRVAL1'], 999], settings.deepContour],
    settings.fourShades ? colours.DEPMD : colours.DEPDW,
    colours.DEPDW,
  ];

  return [
    {
      id: 'enc-depare',
      type: 'fill',
      source: sourceId,
      'source-layer': 'enc',
      filter: ['==', ['get', 'OBJL_NAME'], 'DEPARE'],
      paint: { 'fill-color': depthFill },
    },
    {
      id: 'enc-depcnt',
      type: 'line',
      source: sourceId,
      'source-layer': 'enc',
      filter: ['==', ['get', 'OBJL_NAME'], 'DEPCNT'],
      paint: {
        // The safety contour is drawn heavier than every other contour: it is
        // the boundary between water the vessel may enter and water it may not.
        'line-color': [
          'case',
          ['==', ['get', 'VALDCO'], settings.safetyContour],
          colours.DEPSC,
          colours.DEPCN,
        ],
        'line-width': [
          'case',
          ['==', ['get', 'VALDCO'], settings.safetyContour],
          2.5,
          0.8,
        ],
      },
    },
    {
      id: 'enc-lndare',
      type: 'fill',
      source: sourceId,
      'source-layer': 'enc',
      filter: ['==', ['get', 'OBJL_NAME'], 'LNDARE'],
      paint: { 'fill-color': colours.LANDA, 'fill-outline-color': colours.CSTLN },
    },
    {
      id: 'enc-coalne',
      type: 'line',
      source: sourceId,
      'source-layer': 'enc',
      filter: ['==', ['get', 'OBJL_NAME'], 'COALNE'],
      paint: { 'line-color': colours.CSTLN, 'line-width': 1.4 },
    },
    {
      id: 'enc-dangers',
      type: 'circle',
      source: sourceId,
      'source-layer': 'enc',
      filter: ['in', ['get', 'OBJL_NAME'], ['literal', ['WRECKS', 'OBSTRN', 'UWTROC']]],
      paint: {
        'circle-radius': 5,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': colours.ISDNG,
        'circle-stroke-width': 2,
      },
    },
  ];
}

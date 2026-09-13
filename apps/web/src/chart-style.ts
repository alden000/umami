import type { ColourTable } from '@umami/s52';
import type { DisplaySettings } from '@umami/s52';

/**
 * MapLibre style built from the active S-52 colour table.
 *
 * Every colour comes from the palette, never from a literal, so switching
 * between day, dusk and night - or swapping in the official Presentation
 * Library - restyles the whole chart with no other change.
 *
 * With no ENC installed this produces an empty sea of the correct colour,
 * which is the honest representation of having no chart: the display does not
 * invent a coastline. When a catalogue is present, `encLayers` adds the layers
 * that draw it from the ingested tiles.
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
        paint: { 'background-color': colours.DEPDW },
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

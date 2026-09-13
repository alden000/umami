import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { FileSource, PMTiles, Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { WorldSnapshot } from '@umami/sim';
import type { ColourTable } from '@umami/s52';
import { DEFAULT_DISPLAY, type DisplaySettings } from '@umami/s52';
import { baseChartStyle, encLayers } from './chart-style.js';
import { buildVesselFeatures, vesselLayers } from './vessel-symbols.js';

export interface ChartViewProps {
  readonly snapshot: WorldSnapshot | undefined;
  readonly colours: ColourTable;
  readonly centre: { lat: number; lon: number };
  readonly vectorMinutes: number;
  readonly onMapClick?: (position: { lat: number; lon: number }) => void;
  /**
   * The chart to draw, or undefined for none.
   *
   * A string is the URL of a hosted tile archive. A `File` is one the operator
   * has opened from their own machine, which is read in place and never
   * uploaded - see `chartStyleUrl`. Undefined is a legitimate state rather than
   * a failure: with no chart the display is NODTA, not an invented coastline.
   */
  readonly chart?: string | File;
  readonly display?: DisplaySettings;
  /** Called with the chart's own bounds once it has been opened. */
  readonly onChartBounds?: (bounds: [number, number, number, number]) => void;
  /** Move the view to these bounds when they change. */
  readonly fitBounds?: [number, number, number, number];
}

// One protocol instance for the process: registering the handler twice throws,
// and local archives are registered against this instance by name.
let protocolInstance: Protocol | undefined;
function pmtilesProtocol(): Protocol {
  if (!protocolInstance) {
    protocolInstance = new Protocol();
    maplibregl.addProtocol('pmtiles', protocolInstance.tile);
  }
  return protocolInstance;
}

/**
 * Resolve a chart source to a style URL.
 *
 * A hosted archive is addressed directly and served by HTTP range request. A
 * local `File` is wrapped in a `FileSource`, which slices the bytes straight
 * out of the file on disk - nothing is uploaded, copied, or held in memory
 * whole. That distinction is the point rather than an optimisation: ENCs are
 * licensed data, and it means a publicly hosted build can display charts that
 * never leave the operator's machine.
 */
function chartStyleUrl(chart: string | File): { url: string; archive?: PMTiles } {
  const protocol = pmtilesProtocol();
  if (typeof chart === 'string') return { url: `pmtiles://${chart}` };
  const archive = new PMTiles(new FileSource(chart));
  protocol.add(archive);
  return { url: `pmtiles://${chart.name}`, archive };
}

const SOURCES = ['vessel-hulls', 'vessel-points', 'vessel-vectors'] as const;

/**
 * The chart display.
 *
 * MapLibre handles zoom, pan and the projection; this component owns only the
 * vessel overlay. Updates go through `setData` on existing GeoJSON sources
 * rather than by restyling, because the overlay changes several times a second
 * and rebuilding layers at that rate is what makes a map stutter on a tablet.
 */
export function ChartView({
  snapshot,
  colours,
  centre,
  vectorMinutes,
  onMapClick,
  chart,
  display = DEFAULT_DISPLAY,
  onChartBounds,
  fitBounds,
}: ChartViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const clickRef = useRef(onMapClick);
  clickRef.current = onMapClick;

  // Create the map once. Re-creating it on a prop change would reset the
  // operator's zoom and pan, which is unacceptable while something is developing.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    pmtilesProtocol();

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: baseChartStyle(colours),
      center: [centre.lon, centre.lat],
      zoom: 12,
      attributionControl: false,
      // North up by default, as a chart is read; rotation is available but not
      // the default, because a rotated chart without a clear indication of
      // orientation is a classic source of error.
      bearing: 0,
      pitch: 0,
    });

    map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-left');

    map.on('load', () => {
      for (const id of SOURCES) {
        map.addSource(id, {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
      }
      for (const layer of vesselLayers(colours)) {
        map.addLayer(layer as maplibregl.LayerSpecification);
      }
      readyRef.current = true;
    });

    map.on('click', (e) => {
      clickRef.current?.({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      readyRef.current = false;
    };
    // Intentionally empty: the map is created once and mutated thereafter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restyle in place when the colour scheme or display settings change.
  //
  // The chart layers have to be re-applied here as well as the vessel ones.
  // Leaving them out is not a subtle fault: the chart stays in day colours
  // while the vessels and chrome go dark, which is worse than never having
  // offered a night scheme - it destroys dark adaptation while looking as
  // though the setting was honoured.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setPaintProperty('background', 'background-color', colours.NODTA);

    const restyle = (layers: unknown[]): void => {
      for (const layer of layers) {
        const spec = layer as { id: string; paint?: Record<string, unknown> };
        if (!spec.paint || !map.getLayer(spec.id)) continue;
        for (const [property, value] of Object.entries(spec.paint)) {
          map.setPaintProperty(spec.id, property, value as never);
        }
      }
    };

    if (chart) restyle(encLayers(colours, display));
    restyle(vesselLayers(colours));
  }, [colours, display, chart]);

  // Attach, replace or remove the chart. Separate from map creation because a
  // chart can be opened at any time, and separate from restyling because
  // swapping the archive means rebuilding the source, not repainting layers.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    const layerIds = encLayers(colours, display).map((l) => (l as { id: string }).id);
    for (const id of layerIds) if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource('enc')) map.removeSource('enc');
    if (!chart) return;

    const { url, archive } = chartStyleUrl(chart);
    map.addSource('enc', { type: 'vector', url });

    // Insert beneath the vessel overlay: a depth area painted over own ship is
    // not a cosmetic problem.
    const firstVesselLayer = vesselLayers(colours)[0] as { id: string } | undefined;
    const before = firstVesselLayer && map.getLayer(firstVesselLayer.id)
      ? firstVesselLayer.id
      : undefined;
    for (const layer of encLayers(colours, display)) {
      map.addLayer(layer as maplibregl.LayerSpecification, before);
    }

    // Move to the chart once it is open. Loading a chart and being left looking
    // at empty water on the other side of the world reads as a failure.
    if (archive && onChartBounds) {
      void archive
        .getHeader()
        .then((h) => onChartBounds([h.minLon, h.minLat, h.maxLon, h.maxLat]))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, colours, display]);

  // Move to a newly opened chart. Deliberately not part of the chart effect:
  // re-fitting on every restyle would fight the operator for control of the
  // view while they are trying to look at something.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitBounds) return;
    const [west, south, east, north] = fitBounds;
    if (![west, south, east, north].every(Number.isFinite)) return;
    map.fitBounds(
      [
        [west, south],
        [east, north],
      ],
      { padding: 40, duration: 600 },
    );
  }, [fitBounds]);

  // Push new vessel positions. Runs at the display rate, not the sim rate.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !snapshot) return;

    // Metres per pixel at the current latitude and zoom, so the overlay can
    // decide when a hull is large enough to draw to scale.
    const metresPerPixel =
      (156543.03392 * Math.cos((map.getCenter().lat * Math.PI) / 180)) /
      Math.pow(2, map.getZoom());

    const { hulls, points, vectors } = buildVesselFeatures(
      snapshot.objects,
      snapshot.ownShipId,
      { colours, vectorMinutes, metresPerPixel },
    );

    (map.getSource('vessel-hulls') as maplibregl.GeoJSONSource | undefined)?.setData(
      hulls as never,
    );
    (map.getSource('vessel-points') as maplibregl.GeoJSONSource | undefined)?.setData(
      points as never,
    );
    (map.getSource('vessel-vectors') as maplibregl.GeoJSONSource | undefined)?.setData(
      vectors as never,
    );
  }, [snapshot, colours, vectorMinutes]);

  return <div ref={containerRef} className="chart" />;
}

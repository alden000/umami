import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
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
   * URL of an ingested chart tile archive, or undefined for no chart.
   *
   * Undefined is a legitimate state, not a failure: with no ENC installed the
   * display shows open water of the correct depth colour rather than inventing
   * a coastline.
   */
  readonly chartUrl?: string;
  readonly display?: DisplaySettings;
}

// PMTiles serves range requests straight from a static file, so the protocol
// is registered once for the process rather than per map instance. Registering
// it twice throws.
let pmtilesRegistered = false;
function registerPmtiles(): void {
  if (pmtilesRegistered) return;
  maplibregl.addProtocol('pmtiles', new Protocol().tile);
  pmtilesRegistered = true;
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
  chartUrl,
  display = DEFAULT_DISPLAY,
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
    registerPmtiles();

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
      // Chart first, so every vessel layer added below draws on top of it.
      if (chartUrl) {
        map.addSource('enc', { type: 'vector', url: `pmtiles://${chartUrl}` });
        for (const layer of encLayers(colours, display)) {
          map.addLayer(layer as maplibregl.LayerSpecification);
        }
      }
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

    if (chartUrl) restyle(encLayers(colours, display));
    restyle(vesselLayers(colours));
  }, [colours, display, chartUrl]);

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

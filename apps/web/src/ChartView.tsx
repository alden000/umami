import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { WorldSnapshot } from '@umami/sim';
import type { ColourTable } from '@umami/s52';
import { baseChartStyle } from './chart-style.js';
import { buildVesselFeatures, vesselLayers } from './vessel-symbols.js';

export interface ChartViewProps {
  readonly snapshot: WorldSnapshot | undefined;
  readonly colours: ColourTable;
  readonly centre: { lat: number; lon: number };
  readonly vectorMinutes: number;
  readonly onMapClick?: (position: { lat: number; lon: number }) => void;
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

  // Restyle in place when the colour scheme changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setPaintProperty('background', 'background-color', colours.DEPDW);
    for (const layer of vesselLayers(colours)) {
      const spec = layer as { id: string; paint: Record<string, unknown> };
      if (!map.getLayer(spec.id)) continue;
      for (const [property, value] of Object.entries(spec.paint)) {
        map.setPaintProperty(spec.id, property, value as never);
      }
    }
  }, [colours]);

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

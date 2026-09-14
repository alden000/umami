import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { FileSource, PMTiles, Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { WorldSnapshot } from '@umami/sim';
import type { ColourScheme, ColourTable } from '@umami/s52';
import { DEFAULT_DISPLAY, type DisplaySettings } from '@umami/s52';
import { BASEMAP_SOURCES, baseChartStyle, basemapLayers, encLayers, type Basemap } from './chart-style.js';
import { allVesselLayers, buildVesselFeatures } from './vessel-symbols.js';

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
  /**
   * Called when the map itself reports a problem, typically a tile that would
   * not load.
   *
   * MapLibre swallows these unless something listens: a blocked or
   * rate-limited tile service simply stops drawing, and the map looks frozen
   * with nothing in the console to say why. The same principle as everywhere
   * else here - a failure that hides is worse than one that is loud.
   */
  readonly onMapError?: (message: string) => void;
  /**
   * Web basemap drawn beneath the chart, for areas no ENC covers.
   *
   * Deliberately beneath: where an ENC has coverage it wins outright, because
   * a surveyed chart and a crowd-sourced coastline are not interchangeable and
   * the one with depths must not be obscured by the one without.
   */
  readonly basemap?: Basemap;
  /** Needed to tone the basemap to the active scheme. */
  readonly scheme?: ColourScheme;
  /**
   * Called as the operator pans or zooms, with the visible extent.
   *
   * Fires freely; consumers that talk to a rate-limited service must throttle
   * for themselves rather than assume this is quiet.
   */
  readonly onViewChange?: (bounds: {
    south: number;
    west: number;
    north: number;
    east: number;
  }) => void;
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

/**
 * Overlay sources, split by how fast the data behind them actually changes.
 *
 * Simulated vessels are integrated at 10 Hz and must move smoothly. AIS
 * contacts report every few seconds at best, and there can be hundreds of
 * them. Feeding both through one source means re-parsing every contact at the
 * simulation's rate, and MapLibre parses GeoJSON on the same worker pool it
 * uses to build tiles - so the overlay starves the chart. Measured with 250
 * contacts: panning loaded 0-4 tiles against 16 with the overlay quiet.
 *
 * Splitting them lets each update at the rate its data warrants.
 */
const SIM_SOURCES = ['sim-hulls', 'sim-points', 'sim-vectors'] as const;
const AIS_SOURCES = ['ais-hulls', 'ais-points', 'ais-vectors'] as const;
const SOURCES = [...SIM_SOURCES, ...AIS_SOURCES] as const;

/** AIS contacts are redrawn at most this often. */
const AIS_REDRAW_INTERVAL_MS = 1000;

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
  basemap = 'none',
  scheme = 'DAY_BRIGHT',
  onViewChange,
  onMapError,
}: ChartViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const readyRef = useRef(false);
  const lastAisDrawRef = useRef(0);
  const clickRef = useRef(onMapClick);
  clickRef.current = onMapClick;
  const viewRef = useRef(onViewChange);
  viewRef.current = onViewChange;
  const errorRef = useRef(onMapError);
  errorRef.current = onMapError;

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
      // Attribution comes from whichever sources are active. It must not be
      // suppressed: the OSM tile policy requires the credit to be visible and
      // not hidden behind a control, so it is driven by the source definitions
      // rather than by anything the operator can switch off.
      attributionControl: { compact: true },
      // North up by default, as a chart is read; rotation is available but not
      // the default, because a rotated chart without a clear indication of
      // orientation is a classic source of error.
      bearing: 0,
      pitch: 0,
    });

    map.on('error', (e) => {
      const err = e.error as (Error & { status?: number }) | undefined;
      const source = (e as { sourceId?: string }).sourceId;
      const status = err?.status ? ` (HTTP ${err.status})` : '';
      const where = source ? `${source}: ` : '';
      errorRef.current?.(`${where}${err?.message ?? 'unknown error'}${status}`);
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
      for (const layer of allVesselLayers(colours)) {
        map.addLayer(layer as maplibregl.LayerSpecification);
      }
      readyRef.current = true;
    });

    map.on('click', (e) => {
      clickRef.current?.({ lat: e.lngLat.lat, lon: e.lngLat.lng });
    });

    const reportView = (): void => {
      const b = map.getBounds();
      viewRef.current?.({
        south: b.getSouth(),
        west: b.getWest(),
        north: b.getNorth(),
        east: b.getEast(),
      });
    };

    // moveend rather than move: the extent is only interesting once the
    // operator has stopped, and every consumer of it is expensive.
    map.on('moveend', reportView);
    // And once on load. Without this the first report only arrives after the
    // operator happens to pan, so anything that needs the current extent - live
    // AIS asks for exactly the area being viewed - silently has nothing to work
    // with until then.
    map.on('load', reportView);

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
    restyle(allVesselLayers(colours));
  }, [colours, display, chart]);

  // Attach, replace or remove the basemap. Runs before the chart effect below,
  // and both insert relative to named layers rather than appending, so the
  // stack stays basemap / chart / vessels however they are toggled.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;

    for (const id of ['basemap-osm', 'basemap-seamarks']) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
    if (basemap === 'none') return;

    map.addSource('basemap-osm', BASEMAP_SOURCES.osm as never);
    if (basemap === 'osm-seamarks') {
      map.addSource('basemap-seamarks', BASEMAP_SOURCES.seamarks as never);
    }

    // Beneath everything: the chart if one is open, otherwise the vessels.
    const encFirst = encLayers(colours, display)[0] as { id: string } | undefined;
    const vesselFirst = allVesselLayers(colours)[0] as { id: string } | undefined;
    const before =
      encFirst && map.getLayer(encFirst.id)
        ? encFirst.id
        : vesselFirst && map.getLayer(vesselFirst.id)
          ? vesselFirst.id
          : undefined;

    for (const layer of basemapLayers(basemap, scheme)) {
      map.addLayer(layer as maplibregl.LayerSpecification, before);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap, scheme, chart]);

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
    const firstVesselLayer = allVesselLayers(colours)[0] as { id: string } | undefined;
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

  // Push new positions. Simulated vessels every frame the snapshot changes;
  // AIS contacts at most once a second, because that is as often as they
  // actually change and redrawing hundreds of them faster is what stops the
  // chart loading tiles.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current || !snapshot) return;

    // Metres per pixel at the current latitude and zoom, so the overlay can
    // decide when a hull is large enough to draw to scale.
    const metresPerPixel =
      (156543.03392 * Math.cos((map.getCenter().lat * Math.PI) / 180)) /
      Math.pow(2, map.getZoom());
    const opts = { colours, vectorMinutes, metresPerPixel };

    const setData = (id: string, data: unknown): void => {
      (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(data as never);
    };

    const simulated = snapshot.objects.filter((o) => o.source !== 'ais');
    const sim = buildVesselFeatures(simulated, snapshot.ownShipId, opts);
    setData('sim-hulls', sim.hulls);
    setData('sim-points', sim.points);
    setData('sim-vectors', sim.vectors);

    const now = performance.now();
    if (now - lastAisDrawRef.current < AIS_REDRAW_INTERVAL_MS) return;
    lastAisDrawRef.current = now;

    const contacts = snapshot.objects.filter((o) => o.source === 'ais');
    const ais = buildVesselFeatures(contacts, snapshot.ownShipId, opts);
    setData('ais-hulls', ais.hulls);
    setData('ais-points', ais.points);
    setData('ais-vectors', ais.vectors);
  }, [snapshot, colours, vectorMinutes]);

  return <div ref={containerRef} className="chart" />;
}

import { useCallback, useMemo, useRef, useState } from 'react';
import { toDegrees, toKnots } from '@umami/core';
import { BUNDLED_COLOUR_TABLES, type ColourScheme } from '@umami/s52';
import type { VesselClassId } from '@umami/dynamics';
import { assessRisk, type ScenarioDefinition } from '@umami/sim';
import { ChartView } from './ChartView.js';
import type { Basemap } from './chart-style.js';
import { useSimulation } from './useSimulation.js';
import { useAisStream } from './useAisStream.js';
import type { AisBoundingBox } from '@umami/ais';

const SCENARIO: ScenarioDefinition = {
  name: 'Singapore Strait',
  origin: { lat: 1.2, lon: 103.8 },
  startTime: '2026-01-01T02:00:00Z',
  stepSeconds: 0.1,
  environment: { windFromDegrees: 45, windSpeedKnots: 12 },
  ownShip: {
    id: 'usv',
    name: 'USV ALPHA',
    vesselClass: 'usv-waterjet',
    position: { lat: 1.2, lon: 103.78 },
    headingDegrees: 90,
    speedKnots: 12,
    control: { mode: 'course-speed', courseDegrees: 90, speedKnots: 14 },
  },
  ghosts: [
    {
      id: 'crossing',
      name: 'MV CROSSING',
      mmsi: 563000001,
      vesselClass: 'container-feeder',
      position: { lat: 1.16, lon: 103.83 },
      headingDegrees: 340,
      speedKnots: 14,
      control: { mode: 'course-speed', courseDegrees: 340, speedKnots: 14 },
    },
  ],
};

/**
 * The area live AIS is subscribed to.
 *
 * Fixed rather than following the map view. Two reasons it is better fixed.
 * The picture stays the same whatever the operator is looking at, so zooming in
 * on one vessel does not quietly discard the traffic around it and zooming out
 * does not flood the feed with a region nobody is watching. And the provider
 * caps subscription updates at one per second, so a bounding box driven by pan
 * and zoom is a stream of updates against a rate limit for no gain.
 *
 * Corners are the Singapore Strait and its approaches: north-west 1.5824335 N
 * 103.2699253 E, south-east 1.0733847 N 104.8299920 E - about 93 nm east-west
 * by 31 nm north-south, covering the westbound and eastbound lanes, the Johor
 * Strait and the eastern anchorages.
 *
 * The box is a request to the provider, not a filter applied to what comes
 * back: everything received is accepted and processed, so a contact the
 * provider sends from just outside the edge is kept rather than second-guessed.
 */
const AIS_WINDOW: AisBoundingBox = {
  north: 1.5824335,
  west: 103.2699253,
  south: 1.0733847,
  east: 104.8299920,
};

const GHOST_CLASSES: VesselClassId[] = [
  'container-large',
  'container-feeder',
  'vlcc',
  'ropax-ferry',
  'fishing-vessel',
  'harbour-tug',
  'patrol-boat',
];

const TIME_SCALES = [1, 2, 5, 10, 30, 60];

/**
 * Chart archive shipped with the deployment, if any.
 *
 * Set VITE_CHART_URL at build time to bundle one. Left unset - which is the
 * right default for a public deployment, since ENCs are licensed data - the
 * operator opens a chart from their own machine instead.
 */
const CHART_URL: string | undefined = import.meta.env.VITE_CHART_URL;

export function App(): JSX.Element {
  const [scheme, setScheme] = useState<ColourScheme>('DAY_BRIGHT');
  const [ghostClass, setGhostClass] = useState<VesselClassId>('container-feeder');
  const [dropMode, setDropMode] = useState(false);
  const [vectorMinutes, setVectorMinutes] = useState(6);

  const [basemap, setBasemap] = useState<Basemap>('none');
  const [localChart, setLocalChart] = useState<File | undefined>(undefined);
  const [chartBounds, setChartBounds] = useState<[number, number, number, number] | undefined>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const sim = useSimulation(SCENARIO);
  const ais = useAisStream(sim.world);
  const [showAisPanel, setShowAisPanel] = useState(false);
  const [mapError, setMapError] = useState<{ message: string; count: number } | undefined>();
  const colours = BUNDLED_COLOUR_TABLES[scheme];

  // A locally opened chart wins over any bundled one: it is the more
  // deliberate act of the two.
  const chart: string | File | undefined = localChart ?? CHART_URL;

  const openChart = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setLocalChart(file);
      setChartBounds(undefined);
    }
  }, []);

  const own = sim.snapshot?.objects.find((o) => o.id === sim.snapshot?.ownShipId);

  // Closest contact and whether it is developing into a close-quarters
  // situation. Recomputed only when the snapshot changes, not on every render.
  const nearest = useMemo(() => {
    if (!sim.snapshot || !own || own.cog === undefined || own.sog === undefined) return undefined;
    const others = sim.snapshot.objects.filter(
      (o) => o.id !== own.id && o.cog !== undefined && o.sog !== undefined,
    );
    if (others.length === 0) return undefined;
    return others
      .map((o) => ({
        name: o.identity.name ?? o.id,
        risk: assessRisk(
          { position: own.position, cog: own.cog!, sog: own.sog! },
          { position: o.position, cog: o.cog!, sog: o.sog! },
        ),
      }))
      .sort((a, b) => a.risk.range - b.risk.range)[0];
  }, [sim.snapshot, own]);

  return (
    <div className="app" data-scheme={scheme}>
      <ChartView
        snapshot={sim.snapshot}
        colours={colours}
        centre={SCENARIO.origin}
        vectorMinutes={vectorMinutes}
        chart={chart}
        fitBounds={chartBounds}
        onChartBounds={setChartBounds}
        basemap={basemap}
        scheme={scheme}
        onMapError={(message) =>
          setMapError((prev) =>
            prev?.message === message
              ? { message, count: prev.count + 1 }
              : { message, count: 1 },
          )
        }
        onMapClick={(position) => {
          if (!dropMode) return;
          sim.spawnGhost(position, ghostClass);
          setDropMode(false);
        }}
      />

      <div className="panel panel-top">
        <div className="readout">
          <span className="label">OWN</span>
          <span className="value">{own?.identity.name ?? '-'}</span>
          <span className="label">HDG</span>
          <span className="value">
            {own?.heading === undefined ? '---' : pad3(toDegrees(own.heading))}&deg;
          </span>
          <span className="label">COG</span>
          <span className="value">
            {own?.cog === undefined ? '---' : pad3(toDegrees(own.cog))}&deg;
          </span>
          <span className="label">SOG</span>
          <span className="value">
            {own?.sog === undefined ? '--.-' : toKnots(own.sog).toFixed(1)} kn
          </span>
          <span className="label">TIME</span>
          <span className="value">{formatTime(sim.snapshot?.simTime ?? 0)}</span>
        </div>
        {ais.connected && (
          <div className="ais-status">
            AIS {ais.status.state} &middot; {ais.contactCount} contacts &middot;{' '}
            {ais.status.messageCount} messages
            {ais.status.detail ? ` · ${ais.status.detail}` : ''}
          </div>
        )}
        {mapError && (
          <div className="warning" data-testid="map-error">
            Chart layer: {mapError.message}
            {mapError.count > 1 ? ` (\u00d7${mapError.count})` : ''}
            <button className="link" onClick={() => setMapError(undefined)}>
              dismiss
            </button>
          </div>
        )}
        {basemap !== 'none' && (
          <div className="warning">
            Web basemap active &mdash; coastline only, <strong>no depths</strong>, no
            soundings, no safety contour. Not a navigational chart.
          </div>
        )}
        {nearest && (
          <div className={`risk ${nearest.risk.dangerous ? 'risk-danger' : ''}`}>
            {nearest.name}: {(nearest.risk.range / 1852).toFixed(2)} nm &middot; CPA{' '}
            {(nearest.risk.cpa / 1852).toFixed(2)} nm &middot; TCPA{' '}
            {nearest.risk.tcpa > 0 ? `${(nearest.risk.tcpa / 60).toFixed(1)} min` : '-'} &middot;{' '}
            {nearest.risk.encounter}
          </div>
        )}
      </div>

      {showAisPanel && (
        <div className="panel panel-ais">
          <div className="ais-title">Live AIS &mdash; aisstream.io</div>
          <p className="ais-note">
            Your own API key, kept in this browser only. It is never sent anywhere
            but aisstream.io, and never built into this site &mdash; a key baked
            into a public page is readable by every visitor. Get one free at{' '}
            <a href="https://aisstream.io/" target="_blank" rel="noreferrer">
              aisstream.io
            </a>
            .
          </p>
          <div className="group">
            <input
              type="password"
              value={ais.apiKey}
              onChange={(e) => ais.setApiKey(e.target.value)}
              placeholder="API key"
              autoComplete="off"
              spellCheck={false}
              data-testid="ais-key"
              style={{ minWidth: 220 }}
            />
            {ais.connected ? (
              <button onClick={ais.disconnect}>Disconnect</button>
            ) : (
              <button
                onClick={() => ais.connect(AIS_WINDOW)}
                disabled={!ais.apiKey}
                data-testid="ais-connect"
              >
                Connect
              </button>
            )}
            <button onClick={() => setShowAisPanel(false)} title="Close">
              &times;
            </button>
          </div>
          <p className="ais-note">
            Fixed window &mdash; {formatCorner(AIS_WINDOW.north, AIS_WINDOW.west)} to{' '}
            {formatCorner(AIS_WINDOW.south, AIS_WINDOW.east)}. The picture does
            not change as you pan or zoom. Contacts are observations &mdash;
            dead-reckoned between reports, and dropped when they go quiet, never
            extrapolated indefinitely.
          </p>
        </div>
      )}

      <div className="panel panel-bottom">
        <div className="group">
          <button onClick={sim.togglePause} className={sim.paused ? 'active' : ''}>
            {sim.paused ? 'Run' : 'Pause'}
          </button>
          {TIME_SCALES.map((scale) => (
            <button
              key={scale}
              onClick={() => sim.setTimeScale(scale)}
              className={!sim.paused && sim.timeScale === scale ? 'active' : ''}
            >
              {scale}&times;
            </button>
          ))}
        </div>

        <div className="group">
          <label htmlFor="scheme">Display</label>
          <select
            id="scheme"
            value={scheme}
            onChange={(e) => setScheme(e.target.value as ColourScheme)}
          >
            <option value="DAY_BRIGHT">Day</option>
            <option value="DUSK">Dusk</option>
            <option value="NIGHT">Night</option>
          </select>
        </div>

        <div className="group">
          <label htmlFor="vector">Vector</label>
          <select
            id="vector"
            value={vectorMinutes}
            onChange={(e) => setVectorMinutes(Number(e.target.value))}
          >
            {[3, 6, 12, 20].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </div>

        <div className="group">
          <button
            onClick={() => setShowAisPanel((v) => !v)}
            className={ais.connected ? 'active' : ''}
            title="Live AIS from aisstream.io"
          >
            {ais.connected ? `AIS \u25cf ${ais.contactCount}` : 'Live AIS\u2026'}
          </button>
        </div>

        <div className="group">
          <label htmlFor="basemap">Basemap</label>
          <select
            id="basemap"
            value={basemap}
            onChange={(e) => setBasemap(e.target.value as Basemap)}
            title="Web tiles drawn beneath the chart, for areas no ENC covers. Requires a network connection."
          >
            <option value="none">None</option>
            <option value="osm">OpenStreetMap</option>
            <option value="osm-seamarks">OSM + seamarks</option>
          </select>
        </div>

        <div className="group">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pmtiles"
            onChange={openChart}
            hidden
            data-testid="chart-input"
          />
          <button onClick={() => fileInputRef.current?.click()} title="Open a charts.pmtiles built by tools/enc-ingest">
            {localChart ? `Chart: ${localChart.name}` : 'Open chart\u2026'}
          </button>
          {localChart && (
            <button
              onClick={() => {
                setLocalChart(undefined);
                setChartBounds(undefined);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              title="Close the chart"
            >
              &times;
            </button>
          )}
        </div>

        <div className="group">
          <select
            value={ghostClass}
            onChange={(e) => setGhostClass(e.target.value as VesselClassId)}
          >
            {GHOST_CLASSES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button onClick={() => setDropMode((v) => !v)} className={dropMode ? 'active' : ''}>
            {dropMode ? 'Tap chart…' : 'Drop target'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One corner of a bounding box, as a mariner would write it. */
function formatCorner(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}\u00b0${ns} ${Math.abs(lon).toFixed(4)}\u00b0${ew}`;
}

function pad3(deg: number): string {
  return String(Math.round(((deg % 360) + 360) % 360)).padStart(3, '0');
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

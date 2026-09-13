import { useMemo, useState } from 'react';
import { toDegrees, toKnots } from '@umami/core';
import { BUNDLED_COLOUR_TABLES, type ColourScheme } from '@umami/s52';
import type { VesselClassId } from '@umami/dynamics';
import { assessRisk, type ScenarioDefinition } from '@umami/sim';
import { ChartView } from './ChartView.js';
import { useSimulation } from './useSimulation.js';

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
 * Ingested chart archive, if one has been installed.
 *
 * Configured rather than assumed: with no ENC the display is open water of the
 * correct depth colour, which is the honest picture of having no chart.
 */
const CHART_URL: string | undefined = import.meta.env.VITE_CHART_URL;

export function App(): JSX.Element {
  const [scheme, setScheme] = useState<ColourScheme>('DAY_BRIGHT');
  const [ghostClass, setGhostClass] = useState<VesselClassId>('container-feeder');
  const [dropMode, setDropMode] = useState(false);
  const [vectorMinutes, setVectorMinutes] = useState(6);

  const sim = useSimulation(SCENARIO);
  const colours = BUNDLED_COLOUR_TABLES[scheme];

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
        chartUrl={CHART_URL}
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
        {nearest && (
          <div className={`risk ${nearest.risk.dangerous ? 'risk-danger' : ''}`}>
            {nearest.name}: {(nearest.risk.range / 1852).toFixed(2)} nm &middot; CPA{' '}
            {(nearest.risk.cpa / 1852).toFixed(2)} nm &middot; TCPA{' '}
            {nearest.risk.tcpa > 0 ? `${(nearest.risk.tcpa / 60).toFixed(1)} min` : '-'} &middot;{' '}
            {nearest.risk.encounter}
          </div>
        )}
      </div>

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

function pad3(deg: number): string {
  return String(Math.round(((deg % 360) + 360) % 360)).padStart(3, '0');
}

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

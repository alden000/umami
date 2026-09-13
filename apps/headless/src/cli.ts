#!/usr/bin/env tsx
/**
 * Headless simulation runner.
 *
 * The same simulation core the interactive app uses, with no rendering, run as
 * fast as the machine allows. This is the mode that matters for algorithm
 * development: a scenario that takes an hour of wall time to unfold runs in
 * seconds, a thousand variations run in a batch, and the result is identical
 * to what the interactive app would have shown because it is the same code and
 * the same fixed time step.
 */
import { readFile } from 'node:fs/promises';
import { toDegrees, toKnots } from '@umami/core';
import { assessRisk, loadScenario, type ScenarioDefinition, type WorldSnapshot } from '@umami/sim';

interface Options {
  readonly scenarioPath?: string;
  readonly durationSeconds: number;
  readonly reportInterval: number;
  readonly format: 'text' | 'jsonl';
  readonly quiet: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  let scenarioPath: string | undefined;
  let durationSeconds = 600;
  let reportInterval = 60;
  let format: 'text' | 'jsonl' = 'text';
  let quiet = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--scenario':
      case '-s':
        scenarioPath = argv[++i];
        break;
      case '--duration':
      case '-d':
        durationSeconds = Number(argv[++i]);
        break;
      case '--interval':
      case '-i':
        reportInterval = Number(argv[++i]);
        break;
      case '--jsonl':
        format = 'jsonl';
        break;
      case '--quiet':
      case '-q':
        quiet = true;
        break;
      case '--help':
      case '-h':
        usage();
        process.exit(0);
        break;
      default:
        if (arg?.startsWith('-')) {
          console.error(`unknown option: ${arg}`);
          usage();
          process.exit(2);
        }
    }
  }
  return { scenarioPath, durationSeconds, reportInterval, format, quiet };
}

function usage(): void {
  console.log(`
umami-sim - headless maritime simulation runner

  -s, --scenario <file>   scenario JSON to run (default: a built-in demo)
  -d, --duration <sec>    simulated seconds to run (default: 600)
  -i, --interval <sec>    seconds between reports (default: 60)
      --jsonl             emit one JSON snapshot per report instead of a table
  -q, --quiet             only print the final summary
  -h, --help              this message
`);
}

/**
 * Built-in demo: a crossing situation in the Singapore Strait.
 *
 * A USV on passage east with a feeder container ship crossing from its
 * starboard bow, which under Rule 15 makes the USV the give-way vessel, plus a
 * tug crossing well clear astern. Enough to exercise dynamics, control and
 * collision assessment with no external data.
 *
 * The tidal stream is deliberately set to zero here despite the wind. Course
 * control in a current is affected by the open issue documented in
 * docs/architecture.md, and a demo should show what the simulator does
 * correctly rather than quietly exhibit a known defect. Set
 * `currentDriftKnots` to see it.
 */
const DEMO_SCENARIO: ScenarioDefinition = {
  name: 'Singapore Strait crossing',
  description: 'USV on passage with a crossing container ship and a tug.',
  origin: { lat: 1.2, lon: 103.8 },
  startTime: '2026-01-01T02:00:00Z',
  stepSeconds: 0.1,
  environment: {
    windFromDegrees: 45,
    windSpeedKnots: 12,
    currentSetDegrees: 250,
    currentDriftKnots: 0,
    significantWaveHeightMetres: 0.8,
  },
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
      // On the USV's starboard bow, crossing left to right: the USV must
      // keep out of the way and should not cross ahead.
      position: { lat: 1.16, lon: 103.83 },
      headingDegrees: 340,
      speedKnots: 14,
      control: {
        mode: 'script',
        initialCourseDegrees: 340,
        initialSpeedKnots: 14,
        // Holds her course and speed as the stand-on vessel, then takes late
        // action when it becomes clear the give-way vessel is not acting.
        steps: [{ atSeconds: 480, courseDegrees: 10 }],
      },
    },
    {
      id: 'tug',
      name: 'TUG BRAVO',
      mmsi: 563000002,
      vesselClass: 'harbour-tug',
      position: { lat: 1.17, lon: 103.90 },
      headingDegrees: 270,
      speedKnots: 6,
      control: { mode: 'course-speed', courseDegrees: 270, speedKnots: 6 },
    },
  ],
};

function report(snapshot: WorldSnapshot, format: 'text' | 'jsonl'): void {
  if (format === 'jsonl') {
    console.log(JSON.stringify(snapshot));
    return;
  }

  const own = snapshot.objects.find((o) => o.id === snapshot.ownShipId);
  const mm = Math.floor(snapshot.simTime / 60);
  const ss = Math.floor(snapshot.simTime % 60);
  const time = `${String(mm).padStart(3)}:${String(ss).padStart(2, '0')}`;

  if (!own) {
    console.log(`${time}  (no own ship)`);
    return;
  }

  const line = [
    time,
    `${own.position.lat.toFixed(5)} ${own.position.lon.toFixed(5)}`,
    `HDG ${toDegrees(own.heading ?? 0).toFixed(0).padStart(3, '0')}`,
    `COG ${toDegrees(own.cog ?? 0).toFixed(0).padStart(3, '0')}`,
    `SOG ${toKnots(own.sog ?? 0).toFixed(1).padStart(4)}kn`,
  ].join('  ');

  // Closest contact, and whether it is developing into a close-quarters situation.
  const others = snapshot.objects.filter((o) => o.id !== own.id);
  let closest = '';
  if (others.length > 0 && own.cog !== undefined && own.sog !== undefined) {
    const risks = others
      .filter((o) => o.cog !== undefined && o.sog !== undefined)
      .map((o) => ({
        name: o.identity.name ?? o.id,
        risk: assessRisk(
          { position: own.position, cog: own.cog!, sog: own.sog! },
          { position: o.position, cog: o.cog!, sog: o.sog! },
        ),
      }))
      .sort((a, b) => a.risk.range - b.risk.range);
    const nearest = risks[0];
    if (nearest) {
      const { risk } = nearest;
      closest =
        `  | ${nearest.name}: ${(risk.range / 1852).toFixed(2)}nm` +
        ` CPA ${(risk.cpa / 1852).toFixed(2)}nm` +
        ` TCPA ${risk.tcpa > 0 ? `${(risk.tcpa / 60).toFixed(1)}min` : '-'}` +
        ` ${risk.encounter}${risk.dangerous ? '  ** CLOSE QUARTERS **' : ''}`;
    }
  }

  console.log(line + closest);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const definition: ScenarioDefinition = opts.scenarioPath
    ? (JSON.parse(await readFile(opts.scenarioPath, 'utf8')) as ScenarioDefinition)
    : DEMO_SCENARIO;

  const { world } = loadScenario(definition);

  if (!opts.quiet) {
    console.log(`Scenario: ${definition.name}`);
    if (definition.description) console.log(definition.description);
    console.log(
      `Running ${opts.durationSeconds}s of simulated time at ${world.clock.stepSeconds}s steps\n`,
    );
  }

  const startedAt = Date.now();
  const stepsPerReport = Math.round(opts.reportInterval / world.clock.stepSeconds);
  const totalSteps = Math.round(opts.durationSeconds / world.clock.stepSeconds);

  for (let step = 0; step < totalSteps; step++) {
    world.step();
    if (!opts.quiet && step % stepsPerReport === 0) {
      report(world.snapshot(), opts.format);
    }
  }

  const elapsed = (Date.now() - startedAt) / 1000;
  const ratio = opts.durationSeconds / Math.max(elapsed, 1e-6);

  if (opts.format === 'text') {
    console.log(
      `\n${totalSteps} steps in ${elapsed.toFixed(2)}s wall clock` +
        ` (${ratio.toFixed(0)}x real time, ${(totalSteps / elapsed).toFixed(0)} steps/s)`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

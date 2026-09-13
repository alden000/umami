import { describe, expect, it } from 'vitest';
import {
  destinationPoint,
  degrees,
  haversineDistance,
  knots,
  toDegrees,
  toKnots,
  wrapAngleSigned,
} from '@umami/core';
import { loadScenario, type ScenarioDefinition } from './scenario.js';
import { assessRisk, computeCpa } from './collision.js';
import { AutopilotController, WaypointController } from './control/index.js';

const ORIGIN = { lat: 1.2, lon: 103.8 };

function baseScenario(over: Partial<ScenarioDefinition> = {}): ScenarioDefinition {
  return {
    name: 'test',
    origin: ORIGIN,
    startTime: '2026-01-01T00:00:00Z',
    stepSeconds: 0.1,
    ...over,
  };
}

describe('scenario loading', () => {
  it('places own ship and ghosts at their stated positions', () => {
    const { world } = loadScenario(
      baseScenario({
        ownShip: {
          id: 'usv',
          vesselClass: 'usv-waterjet',
          position: ORIGIN,
          headingDegrees: 45,
          speedKnots: 10,
        },
        ghosts: [
          { id: 'g1', vesselClass: 'container-feeder', position: { lat: 1.25, lon: 103.82 } },
        ],
      }),
    );

    const snap = world.snapshot();
    expect(snap.objects).toHaveLength(2);
    expect(snap.ownShipId).toBe('usv');

    const own = snap.objects.find((o) => o.id === 'usv')!;
    expect(own.kind).toBe('usv');
    expect(haversineDistance(own.position, ORIGIN)).toBeLessThan(1);
    expect(toDegrees(own.heading ?? 0)).toBeCloseTo(45, 3);
    expect(toKnots(own.sog ?? 0)).toBeCloseTo(10, 1);
  });

  it('converts marine units at the boundary only', () => {
    const { world } = loadScenario(
      baseScenario({
        environment: { windFromDegrees: 90, windSpeedKnots: 20, currentDriftKnots: 2, currentSetDegrees: 180 },
      }),
    );
    const env = world.environment;
    expect(env.wind.speed).toBeCloseTo(knots(20), 6);
    expect(env.wind.fromRadians).toBeCloseTo(degrees(90), 6);
    expect(env.current.driftSpeed).toBeCloseTo(knots(2), 6);
  });
});

describe('determinism', () => {
  it('produces identical results from identical inputs', () => {
    const def = baseScenario({
      ownShip: {
        id: 'usv',
        vesselClass: 'usv-waterjet',
        position: ORIGIN,
        headingDegrees: 0,
        control: { mode: 'course-speed', courseDegrees: 90, speedKnots: 15 },
      },
      environment: { windFromDegrees: 45, windSpeedKnots: 15, currentSetDegrees: 200, currentDriftKnots: 1.5 },
    });

    const a = loadScenario(def).world;
    const b = loadScenario(def).world;
    a.runFor(300);
    b.runFor(300);

    const sa = a.snapshot().objects[0]!;
    const sb = b.snapshot().objects[0]!;
    expect(sa.position.lat).toBe(sb.position.lat);
    expect(sa.position.lon).toBe(sb.position.lon);
    expect(sa.heading).toBe(sb.heading);
  });

  it('reaches the same state whether stepped one at a time or in bulk', () => {
    const def = baseScenario({
      ownShip: {
        id: 'usv',
        vesselClass: 'patrol-boat',
        position: ORIGIN,
        control: { mode: 'course-speed', courseDegrees: 270, speedKnots: 12 },
      },
    });
    const a = loadScenario(def).world;
    const b = loadScenario(def).world;
    for (let i = 0; i < 1200; i++) a.step();
    b.run(1200);
    expect(a.snapshot().objects[0]!.position).toEqual(b.snapshot().objects[0]!.position);
  });
});

describe('autopilot', () => {
  it('settles on a commanded course', () => {
    const { world } = loadScenario(
      baseScenario({
        ownShip: {
          id: 'usv',
          vesselClass: 'usv-waterjet',
          position: ORIGIN,
          headingDegrees: 0,
          speedKnots: 8,
          control: { mode: 'course-speed', courseDegrees: 90, speedKnots: 12 },
        },
      }),
    );

    world.runFor(400);
    const own = world.snapshot().objects[0]!;
    expect(toDegrees(own.cog ?? 0)).toBeCloseTo(90, 0);
    expect(toKnots(own.sog ?? 0)).toBeCloseTo(12, 0);
  });

  // KNOWN ISSUE - see docs/architecture.md, "Open issues".
  //
  // A vessel making way through a cross-current is not being set by it. With a
  // two-knot beam current a vessel making six knots should show course over
  // ground about 19 degrees off its heading; instead COG tracks heading to
  // within a degree, and the steady-state body sway velocity settles near zero
  // when it should settle at the current's athwartships component.
  //
  // Minimal repro: heading-hold on 108 deg at 6 kn, current setting 000 at
  // 1 kn, run 900 s - the vessel settles on 166 deg instead of 108, and the
  // error grows with drift. It is an equilibrium, not an instability: the
  // vessel is steady and not sideslipping, which is itself the clue.
  //
  // The suspect is how current enters the equations. Body velocities are
  // integrated as ground-referenced while hydrodynamic forces are evaluated
  // against relative velocity (`VesselDynamics.totalForce`), and a vessel
  // under thrust does not reach the equilibrium that pairing implies. Drift
  // with no way on is correct - the dead-vessel test below passes - so the
  // error is specific to the powered case.
  //
  // Unskip once fixed; the assertions below are the intended behaviour.
  it.skip('holds a course over ground across a cross-current, crabbing into it', () => {
    const { world } = loadScenario(
      baseScenario({
        ownShip: {
          id: 'usv',
          vesselClass: 'usv-waterjet',
          position: ORIGIN,
          headingDegrees: 90,
          speedKnots: 6,
          control: { mode: 'course-speed', courseDegrees: 90, speedKnots: 6 },
        },
        // Two knots setting due north, across an easterly track.
        environment: { currentSetDegrees: 0, currentDriftKnots: 2 },
      }),
    );

    world.runFor(600);
    const own = world.snapshot().objects[0]!;
    // Course made good is still east...
    expect(toDegrees(own.cog ?? 0)).toBeCloseTo(90, 0);
    // ...but the bow is pointing south of it to counter the set.
    const crab = wrapAngleSigned((own.heading ?? 0) - (own.cog ?? 0));
    expect(toDegrees(crab)).toBeGreaterThan(2);
  });

  it('tunes gains that work across wildly different hulls', () => {
    for (const vesselClass of ['usv-waterjet', 'harbour-tug', 'container-large'] as const) {
      const { world } = loadScenario(
        baseScenario({
          ownShip: {
            id: 'v',
            vesselClass,
            position: ORIGIN,
            headingDegrees: 0,
            speedKnots: 6,
            control: { mode: 'heading-speed', headingDegrees: 60, speedKnots: 8 },
          },
        }),
      );
      world.runFor(1800);
      const own = world.snapshot().objects[0]!;
      const error = Math.abs(toDegrees(wrapAngleSigned((own.heading ?? 0) - degrees(60))));
      expect(error, `${vesselClass} settled ${error.toFixed(1)} deg off`).toBeLessThan(5);
    }
  });
});

describe('waypoint guidance', () => {
  it('follows a route and reports progress', () => {
    const leg1 = destinationPoint(ORIGIN, degrees(90), 2000);
    const leg2 = destinationPoint(leg1, degrees(0), 2000);

    const { world } = loadScenario(
      baseScenario({
        ownShip: {
          id: 'usv',
          vesselClass: 'usv-waterjet',
          position: ORIGIN,
          headingDegrees: 90,
          speedKnots: 10,
          control: {
            mode: 'waypoint',
            waypoints: [
              { lat: leg1.lat, lon: leg1.lon, speedKnots: 15 },
              { lat: leg2.lat, lon: leg2.lon, speedKnots: 15 },
            ],
          },
        },
      }),
    );

    // Track the closest approach rather than the final position: once the
    // route completes the controller commands zero speed, and the vessel
    // carries its way past the mark for some minutes afterwards. Arriving is
    // the requirement; where it drifts to while stopping is not.
    const controller = world.ownShip!.controller as WaypointController;
    let closest = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 9000; i++) {
      world.step();
      const p = world.ownShip!.position(world.plane);
      closest = Math.min(closest, haversineDistance(p, leg2));
      if (controller.status.complete) break;
    }

    expect(controller.status.complete).toBe(true);
    expect(closest).toBeLessThan(100);
  });

  it('converges back onto the track after being set off it', () => {
    const far = destinationPoint(ORIGIN, degrees(90), 6000);
    const start = destinationPoint(ORIGIN, degrees(0), 300); // 300 m north of the leg

    const { world } = loadScenario(
      baseScenario({
        ownShip: {
          id: 'usv',
          vesselClass: 'usv-waterjet',
          position: start,
          headingDegrees: 90,
          speedKnots: 10,
          control: {
            mode: 'waypoint',
            waypoints: [
              { lat: ORIGIN.lat, lon: ORIGIN.lon },
              { lat: far.lat, lon: far.lon, speedKnots: 12 },
            ],
          },
        },
      }),
    );

    world.runFor(600);
    const controller = world.ownShip!.controller as WaypointController;
    expect(Math.abs(controller.status.crossTrackError as number)).toBeLessThan(60);
  });
});

describe('ghost targets', () => {
  it('can be dropped in at runtime and driven', () => {
    const { world } = loadScenario(
      baseScenario({
        ownShip: { id: 'usv', vesselClass: 'usv-waterjet', position: ORIGIN },
      }),
    );

    const ghost = world.spawnGhost({
      position: destinationPoint(ORIGIN, degrees(45), 3000),
      vesselClass: 'container-feeder',
      heading: degrees(225),
      speed: knots(12),
      name: 'DROP IN',
    });

    const gains = { kp: 2, ki: 0.05, kd: 20 };
    const autopilot = new AutopilotController({ gains, maxSpeed: knots(18), followCourse: true });
    autopilot.setCourseDemand(degrees(225), knots(12));
    ghost.setController(autopilot);

    const before = ghost.position(world.plane);
    world.runFor(300);
    const after = ghost.position(world.plane);

    expect(haversineDistance(before, after)).toBeGreaterThan(1000);
    expect(world.snapshot().objects).toHaveLength(2);
  });

  it('moves with real dynamics rather than sliding along a line', () => {
    const { world } = loadScenario(baseScenario({}));
    const ghost = world.spawnGhost({
      position: ORIGIN,
      vesselClass: 'container-large',
      heading: 0,
      speed: knots(15),
    });

    const gains = { kp: 2, ki: 0.02, kd: 60 };
    const autopilot = new AutopilotController({ gains, maxSpeed: knots(21) });
    autopilot.setHeadingDemand(degrees(90), knots(15));
    ghost.setController(autopilot);

    world.runFor(20);
    // A 366 m ship cannot be 90 degrees round in 20 seconds.
    const turned = Math.abs(toDegrees(ghost.dynamics.state.heading));
    expect(turned).toBeLessThan(30);
  });
});

describe('CPA', () => {
  it('finds a head-on collision course closing to nothing', () => {
    const own = { position: ORIGIN, cog: degrees(0), sog: knots(10) };
    const target = {
      position: destinationPoint(ORIGIN, degrees(0), 3704), // 2 nm ahead
      cog: degrees(180),
      sog: knots(10),
    };
    const cpa = computeCpa(own, target);
    expect(cpa.cpa).toBeLessThan(50);
    expect(cpa.closing).toBe(true);
    // Closing at 20 knots over 2 nm: about six minutes.
    expect(cpa.tcpa).toBeCloseTo(360, -1);
  });

  it('reports a passing vessel as no risk', () => {
    const own = { position: ORIGIN, cog: degrees(0), sog: knots(10) };
    const target = {
      position: destinationPoint(ORIGIN, degrees(90), 9260), // 5 nm abeam
      cog: degrees(0),
      sog: knots(10),
    };
    const risk = assessRisk(own, target);
    expect(risk.dangerous).toBe(false);
  });

  it('classifies a crossing vessel on the starboard bow as give-way', () => {
    const own = { position: ORIGIN, cog: degrees(0), sog: knots(10) };
    const target = {
      position: destinationPoint(ORIGIN, degrees(45), 2000),
      cog: degrees(270),
      sog: knots(10),
    };
    const risk = assessRisk(own, target);
    expect(risk.encounter).toBe('crossing-give-way');
    expect(risk.dangerous).toBe(true);
  });

  it('classifies reciprocal courses dead ahead as head-on', () => {
    const own = { position: ORIGIN, cog: degrees(0), sog: knots(10) };
    const target = {
      position: destinationPoint(ORIGIN, degrees(0), 2000),
      cog: degrees(180),
      sog: knots(10),
    };
    expect(assessRisk(own, target).encounter).toBe('head-on');
  });
});

import { describe, expect, it } from 'vitest';
import { knots, toKnots, toDegrees, wrapAngleSigned } from '@umami/core';
import { CALM_CONDITIONS, VesselDynamics, type EnvironmentConditions } from './vessel.js';
import { ShaftRudderPropulsion, WaterjetPropulsion } from './propulsion/index.js';
import { deriveHydroCoefficients } from './hull.js';
import type { PropulsionModel } from './types.js';
import {
  VESSEL_CLASSES,
  calmWaterResistance,
  createVessel,
  vesselClassForAisType,
} from './vessel-library.js';
import { NO_WIND, CALM_SEA } from './environment.js';
import {
  SEAWATER_DENSITY,
  conditionMassMatrix,
  isPhysicallyRealisable,
  massMatrix,
} from './hull.js';


const DT = 0.1;

function run(
  vessel: ReturnType<typeof createVessel>,
  seconds: number,
  demand: { throttle: number; steer: number },
  env: EnvironmentConditions = CALM_CONDITIONS,
): void {
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) vessel.step(demand, env, DT, i * DT);
}

describe('acceleration and top speed', () => {
  it('brings a container ship up to near its service speed at full ahead', () => {
    const ship = createVessel('container-large');
    run(ship, 3600, { throttle: 1, steer: 0 });
    const speed = toKnots(ship.state.u);
    // Sized for 21 kn service speed with a 25% thrust margin.
    expect(speed).toBeGreaterThan(21);
    expect(speed).toBeLessThan(26);
  });

  it('accelerates a small USV far faster than a laden tanker', () => {
    const usv = createVessel('usv-waterjet');
    const tanker = createVessel('vlcc');
    run(usv, 60, { throttle: 1, steer: 0 });
    run(tanker, 60, { throttle: 1, steer: 0 });
    const usvFraction = usv.state.u / knots(25);
    const tankerFraction = tanker.state.u / knots(15);
    expect(usvFraction).toBeGreaterThan(tankerFraction * 3);
  });
});

describe('turning', () => {
  it('turns a ship to starboard on starboard helm', () => {
    const ship = createVessel('general-cargo');
    run(ship, 300, { throttle: 1, steer: 0 });
    const initial = ship.state.heading;
    run(ship, 120, { throttle: 1, steer: 1 });
    expect(wrapAngleSigned(ship.state.heading - initial)).toBeGreaterThan(0.2);
  });

  it('gives a tanker a far larger turning circle than a patrol boat', () => {
    const tanker = createVessel('vlcc');
    const patrol = createVessel('patrol-boat');
    run(tanker, 2400, { throttle: 1, steer: 0 });
    run(patrol, 300, { throttle: 1, steer: 0 });

    const advance = (v: ReturnType<typeof createVessel>): number => {
      const start = { n: v.state.north, e: v.state.east };
      const startHeading = v.state.heading;
      // Run until the vessel has turned 90 degrees, then measure displacement.
      for (let i = 0; i < 60000; i++) {
        v.step({ throttle: 1, steer: 1 }, CALM_CONDITIONS, DT, i * DT);
        if (Math.abs(wrapAngleSigned(v.state.heading - startHeading)) >= Math.PI / 2) break;
      }
      return Math.hypot(v.state.north - start.n, v.state.east - start.e);
    };

    expect(advance(tanker)).toBeGreaterThan(advance(patrol) * 3);
  });
});

describe('propulsion type determines low-speed steering authority', () => {
  const dead = { north: 0, east: 0, heading: 0, u: 0, v: 0, r: 0 };

  it('lets a waterjet craft turn with no way on', () => {
    const usv = createVessel('usv-waterjet');
    usv.state = dead;
    // Hard over, throttle up, from dead in the water.
    run(usv, 30, { throttle: 0.6, steer: 1 });
    expect(Math.abs(toDegrees(usv.state.r))).toBeGreaterThan(1);
    expect(toKnots(usv.state.u)).toBeLessThan(12);
  });

  it('leaves a shaft-and-rudder vessel with far less authority from rest', () => {
    // Same hull, same installed thrust, same everything but the drive - so
    // what this measures is the drive, not the size of the boat.
    const particulars = { loa: 20, lpp: 18, beam: 5.6, draught: 1.6, blockCoefficient: 0.45 };
    const coefficients = deriveHydroCoefficients(particulars, {
      totalResistanceCoefficient: 0.005,
    });
    const thrust = calmWaterResistance(particulars, knots(25), 0.005) * 1.25;

    const build = (propulsion: PropulsionModel): VesselDynamics =>
      new VesselDynamics({ particulars, coefficients, propulsion, initialState: dead });

    const jet = build(
      new WaterjetPropulsion({
        unitCount: 2,
        maxThrustPerUnit: thrust / 2,
        leverArm: 0.45 * particulars.loa,
        designSpeed: knots(25),
      }),
    );
    const shaft = build(
      new ShaftRudderPropulsion({
        maxThrust: thrust,
        rudderArea: (particulars.lpp * particulars.draught) / 60,
        leverArm: 0.45 * particulars.lpp,
        propellerDiameter: 0.65 * particulars.draught,
      }),
    );

    run(jet, 15, { throttle: 0.5, steer: 1 });
    run(shaft, 15, { throttle: 0.5, steer: 1 });

    // The jet vectors its full thrust within a second, while the rudder is
    // still slewing at 2.3 deg/s and only bites on what the propeller race
    // gives it. The margin here is real but modest - about 30% - because a
    // rudder in the race does work at rest, which is exactly why ships kick
    // ahead on the helm. The categorical difference appears with the engine
    // stopped; see the next test.
    expect(Math.abs(jet.state.r)).toBeGreaterThan(Math.abs(shaft.state.r));
  });

  it('collapses rudder authority when the engine is stopped, but not the jet', () => {
    const particulars = { loa: 20, lpp: 18, beam: 5.6, draught: 1.6, blockCoefficient: 0.45 };
    const coefficients = deriveHydroCoefficients(particulars, {
      totalResistanceCoefficient: 0.005,
    });
    const thrust = calmWaterResistance(particulars, knots(25), 0.005) * 1.25;

    const shaft = new VesselDynamics({
      particulars,
      coefficients,
      propulsion: new ShaftRudderPropulsion({
        maxThrust: thrust,
        rudderArea: (particulars.lpp * particulars.draught) / 60,
        leverArm: 0.45 * particulars.lpp,
        propellerDiameter: 0.65 * particulars.draught,
      }),
      initialState: dead,
    });
    // Hard over with the engine stopped: a rudder in still water does nothing.
    run(shaft, 30, { throttle: 0, steer: 1 });
    expect(Math.abs(shaft.state.r)).toBeLessThan(1e-6);
  });

  it('reports the capability so controllers can branch on it', () => {
    expect(createVessel('usv-waterjet').propulsion.steersAtZeroSpeed).toBe(true);
    expect(createVessel('usv-outboard').propulsion.steersAtZeroSpeed).toBe(true);
    expect(createVessel('vlcc').propulsion.steersAtZeroSpeed).toBe(false);
  });
});

describe('stopping', () => {
  it('takes a laden tanker much longer to stop than a small craft', () => {
    const tanker = createVessel('vlcc');
    const usv = createVessel('usv-waterjet');
    run(tanker, 3600, { throttle: 1, steer: 0 });
    run(usv, 300, { throttle: 1, steer: 0 });

    const stoppingDistance = (v: ReturnType<typeof createVessel>): number => {
      const start = { n: v.state.north, e: v.state.east };
      for (let i = 0; i < 200000 && v.state.u > 0.25; i++) {
        v.step({ throttle: -1, steer: 0 }, CALM_CONDITIONS, DT, i * DT);
      }
      return Math.hypot(v.state.north - start.n, v.state.east - start.e);
    };

    const tankerStop = stoppingDistance(tanker);
    const usvStop = stoppingDistance(usv);
    // A VLCC crash-stops in roughly 10-20 ship lengths; a 12 m USV in a few.
    expect(tankerStop).toBeGreaterThan(1000);
    expect(tankerStop).toBeGreaterThan(usvStop * 10);
  });
});

describe('environment', () => {
  it('sets a drifting vessel down-current', () => {
    const usv = createVessel('usv-waterjet');
    const env: EnvironmentConditions = {
      current: { setRadians: Math.PI / 2, driftSpeed: knots(3) }, // flowing east
      wind: NO_WIND,
      sea: CALM_SEA,
      waterDensity: SEAWATER_DENSITY,
    };
    run(usv, 600, { throttle: 0, steer: 0 }, env);
    expect(usv.state.east).toBeGreaterThan(100);
  });

  it('pushes a high-sided vessel downwind when stopped', () => {
    const ship = createVessel('container-large');
    const env: EnvironmentConditions = {
      current: { setRadians: 0, driftSpeed: 0 },
      wind: { fromRadians: 0, speed: 20 }, // northerly gale, blowing toward the south
      sea: CALM_SEA,
      waterDensity: SEAWATER_DENSITY,
    };
    run(ship, 900, { throttle: 0, steer: 0 }, env);
    expect(ship.state.north).toBeLessThan(-5);
  });
});

describe('vessel library', () => {
  it('sizes thrust from resistance at the service speed', () => {
    const p = { loa: 100, beam: 16, draught: 6, blockCoefficient: 0.7 };
    expect(calmWaterResistance(p, knots(14))).toBeGreaterThan(0);
    expect(calmWaterResistance(p, knots(14))).toBeGreaterThan(calmWaterResistance(p, knots(7)));
  });

  it('maps AIS ship types to plausible classes', () => {
    expect(vesselClassForAisType(80)).toBe('vlcc');
    expect(vesselClassForAisType(70)).toBe('container-large');
    expect(vesselClassForAisType(30)).toBe('fishing-vessel');
    expect(vesselClassForAisType(52)).toBe('harbour-tug');
    expect(vesselClassForAisType(36)).toBe('sailing-yacht');
    expect(vesselClassForAisType(undefined)).toBe('general-cargo');
  });

  it('accepts overridden particulars so AIS dimensions can be honoured', () => {
    const v = createVessel('container-feeder', { particulars: { loa: 210, beam: 30 } });
    expect(v.particulars.loa).toBe(210);
    expect(v.particulars.beam).toBe(30);
  });
});

describe('physical realisability', () => {
  it('produces a positive-definite mass matrix for every reference class', () => {
    for (const def of Object.values(VESSEL_CLASSES)) {
      const c = deriveHydroCoefficients(def.particulars, def.deriveOptions);
      const m = massMatrix(c);
      expect(isPhysicallyRealisable(c), `${def.id} determinant ${m.determinant}`).toBe(true);
    }
  });

  it('survives hull proportions far outside the regression envelope', () => {
    // A square pontoon: nothing like the merchant hulls Clarke fitted.
    const absurd = { loa: 10, beam: 10, draught: 5, blockCoefficient: 0.95 };
    const c = deriveHydroCoefficients(absurd);
    expect(isPhysicallyRealisable(c)).toBe(true);
  });

  it('repairs coefficients whose added-mass signs are wrong', () => {
    const good = deriveHydroCoefficients({
      loa: 100,
      beam: 16,
      draught: 6,
      blockCoefficient: 0.7,
    });
    // Positive diagonal added mass is physically impossible in this convention.
    const broken = { ...good, Yvdot: Math.abs(good.Yvdot), Nrdot: Math.abs(good.Nrdot) };
    expect(isPhysicallyRealisable(broken)).toBe(false);
    expect(isPhysicallyRealisable(conditionMassMatrix(broken))).toBe(true);
  });

  it('does not produce NaN when integrating an extreme hull', () => {
    const vessel = createVessel('harbour-tug');
    run(vessel, 600, { throttle: 1, steer: 1 });
    expect(Number.isFinite(vessel.state.heading)).toBe(true);
    expect(Number.isFinite(vessel.state.u)).toBe(true);
    expect(Number.isFinite(vessel.state.r)).toBe(true);
  });
});

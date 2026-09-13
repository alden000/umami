import { knots, type MetresPerSecond, type Newtons } from '@umami/core';
import { SEAWATER_DENSITY, deriveHydroCoefficients, type DeriveOptions } from './hull.js';
import { OutboardPropulsion, ShaftRudderPropulsion, WaterjetPropulsion } from './propulsion/index.js';
import type { HullParticulars, PropulsionModel } from './types.js';
import { VesselDynamics, type VesselDynamicsOptions } from './vessel.js';

/**
 * Calm-water resistance at a given speed, newtons.
 *
 * Used to size installed thrust so that a vessel defined only by its
 * particulars and a service speed actually makes that speed, rather than
 * needing a hand-tuned thrust figure per class.
 */
export function calmWaterResistance(
  p: HullParticulars,
  speed: MetresPerSecond,
  totalResistanceCoefficient = 0.003,
  waterDensity = SEAWATER_DENSITY,
): Newtons {
  const L = p.lpp ?? p.loa * 0.96;
  const volume = p.blockCoefficient * L * p.beam * p.draught;
  const wettedSurface = 1.7 * L * p.draught + volume / p.draught;
  return 0.5 * waterDensity * wettedSurface * totalResistanceCoefficient * speed * speed;
}

export type VesselClassId =
  | 'vlcc'
  | 'product-tanker'
  | 'container-large'
  | 'container-feeder'
  | 'bulk-carrier'
  | 'general-cargo'
  | 'ropax-ferry'
  | 'fast-ferry'
  | 'fishing-vessel'
  | 'harbour-tug'
  | 'pilot-boat'
  | 'patrol-boat'
  | 'motor-yacht'
  | 'sailing-yacht'
  | 'rib'
  | 'usv-waterjet'
  | 'usv-outboard';

export interface VesselClassDefinition {
  readonly id: VesselClassId;
  readonly label: string;
  readonly particulars: HullParticulars;
  /** Service speed, m/s. Installed thrust is sized to achieve it. */
  readonly serviceSpeed: MetresPerSecond;
  readonly deriveOptions?: DeriveOptions;
  /** AIS ship-and-cargo type codes that map to this class. */
  readonly aisShipTypes: readonly number[];
  readonly makePropulsion: (p: HullParticulars, serviceSpeed: MetresPerSecond) => PropulsionModel;
}

/** Margin over bare-hull resistance, covering appendages, fouling, wind and sea. */
const THRUST_MARGIN = 1.25;

const SHAFT_THRUST_DEDUCTION = 0.18;
const WATERJET_THRUST_DEDUCTION = 0.04;
const OUTBOARD_THRUST_DEDUCTION = 0.08;

/**
 * Installed thrust needed to push a hull at `speed`.
 *
 * The propeller has to deliver more than the bare-hull resistance, because the
 * accelerated flow over the afterbody increases that resistance: the thrust
 * deduction factor. Sizing on resistance alone leaves every vessel several
 * knots short of its designed speed.
 */
function installedThrust(
  p: HullParticulars,
  speed: MetresPerSecond,
  cT: number,
  thrustDeduction: number,
): Newtons {
  return (calmWaterResistance(p, speed, cT) * THRUST_MARGIN) / (1 - thrustDeduction);
}

function shaftRudder(cT: number) {
  return (p: HullParticulars, v: MetresPerSecond): PropulsionModel => {
    const L = p.lpp ?? p.loa * 0.96;
    return new ShaftRudderPropulsion({
      maxThrust: installedThrust(p, v, cT, SHAFT_THRUST_DEDUCTION),
      thrustDeduction: SHAFT_THRUST_DEDUCTION,
      rudderArea: (L * p.draught) / 60,
      leverArm: 0.45 * L,
      // Merchant propeller diameters run around 0.65-0.7 of draught.
      propellerDiameter: 0.65 * p.draught,
    });
  };
}

function waterjet(cT: number, units: number) {
  return (p: HullParticulars, v: MetresPerSecond): PropulsionModel =>
    new WaterjetPropulsion({
      unitCount: units,
      maxThrustPerUnit: installedThrust(p, v, cT, WATERJET_THRUST_DEDUCTION) / units,
      thrustDeduction: WATERJET_THRUST_DEDUCTION,
      leverArm: 0.45 * p.loa,
      designSpeed: v,
    });
}

function outboard(cT: number, engines: number) {
  return (p: HullParticulars, v: MetresPerSecond): PropulsionModel =>
    new OutboardPropulsion({
      engineCount: engines,
      maxThrustPerEngine: installedThrust(p, v, cT, OUTBOARD_THRUST_DEDUCTION) / engines,
      thrustDeduction: OUTBOARD_THRUST_DEDUCTION,
      leverArm: 0.45 * p.loa,
      lateralOffset: engines > 1 ? p.beam * 0.25 : 0,
      differentialSteerFraction: engines > 1 ? 0.2 : 0,
    });
}

/**
 * Reference vessel classes.
 *
 * Deliberately small and broad rather than exhaustive: the point is to give
 * every AIS contact motion that is recognisably right for its type - a laden
 * tanker that takes a mile to stop, a tug that turns in its own length - so
 * that a USV's collision-avoidance logic is tested against realistic
 * behaviour. Add classes here; nothing else needs to change.
 */
export const VESSEL_CLASSES: Readonly<Record<VesselClassId, VesselClassDefinition>> = {
  vlcc: {
    id: 'vlcc',
    label: 'VLCC crude oil tanker',
    particulars: { loa: 333, lpp: 320, beam: 60, draught: 20.8, blockCoefficient: 0.83 },
    serviceSpeed: knots(15),
    deriveOptions: { totalResistanceCoefficient: 0.0024 },
    aisShipTypes: [80, 81, 82, 83, 84, 85, 86, 87, 88, 89],
    makePropulsion: shaftRudder(0.0024),
  },
  'product-tanker': {
    id: 'product-tanker',
    label: 'Product tanker',
    particulars: { loa: 183, lpp: 176, beam: 32.2, draught: 11, blockCoefficient: 0.8 },
    serviceSpeed: knots(14.5),
    deriveOptions: { totalResistanceCoefficient: 0.0026 },
    aisShipTypes: [],
    makePropulsion: shaftRudder(0.0026),
  },
  'container-large': {
    id: 'container-large',
    label: 'Large container ship',
    particulars: { loa: 366, lpp: 350, beam: 51, draught: 15.2, blockCoefficient: 0.65 },
    serviceSpeed: knots(21),
    deriveOptions: { totalResistanceCoefficient: 0.0026 },
    aisShipTypes: [70, 71, 72, 73, 74, 79],
    makePropulsion: shaftRudder(0.0026),
  },
  'container-feeder': {
    id: 'container-feeder',
    label: 'Feeder container ship',
    particulars: { loa: 170, lpp: 162, beam: 27, draught: 9.5, blockCoefficient: 0.66 },
    serviceSpeed: knots(18),
    deriveOptions: { totalResistanceCoefficient: 0.0028 },
    aisShipTypes: [75, 76, 77, 78],
    makePropulsion: shaftRudder(0.0028),
  },
  'bulk-carrier': {
    id: 'bulk-carrier',
    label: 'Handymax bulk carrier',
    particulars: { loa: 190, lpp: 183, beam: 32.3, draught: 12.6, blockCoefficient: 0.82 },
    serviceSpeed: knots(14),
    deriveOptions: { totalResistanceCoefficient: 0.0026 },
    aisShipTypes: [],
    makePropulsion: shaftRudder(0.0026),
  },
  'general-cargo': {
    id: 'general-cargo',
    label: 'General cargo ship',
    particulars: { loa: 120, lpp: 113, beam: 18, draught: 7.2, blockCoefficient: 0.75 },
    serviceSpeed: knots(13),
    deriveOptions: { totalResistanceCoefficient: 0.003 },
    aisShipTypes: [],
    makePropulsion: shaftRudder(0.003),
  },
  'ropax-ferry': {
    id: 'ropax-ferry',
    label: 'Ro-pax ferry',
    particulars: { loa: 186, lpp: 172, beam: 25.6, draught: 6.4, blockCoefficient: 0.58 },
    serviceSpeed: knots(22),
    deriveOptions: { totalResistanceCoefficient: 0.003 },
    aisShipTypes: [60, 61, 62, 63, 64, 65, 66, 67, 68, 69],
    makePropulsion: shaftRudder(0.003),
  },
  'fast-ferry': {
    id: 'fast-ferry',
    label: 'High-speed catamaran ferry',
    particulars: { loa: 72, lpp: 66, beam: 20, draught: 2.9, blockCoefficient: 0.45 },
    serviceSpeed: knots(36),
    deriveOptions: { totalResistanceCoefficient: 0.0045 },
    aisShipTypes: [40, 41, 42, 43, 44, 45, 46, 47, 48, 49],
    makePropulsion: waterjet(0.0045, 4),
  },
  'fishing-vessel': {
    id: 'fishing-vessel',
    label: 'Fishing vessel',
    particulars: { loa: 28, lpp: 25, beam: 8, draught: 3.4, blockCoefficient: 0.55 },
    serviceSpeed: knots(10),
    deriveOptions: { totalResistanceCoefficient: 0.0045 },
    aisShipTypes: [30],
    makePropulsion: shaftRudder(0.0045),
  },
  'harbour-tug': {
    id: 'harbour-tug',
    label: 'Harbour tug',
    particulars: { loa: 32, lpp: 29, beam: 12.6, draught: 5.5, blockCoefficient: 0.58 },
    serviceSpeed: knots(13),
    deriveOptions: { totalResistanceCoefficient: 0.005, yawGyradiusRatio: 0.22 },
    aisShipTypes: [31, 32, 52],
    makePropulsion: waterjet(0.005, 2),
  },
  'pilot-boat': {
    id: 'pilot-boat',
    label: 'Pilot boat',
    particulars: { loa: 20, lpp: 18, beam: 5.6, draught: 1.6, blockCoefficient: 0.45 },
    serviceSpeed: knots(25),
    deriveOptions: { totalResistanceCoefficient: 0.005 },
    aisShipTypes: [50, 53],
    makePropulsion: shaftRudder(0.005),
  },
  'patrol-boat': {
    id: 'patrol-boat',
    label: 'Patrol boat',
    particulars: { loa: 35, lpp: 32, beam: 7.2, draught: 2.1, blockCoefficient: 0.45 },
    serviceSpeed: knots(28),
    deriveOptions: { totalResistanceCoefficient: 0.0048 },
    aisShipTypes: [35, 51, 55],
    makePropulsion: waterjet(0.0048, 2),
  },
  'motor-yacht': {
    id: 'motor-yacht',
    label: 'Motor yacht',
    particulars: { loa: 24, lpp: 21, beam: 6, draught: 1.7, blockCoefficient: 0.42 },
    serviceSpeed: knots(22),
    deriveOptions: { totalResistanceCoefficient: 0.005 },
    aisShipTypes: [37],
    makePropulsion: shaftRudder(0.005),
  },
  'sailing-yacht': {
    id: 'sailing-yacht',
    label: 'Sailing yacht (under power)',
    particulars: { loa: 14, lpp: 12, beam: 4.2, draught: 2.1, blockCoefficient: 0.4 },
    serviceSpeed: knots(7),
    deriveOptions: { totalResistanceCoefficient: 0.0055 },
    aisShipTypes: [36],
    makePropulsion: shaftRudder(0.0055),
  },
  rib: {
    id: 'rib',
    label: 'Rigid inflatable boat',
    particulars: { loa: 8.5, lpp: 7.6, beam: 3, draught: 0.6, blockCoefficient: 0.4 },
    serviceSpeed: knots(32),
    deriveOptions: { totalResistanceCoefficient: 0.006 },
    aisShipTypes: [],
    makePropulsion: outboard(0.006, 2),
  },
  'usv-waterjet': {
    id: 'usv-waterjet',
    label: 'USV, twin waterjet',
    particulars: { loa: 12, lpp: 11, beam: 3.6, draught: 0.9, blockCoefficient: 0.45 },
    serviceSpeed: knots(25),
    deriveOptions: { totalResistanceCoefficient: 0.0055 },
    aisShipTypes: [],
    makePropulsion: waterjet(0.0055, 2),
  },
  'usv-outboard': {
    id: 'usv-outboard',
    label: 'USV, twin outboard',
    particulars: { loa: 9, lpp: 8.2, beam: 3, draught: 0.7, blockCoefficient: 0.42 },
    serviceSpeed: knots(28),
    deriveOptions: { totalResistanceCoefficient: 0.006 },
    aisShipTypes: [],
    makePropulsion: outboard(0.006, 2),
  },
};

/** Look up the class a given AIS ship-and-cargo type belongs to. */
export function vesselClassForAisType(shipType: number | undefined): VesselClassId {
  if (shipType === undefined) return 'general-cargo';
  for (const def of Object.values(VESSEL_CLASSES)) {
    if (def.aisShipTypes.includes(shipType)) return def.id;
  }
  if (shipType >= 80 && shipType <= 89) return 'product-tanker';
  if (shipType >= 70 && shipType <= 79) return 'container-feeder';
  if (shipType >= 60 && shipType <= 69) return 'ropax-ferry';
  if (shipType >= 40 && shipType <= 49) return 'fast-ferry';
  return 'general-cargo';
}

export interface CreateVesselOptions
  extends Partial<Omit<VesselDynamicsOptions, 'particulars' | 'coefficients' | 'propulsion'>> {
  /** Override individual particulars, e.g. the real length reported over AIS. */
  readonly particulars?: Partial<HullParticulars>;
  readonly propulsion?: PropulsionModel;
  readonly serviceSpeed?: MetresPerSecond;
}

/** Build a ready-to-step vessel from a reference class. */
export function createVessel(
  classId: VesselClassId,
  opts: CreateVesselOptions = {},
): VesselDynamics {
  const def = VESSEL_CLASSES[classId];
  const particulars: HullParticulars = { ...def.particulars, ...opts.particulars };
  const serviceSpeed = opts.serviceSpeed ?? def.serviceSpeed;
  return new VesselDynamics({
    particulars,
    coefficients: deriveHydroCoefficients(particulars, def.deriveOptions),
    propulsion: opts.propulsion ?? def.makePropulsion(particulars, serviceSpeed),
    initialState: opts.initialState,
    windage: opts.windage,
  });
}

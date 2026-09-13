import { wrapAngle, type MetresPerSecond, type Radians, type Seconds } from '@umami/core';
import {
  NO_CURRENT,
  SEAWATER_DENSITY,
  accelerations,
  coriolisForce,
  currentInBodyFrame,
  hullForce,
  integrateRK4,
  kinematics,
  type CurrentField,
  type DeriveOptions,
  type StateDerivative,
} from './hull.js';
import {
  CALM_SEA,
  NO_WIND,
  estimateWindage,
  seakeepingMotion,
  waveDriftForce,
  windForce,
  type SeaState,
  type SeakeepingMotion,
  type WindField,
  type WindageAreas,
} from './environment.js';
import {
  addForces,
  type ActuatorDemand,
  type BodyForce,
  type HullParticulars,
  type HydroCoefficients,
  type PropulsionModel,
  type RigidBodyState,
} from './types.js';

export interface EnvironmentConditions {
  readonly current: CurrentField;
  readonly wind: WindField;
  readonly sea: SeaState;
  readonly waterDensity: number;
}

export const CALM_CONDITIONS: EnvironmentConditions = {
  current: NO_CURRENT,
  wind: NO_WIND,
  sea: CALM_SEA,
  waterDensity: SEAWATER_DENSITY,
};

export interface VesselDynamicsOptions {
  readonly particulars: HullParticulars;
  readonly coefficients: HydroCoefficients;
  readonly propulsion: PropulsionModel;
  readonly initialState?: Partial<RigidBodyState>;
  readonly windage?: WindageAreas;
  readonly deriveOptions?: DeriveOptions;
}

const ZERO_STATE: RigidBodyState = { north: 0, east: 0, heading: 0, u: 0, v: 0, r: 0 };

/**
 * One vessel's equations of motion: hull, drive and environment together.
 *
 * Owns no notion of position on the earth, no chart and no identity - just a
 * rigid body in a local tangent plane. The simulation layer is what gives it a
 * geodetic position, an MMSI and a controller, which is what lets exactly this
 * class serve the own USV, a scripted ghost target and a vessel reconstructed
 * from an AIS track.
 */
export class VesselDynamics {
  readonly particulars: HullParticulars;
  readonly coefficients: HydroCoefficients;
  readonly propulsion: PropulsionModel;
  readonly windage: WindageAreas;

  private _state: RigidBodyState;
  private _motion: SeakeepingMotion = { rollRadians: 0, pitchRadians: 0, heaveMetres: 0 };

  constructor(opts: VesselDynamicsOptions) {
    this.particulars = opts.particulars;
    this.coefficients = opts.coefficients;
    this.propulsion = opts.propulsion;
    this.windage = opts.windage ?? estimateWindage(opts.particulars);
    this._state = { ...ZERO_STATE, ...opts.initialState };
  }

  get state(): RigidBodyState {
    return this._state;
  }

  set state(next: RigidBodyState) {
    this._state = { ...next, heading: wrapAngle(next.heading) };
  }

  get seakeeping(): SeakeepingMotion {
    return this._motion;
  }

  /** Speed through the water, m/s. What the hull feels and a log reads. */
  get speedThroughWater(): MetresPerSecond {
    return Math.hypot(this._state.u, this._state.v);
  }

  /** Speed over ground, m/s. What GNSS and AIS report. */
  speedOverGround(env: EnvironmentConditions = CALM_CONDITIONS): MetresPerSecond {
    const { vn, ve } = this.groundVelocity(env);
    return Math.hypot(vn, ve);
  }

  /** Course over ground, radians from true north. */
  courseOverGround(env: EnvironmentConditions = CALM_CONDITIONS): Radians {
    const { vn, ve } = this.groundVelocity(env);
    if (Math.hypot(vn, ve) < 1e-3) return this._state.heading;
    return wrapAngle(Math.atan2(ve, vn));
  }

  private groundVelocity(env: EnvironmentConditions): { vn: number; ve: number } {
    const c = Math.cos(this._state.heading);
    const s = Math.sin(this._state.heading);
    // Body velocities are already relative to the ground in this formulation;
    // the current enters through the hydrodynamics, not the kinematics.
    return {
      vn: this._state.u * c - this._state.v * s,
      ve: this._state.u * s + this._state.v * c,
    };
  }

  /** Total body-frame force at a given state. Exposed for trimming and tests. */
  totalForce(state: RigidBodyState, env: EnvironmentConditions): BodyForce {
    const currentBody = currentInBodyFrame(env.current, state.heading);
    const relative = {
      u: state.u - currentBody.u,
      v: state.v - currentBody.v,
      r: state.r,
    };
    return addForces(
      hullForce(this.coefficients, relative),
      coriolisForce(this.coefficients, state),
      this.propulsion.force(relative, { waterDensity: env.waterDensity }),
      windForce(state, env.wind, this.windage, this.particulars.loa),
      waveDriftForce(state, env.sea, this.windage, this.particulars.loa, env.waterDensity),
    );
  }

  /**
   * Advance one fixed step.
   *
   * Actuators are updated once, before integration, and held constant across
   * the four RK4 evaluations - the plant is time-invariant within a step,
   * which is what keeps the integration order meaningful.
   */
  step(demand: ActuatorDemand, env: EnvironmentConditions, dt: Seconds, simTime: Seconds): void {
    this.propulsion.update(demand, dt);

    const derivative = (s: RigidBodyState): StateDerivative =>
      kinematics(s, accelerations(this.coefficients, this.totalForce(s, env)));

    this._state = integrateRK4(this._state, dt, derivative);
    this._motion = seakeepingMotion(
      this._state,
      env.sea,
      this._state,
      this.particulars.loa,
      this.particulars.beam,
      simTime,
    );
  }
}

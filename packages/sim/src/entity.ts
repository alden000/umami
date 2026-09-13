import {
  wrapAngle,
  type EntityId,
  type LatLon,
  type MetresPerSecond,
  type Radians,
  type Seconds,
  type SimTime,
  type TangentPlane,
} from '@umami/core';
import type { EnvironmentConditions, VesselDynamics } from '@umami/dynamics';
import type { Controller } from './control/controller.js';
import type { ObjectDimensions, ObjectIdentity, ObjectKind, WorldObject } from './snapshot.js';

export interface SimulatedEntityOptions {
  readonly id: EntityId;
  readonly kind: Extract<ObjectKind, 'usv' | 'ghost'>;
  readonly dynamics: VesselDynamics;
  readonly controller: Controller;
  readonly identity?: ObjectIdentity;
  readonly initialPosition: LatLon;
  readonly initialHeading?: Radians;
  readonly initialSpeed?: MetresPerSecond;
}

/**
 * A vessel the simulation is integrating: the own USV, or a ghost target.
 *
 * Deliberately the same class for both. A ghost dropped on the chart is a full
 * dynamic vessel with a controller, not a kinematic marker sliding along a
 * line - so it heels in a turn, takes time to build a rate of turn, and cannot
 * stop instantly. Testing collision avoidance against targets that can do
 * things no ship can do produces algorithms that fail against ones that cannot.
 */
export class SimulatedEntity {
  readonly id: EntityId;
  readonly kind: Extract<ObjectKind, 'usv' | 'ghost'>;
  readonly dynamics: VesselDynamics;
  identity: ObjectIdentity;
  private _controller: Controller;

  constructor(opts: SimulatedEntityOptions, plane: TangentPlane) {
    this.id = opts.id;
    this.kind = opts.kind;
    this.dynamics = opts.dynamics;
    this.identity = opts.identity ?? {};
    this._controller = opts.controller;

    const local = plane.toLocal(opts.initialPosition);
    this.dynamics.state = {
      north: local.n,
      east: local.e,
      heading: wrapAngle(opts.initialHeading ?? 0),
      u: opts.initialSpeed ?? 0,
      v: 0,
      r: 0,
    };
  }

  get controller(): Controller {
    return this._controller;
  }

  /** Swap the controller at runtime: hand a ghost to the operator, or take it back. */
  setController(controller: Controller): void {
    this._controller = controller;
  }

  position(plane: TangentPlane): LatLon {
    return plane.toGeodetic({ e: this.dynamics.state.east, n: this.dynamics.state.north });
  }

  step(plane: TangentPlane, env: EnvironmentConditions, dt: Seconds, simTime: SimTime): void {
    const demand = this._controller.update({
      simTime,
      dt,
      state: this.dynamics.state,
      position: this.position(plane),
      plane,
      propulsion: this.dynamics.propulsion,
      environment: env,
      courseOverGround: this.dynamics.courseOverGround(env),
      speedOverGround: this.dynamics.speedOverGround(env),
    });
    this.dynamics.step(demand, env, dt, simTime);
  }

  toWorldObject(plane: TangentPlane, env: EnvironmentConditions): WorldObject {
    const { particulars, seakeeping } = this.dynamics;
    const dimensions: ObjectDimensions = {
      loa: particulars.loa,
      beam: particulars.beam,
      draught: particulars.draught,
    };
    return {
      id: this.id,
      kind: this.kind,
      source: 'simulated',
      position: this.position(plane),
      heading: this.dynamics.state.heading,
      cog: this.dynamics.courseOverGround(env),
      sog: this.dynamics.speedOverGround(env),
      rateOfTurn: this.dynamics.state.r,
      identity: this.identity,
      dimensions,
      attitude: {
        roll: seakeeping.rollRadians,
        pitch: seakeeping.pitchRadians,
        heave: seakeeping.heaveMetres,
      },
      actuators: this.dynamics.propulsion.telemetry(),
    };
  }
}

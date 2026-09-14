import { useCallback, useEffect, useRef, useState } from 'react';
import { degrees, knots, type EntityId } from '@umami/core';
import {
  AutopilotController,
  courseTrimRateFor,
  gainsForClass,
  loadScenario,
  type ScenarioDefinition,
  type WorldSnapshot,
} from '@umami/sim';
import type { VesselClassId } from '@umami/dynamics';
import type { World } from '@umami/sim';

/** How often to drop contacts that have stopped reporting. */
const PRUNE_INTERVAL_MS = 30_000;

/**
 * Runs the simulation in the browser and exposes its state to React.
 *
 * The simulation is driven from `requestAnimationFrame` but does not step once
 * per frame: the clock converts elapsed wall time into a whole number of fixed
 * steps, so a phone at 30 fps and a desktop at 144 fps produce exactly the same
 * trajectory. React sees a snapshot at a fixed display rate rather than on
 * every step, because re-rendering at 10 Hz when the chart only needs 4 is how
 * a mobile browser ends up dropping frames.
 */
export interface SimulationHandle {
  /** The running world, for subsystems that attach to it such as live AIS. */
  readonly world: World | undefined;
  readonly snapshot: WorldSnapshot | undefined;
  readonly timeScale: number;
  readonly paused: boolean;
  setTimeScale(scale: number): void;
  togglePause(): void;
  spawnGhost(position: { lat: number; lon: number }, vesselClass: VesselClassId): string;
  removeObject(id: string): void;
  commandGhost(id: string, courseDegrees: number, speedKnots: number): void;
  commandOwnShip(courseDegrees: number, speedKnots: number): void;
}

export function useSimulation(
  definition: ScenarioDefinition,
  displayRateHz = 8,
): SimulationHandle {
  const worldRef = useRef<World | null>(null);
  const [snapshot, setSnapshot] = useState<WorldSnapshot | undefined>(undefined);
  const [timeScale, setTimeScaleState] = useState(1);
  const [paused, setPaused] = useState(false);
  const beforePauseRef = useRef(1);

  if (worldRef.current === null) {
    worldRef.current = loadScenario(definition).world;
  }

  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;

    let frame = 0;
    let lastFrameMs = performance.now();
    let lastPublishMs = 0;
    let lastPruneMs = 0;
    const publishInterval = 1000 / displayRateHz;

    const tick = (nowMs: number): void => {
      frame = requestAnimationFrame(tick);

      const elapsedSeconds = Math.min((nowMs - lastFrameMs) / 1000, 0.5);
      lastFrameMs = nowMs;

      // Fixed steps, however long the frame took. A tab that was backgrounded
      // slips behind real time rather than replaying minutes of backlog.
      const steps = world.clock.stepsForElapsed(elapsedSeconds);
      for (let i = 0; i < steps; i++) world.step();

      if (nowMs - lastPublishMs >= publishInterval) {
        lastPublishMs = nowMs;
        setSnapshot(world.snapshot());

        // Forget contacts that have gone quiet. Done here rather than every
        // step because it walks every track, and a contact going stale is a
        // matter of minutes.
        if (nowMs - lastPruneMs >= PRUNE_INTERVAL_MS) {
          lastPruneMs = nowMs;
          world.pruneTracks();
        }
      }
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [displayRateHz]);

  const setTimeScale = useCallback((scale: number) => {
    const world = worldRef.current;
    if (!world) return;
    world.clock.timeScale = scale;
    setTimeScaleState(scale);
    setPaused(scale === 0);
    if (scale > 0) beforePauseRef.current = scale;
  }, []);

  const togglePause = useCallback(() => {
    setTimeScale(paused ? beforePauseRef.current : 0);
  }, [paused, setTimeScale]);

  const spawnGhost = useCallback(
    (position: { lat: number; lon: number }, vesselClass: VesselClassId): string => {
      const world = worldRef.current;
      if (!world) return '';
      const ghost = world.spawnGhost({
        position,
        vesselClass,
        heading: degrees(0),
        speed: knots(8),
        name: `GHOST ${vesselClass.toUpperCase()}`,
      });
      // Give it a controller straight away so it holds a course rather than
      // drifting: a ghost that does nothing teaches nothing.
      commandEntity(world, ghost.id, vesselClass, 0, 8);
      return ghost.id;
    },
    [],
  );

  const removeObject = useCallback((id: string) => {
    worldRef.current?.removeEntity(id as EntityId);
  }, []);

  const commandGhost = useCallback(
    (id: string, courseDegrees: number, speedKnots: number) => {
      const world = worldRef.current;
      const entity = world?.getEntity(id as EntityId);
      if (!world || !entity) return;
      commandEntity(world, entity.id, guessClass(entity.dynamics.particulars.loa), courseDegrees, speedKnots);
    },
    [],
  );

  const commandOwnShip = useCallback((courseDegrees: number, speedKnots: number) => {
    const world = worldRef.current;
    const own = world?.ownShip;
    if (!world || !own) return;
    commandEntity(world, own.id, guessClass(own.dynamics.particulars.loa), courseDegrees, speedKnots);
  }, []);

  return {
    world: worldRef.current ?? undefined,
    snapshot,
    timeScale,
    paused,
    setTimeScale,
    togglePause,
    spawnGhost,
    removeObject,
    commandGhost,
    commandOwnShip,
  };
}

function commandEntity(
  world: ReturnType<typeof loadScenario>['world'],
  id: EntityId,
  vesselClass: VesselClassId,
  courseDegrees: number,
  speedKnots: number,
): void {
  const entity = world.getEntity(id);
  if (!entity) return;
  const gains = gainsForClass(vesselClass, knots(speedKnots || 6));
  const controller = new AutopilotController({
    gains,
    maxSpeed: knots(Math.max(speedKnots * 1.5, 10)),
    followCourse: true,
    courseTrimRate: courseTrimRateFor(gains.model, gains.kp),
  });
  controller.setCourseDemand(degrees(courseDegrees), knots(speedKnots));
  entity.setController(controller);
}

/** Pick a reference class by size, for a vessel whose class was not recorded. */
function guessClass(loa: number): VesselClassId {
  if (loa > 250) return 'container-large';
  if (loa > 140) return 'container-feeder';
  if (loa > 60) return 'general-cargo';
  if (loa > 25) return 'patrol-boat';
  return 'usv-waterjet';
}

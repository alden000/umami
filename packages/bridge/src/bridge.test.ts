import { describe, expect, it } from 'vitest';
import { knots, toDegrees, type EntityId } from '@umami/core';
import { loadScenario } from '@umami/sim';
import { ControlBridge, PROTOCOL_VERSION, type ServerMessage, type StateMessage } from './index.js';

const ORIGIN = { lat: 1.2, lon: 103.8 };

function harness(allowGhostControl = true) {
  const { world } = loadScenario({
    name: 'bridge-test',
    origin: ORIGIN,
    stepSeconds: 0.1,
    ownShip: {
      id: 'usv',
      vesselClass: 'usv-waterjet',
      position: ORIGIN,
      headingDegrees: 0,
      speedKnots: 5,
    },
  });

  const sent: ServerMessage[] = [];
  let clock = 1000;
  const bridge = new ControlBridge(
    { send: (m) => void sent.push(m) },
    {
      world,
      allowGhostControl,
      now: () => clock,
      controllerFactory: () => ({
        gains: { kp: 8, ki: 0, kd: 160 },
        maxSpeed: knots(25),
        yawTimeConstant: 2,
      }),
    },
  );

  const hello = () =>
    bridge.handle({ type: 'hello', protocolVersion: PROTOCOL_VERSION, clientName: 'test' });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { world, bridge, sent, hello, advance };
}

const last = <T extends ServerMessage['type']>(sent: ServerMessage[], type: T) =>
  [...sent].reverse().find((m) => m.type === type);

describe('handshake', () => {
  it('welcomes a client speaking the same protocol version', () => {
    const { sent, hello } = harness();
    hello();
    const welcome = last(sent, 'welcome');
    expect(welcome).toBeDefined();
    expect((welcome as unknown as { ownShipId?: string }).ownShipId).toBe('usv');
  });

  it('refuses a client on an incompatible major version', () => {
    const { sent, bridge } = harness();
    bridge.handle({ type: 'hello', protocolVersion: '99.0' });
    const err = last(sent, 'error') as unknown as { code: string } | undefined;
    expect(err?.code).toBe('protocol-mismatch');
  });

  it('reports both requested control modes as capabilities', () => {
    const { sent, hello } = harness();
    hello();
    const caps = (last(sent, 'welcome') as unknown as { capabilities: string[] }).capabilities;
    expect(caps).toContain('course-speed');
    expect(caps).toContain('waypoint');
  });
});

describe('robustness', () => {
  it('answers malformed input with an error rather than throwing', () => {
    const { sent, bridge } = harness();
    expect(() => bridge.handle('not json at all {')).not.toThrow();
    expect((last(sent, 'error') as unknown as { code: string }).code).toBe('bad-message');
  });

  it('rejects an unknown message type', () => {
    const { sent, bridge, hello } = harness();
    hello();
    bridge.handle({ type: 'launchTorpedoes' });
    expect((last(sent, 'error') as unknown as { code: string }).code).toBe('bad-message');
  });

  it('rejects commands aimed at objects that do not exist', () => {
    const { sent, bridge, hello } = harness();
    hello();
    bridge.handle({
      type: 'setControl',
      objectId: 'nonexistent',
      command: { mode: 'idle' },
    });
    expect((last(sent, 'error') as unknown as { code: string }).code).toBe('unknown-object');
  });
});

describe('control', () => {
  it('drives the USV by course and speed', () => {
    const { world, bridge, hello } = harness();
    hello();
    bridge.handle({
      type: 'setControl',
      command: { mode: 'course-speed', courseDegrees: 90, speedKnots: 12 },
    });
    world.runFor(400);
    const own = world.snapshot().objects[0]!;
    expect(toDegrees(own.cog ?? 0)).toBeCloseTo(90, 0);
  });

  it('drives the USV by waypoints', () => {
    const { world, bridge, hello } = harness();
    hello();
    bridge.handle({
      type: 'setRoute',
      waypoints: [
        { lat: ORIGIN.lat, lon: ORIGIN.lon + 0.02, speedKnots: 12 },
        { lat: ORIGIN.lat + 0.02, lon: ORIGIN.lon + 0.02, speedKnots: 12 },
      ],
    });
    world.runFor(60);
    expect(world.ownShip!.controller.mode).toBe('waypoint');
  });

  it('passes raw actuator demands straight through', () => {
    const { world, bridge, hello } = harness();
    hello();
    bridge.handle({
      type: 'setControl',
      command: { mode: 'actuator', throttle: 0.8, steer: -0.5 },
    });
    world.runFor(20);
    const actuators = world.snapshot().objects[0]!.actuators!;
    // Steering nozzle should have slewed to port.
    expect(actuators.nozzleAngleRad).toBeLessThan(0);
  });

  it('sets the environment in marine units', () => {
    const { world, bridge, hello } = harness();
    hello();
    bridge.handle({ type: 'setEnvironment', currentSetDegrees: 90, currentDriftKnots: 3 });
    expect(world.environment.current.driftSpeed).toBeCloseTo(knots(3), 6);
  });

  it('controls simulation time', () => {
    const { world, bridge, hello } = harness();
    hello();
    bridge.handle({ type: 'setTimeScale', timeScale: 0 });
    expect(world.clock.paused).toBe(true);
  });
});

describe('ghost traffic', () => {
  it('creates a ghost on demand and reports its id', () => {
    const { world, bridge, sent, hello } = harness();
    hello();
    bridge.handle({
      type: 'spawnGhost',
      lat: 1.22,
      lon: 103.82,
      vesselClass: 'container-feeder',
      headingDegrees: 225,
      speedKnots: 10,
      name: 'DROP IN',
    });
    const ack = last(sent, 'ack') as unknown as { objectId?: string };
    expect(ack.objectId).toBeDefined();
    expect(world.getEntity(ack.objectId as EntityId)).toBeDefined();
    expect(world.snapshot().objects).toHaveLength(2);
  });

  it('refuses ghost commands when ghost control is disabled', () => {
    const { sent, bridge, hello } = harness(false);
    hello();
    bridge.handle({ type: 'spawnGhost', lat: 1.22, lon: 103.82 });
    expect((last(sent, 'error') as unknown as { code: string }).code).toBe('not-permitted');
  });
});

describe('state publication', () => {
  it('publishes state in marine units', () => {
    const { bridge, sent, hello, world } = harness();
    hello();
    bridge.handle({ type: 'subscribe', rateHz: 4 });
    world.runFor(10);
    const state = last(sent, 'state') as unknown as StateMessage;
    expect(state.objects[0]!.lat).toBeCloseTo(ORIGIN.lat, 3);
    expect(state.objects[0]!.speedKnots).toBeCloseTo(5, 0);
  });

  it('honours the subscription rate rather than publishing every call', () => {
    const { bridge, sent, hello, advance } = harness();
    hello();
    bridge.handle({ type: 'subscribe', rateHz: 4 }); // 250 ms apart
    const before = sent.filter((m) => m.type === 'state').length;
    bridge.publish();
    bridge.publish();
    expect(sent.filter((m) => m.type === 'state').length).toBe(before);
    advance(300);
    bridge.publish();
    expect(sent.filter((m) => m.type === 'state').length).toBe(before + 1);
  });

  it('answers a ping with the time', () => {
    const { bridge, sent, hello } = harness();
    hello();
    bridge.handle({ type: 'ping', id: 7, sentAt: 123 });
    const pong = last(sent, 'pong') as unknown as { id: number; sentAt: number };
    expect(pong.id).toBe(7);
    expect(pong.sentAt).toBe(123);
  });
});

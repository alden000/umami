import { describe, expect, it } from 'vitest';
import { SimClock } from './time.js';
import { Rng } from './rng.js';

describe('SimClock', () => {
  it('advances by exactly the fixed step', () => {
    const clock = new SimClock({ epoch: 0, stepSeconds: 0.1 });
    for (let i = 0; i < 10; i++) clock.advance();
    expect(clock.time).toBeCloseTo(1.0, 9);
    expect(clock.tick).toBe(10);
  });

  it('converts wall-clock elapsed time into whole steps', () => {
    const clock = new SimClock({ epoch: 0, stepSeconds: 0.1 });
    expect(clock.stepsForElapsed(0.25)).toBe(2);
    // The leftover 0.05 s carries into the next call rather than being lost.
    expect(clock.stepsForElapsed(0.06)).toBe(1);
  });

  it('scales time', () => {
    const clock = new SimClock({ epoch: 0, stepSeconds: 0.1, timeScale: 10 });
    expect(clock.stepsForElapsed(0.1, 100)).toBe(10);
  });

  it('produces no steps while paused', () => {
    const clock = new SimClock({ epoch: 0, stepSeconds: 0.1, timeScale: 0 });
    expect(clock.stepsForElapsed(5)).toBe(0);
    expect(clock.paused).toBe(true);
  });

  it('drops backlog rather than spiralling after a stall', () => {
    const clock = new SimClock({ epoch: 0, stepSeconds: 0.1 });
    expect(clock.stepsForElapsed(60, 20)).toBe(20);
    // Backlog discarded, so the next tick is not still catching up.
    expect(clock.stepsForElapsed(0.1, 20)).toBe(1);
  });
});

describe('Rng', () => {
  it('is reproducible for a given seed', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    const seqA = Array.from({ length: 8 }, () => a.next());
    const seqB = Array.from({ length: 8 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('differs between seeds', () => {
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
  });

  it('forks independent streams', () => {
    const parent = new Rng(7);
    expect(parent.fork(1).next()).not.toBe(parent.fork(2).next());
  });
});

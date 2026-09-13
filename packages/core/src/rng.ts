/**
 * Seeded deterministic RNG (mulberry32).
 *
 * Every stochastic element of the simulation - sensor noise, wave-induced
 * motion, traffic generation - draws from an explicitly seeded stream so a
 * scenario replays identically. Never call Math.random() inside the sim core.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  uniform(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Standard normal via Box-Muller. */
  normal(mean = 0, stdDev = 1): number {
    const u1 = Math.max(Number.EPSILON, this.next());
    const u2 = this.next();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  int(minInclusive: number, maxExclusive: number): number {
    return Math.floor(this.uniform(minInclusive, maxExclusive));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[this.int(0, items.length)] as T;
  }

  /** Derive an independent stream, so adding a subsystem cannot shift others' draws. */
  fork(salt: number): Rng {
    return new Rng((Math.imul(this.state, 0x9e3779b1) ^ salt) >>> 0);
  }
}

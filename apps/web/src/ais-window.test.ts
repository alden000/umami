import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WHOLE_WORLD, loadWindow, saveWindow, windowError, formatCorner } from './ais-window.js';

/** Minimal Storage stand-in, with a switch for the throwing case. */
function fakeStorage(): Storage & { fail: boolean } {
  const entries = new Map<string, string>();
  const store = {
    fail: false,
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    key: (i: number) => [...entries.keys()][i] ?? null,
    getItem(k: string) {
      if (store.fail) throw new Error('blocked');
      return entries.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      if (store.fail) throw new Error('blocked');
      entries.set(k, v);
    },
    removeItem: (k: string) => void entries.delete(k),
  };
  return store as unknown as Storage & { fail: boolean };
}

let storage: ReturnType<typeof fakeStorage>;

beforeEach(() => {
  storage = fakeStorage();
  vi.stubGlobal('localStorage', storage);
});

const SINGAPORE = { north: 1.5824335, west: 103.2699253, south: 1.0733847, east: 104.829992 };

describe('validation', () => {
  it('accepts an ordinary box', () => {
    expect(windowError(SINGAPORE)).toBeUndefined();
  });

  it('accepts the whole world', () => {
    expect(windowError(WHOLE_WORLD)).toBeUndefined();
  });

  it('accepts west greater than east, which spans the antimeridian', () => {
    // Not a transposition: isInsideBoundingBox reads this as a box across 180.
    expect(windowError({ north: 60, south: 50, west: 170, east: -170 })).toBeUndefined();
  });

  it('rejects a transposed north and south', () => {
    expect(windowError({ ...SINGAPORE, north: 1, south: 2 })).toMatch(/North must be greater/);
  });

  it('rejects a latitude typed where a longitude belongs', () => {
    expect(windowError({ ...SINGAPORE, north: 103 })).toMatch(/Latitude must be/);
  });

  it('rejects an out-of-range longitude', () => {
    expect(windowError({ ...SINGAPORE, east: 181 })).toMatch(/Longitude must be/);
  });

  it('rejects a corner that is not a number', () => {
    expect(windowError({ ...SINGAPORE, west: NaN })).toMatch(/must be numbers/);
  });
});

describe('persistence', () => {
  it('defaults to the whole world on a first load', () => {
    // An operator who has not said what they care about is better served seeing
    // traffic and narrowing down than by an empty chart they have to diagnose.
    expect(loadWindow()).toEqual(WHOLE_WORLD);
  });

  it('restores what was last saved', () => {
    saveWindow(SINGAPORE);
    expect(loadWindow()).toEqual(SINGAPORE);
  });

  it('falls back when the stored value is malformed', () => {
    storage.setItem('umami.aisstream.window', 'not json');
    expect(loadWindow()).toEqual(WHOLE_WORLD);
  });

  it('falls back when the stored box would not be accepted from the keyboard', () => {
    // Written by an older build, or edited by hand. Stored data is input too.
    storage.setItem(
      'umami.aisstream.window',
      JSON.stringify({ north: 1, south: 2, west: 0, east: 1 }),
    );
    expect(loadWindow()).toEqual(WHOLE_WORLD);
  });

  it('falls back when a corner is missing', () => {
    storage.setItem('umami.aisstream.window', JSON.stringify({ north: 2, south: 1 }));
    expect(loadWindow()).toEqual(WHOLE_WORLD);
  });

  it('survives storage being blocked, as in a private window', () => {
    storage.fail = true;
    expect(() => saveWindow(SINGAPORE)).not.toThrow();
    expect(loadWindow()).toEqual(WHOLE_WORLD);
  });
});

describe('formatting', () => {
  it('writes a corner the way a chart does', () => {
    expect(formatCorner(1.5824335, 103.2699253)).toBe('1.5824°N 103.2699°E');
    expect(formatCorner(-33.86, -151.2)).toBe('33.8600°S 151.2000°W');
  });
});

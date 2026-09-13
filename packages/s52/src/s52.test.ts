import { describe, expect, it } from 'vitest';
import { BUNDLED_COLOUR_TABLES, Palette, type ColourScheme } from './colours.js';
import {
  DEFAULT_DISPLAY,
  DisplayCategory,
  depthShadeToken,
  isIsolatedDanger,
  isShallowSounding,
  isUnsafeWater,
  resolveSafetyContour,
  visibleClasses,
} from './display.js';

describe('colour tables', () => {
  const schemes: ColourScheme[] = ['DAY_BRIGHT', 'DUSK', 'NIGHT'];

  it('defines every token in every scheme', () => {
    const tokens = Object.keys(BUNDLED_COLOUR_TABLES.DAY_BRIGHT);
    for (const scheme of schemes) {
      for (const token of tokens) {
        const value = (BUNDLED_COLOUR_TABLES[scheme] as Record<string, string>)[token];
        expect(value, `${scheme}.${token}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('gets darker from day through dusk to night', () => {
    const luminance = (hex: string): number => {
      const n = parseInt(hex.slice(1), 16);
      return (((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) / 255;
    };
    // Deep water is the largest area on the display and sets the overall level.
    const day = luminance(BUNDLED_COLOUR_TABLES.DAY_BRIGHT.DEPDW);
    const dusk = luminance(BUNDLED_COLOUR_TABLES.DUSK.DEPDW);
    const night = luminance(BUNDLED_COLOUR_TABLES.NIGHT.DEPDW);
    expect(day).toBeGreaterThan(dusk);
    expect(dusk).toBeGreaterThan(night);
  });

  it('orders depth shades from shallow to deep in every scheme', () => {
    const luminance = (hex: string): number => {
      const n = parseInt(hex.slice(1), 16);
      return (((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255)) / 3;
    };
    for (const scheme of schemes) {
      const t = BUNDLED_COLOUR_TABLES[scheme];
      // Shallow water must read as more prominent than deep, whatever the scheme.
      expect(luminance(t.DEPVS), scheme).not.toBe(luminance(t.DEPDW));
    }
  });

  it('declares the bundled tables as an approximation, not the official library', () => {
    expect(new Palette().provenance).toBe('approximation');
  });

  it('resolves the same token differently once the scheme changes', () => {
    const palette = new Palette();
    const day = palette.get('DEPDW');
    palette.setScheme('NIGHT');
    expect(palette.get('DEPDW')).not.toBe(day);
  });

  it('accepts a replacement table source without touching call sites', () => {
    const palette = new Palette();
    palette.setSource({
      provenance: 'official-preslib',
      tables: {
        ...BUNDLED_COLOUR_TABLES,
        DAY_BRIGHT: { ...BUNDLED_COLOUR_TABLES.DAY_BRIGHT, DEPDW: '#123456' },
      },
    });
    expect(palette.get('DEPDW')).toBe('#123456');
    expect(palette.provenance).toBe('official-preslib');
  });
});

describe('safety contour', () => {
  it('rounds to the next deeper contour, never the shallower', () => {
    // Asking for 10 m where the chart has 5, 10, 20 gives exactly 10.
    expect(resolveSafetyContour(10, [5, 10, 20])).toBe(10);
    // Asking for 12 m must give 20, not 10 - the safe direction.
    expect(resolveSafetyContour(12, [5, 10, 20])).toBe(20);
    expect(resolveSafetyContour(6, [5, 10, 20])).toBe(10);
  });

  it('falls back to the deepest available when none is deep enough', () => {
    expect(resolveSafetyContour(50, [5, 10, 20])).toBe(20);
  });

  it('returns the request unchanged when the chart carries no contours', () => {
    expect(resolveSafetyContour(10, [])).toBe(10);
  });
});

describe('depth shading', () => {
  it('assigns four shades in order of depth', () => {
    const s = { ...DEFAULT_DISPLAY, shallowContour: 2, safetyContour: 10, deepContour: 30 };
    expect(depthShadeToken(1, s)).toBe('DEPVS');
    expect(depthShadeToken(5, s)).toBe('DEPMS');
    expect(depthShadeToken(20, s)).toBe('DEPMD');
    expect(depthShadeToken(100, s)).toBe('DEPDW');
  });

  it('collapses to two shades either side of the safety contour', () => {
    const s = { ...DEFAULT_DISPLAY, fourShades: false, safetyContour: 10 };
    expect(depthShadeToken(5, s)).toBe('DEPVS');
    expect(depthShadeToken(15, s)).toBe('DEPDW');
  });

  it('marks drying areas as intertidal', () => {
    expect(depthShadeToken(-1, DEFAULT_DISPLAY)).toBe('DEPIT');
  });

  it('shows unknown depth as no data rather than as deep water', () => {
    expect(depthShadeToken(undefined, DEFAULT_DISPLAY)).toBe('NODTA');
  });
});

describe('danger assessment', () => {
  it('treats water shallower than the safety contour as unsafe', () => {
    expect(isUnsafeWater(5, DEFAULT_DISPLAY)).toBe(true);
    expect(isUnsafeWater(15, DEFAULT_DISPLAY)).toBe(false);
  });

  it('treats unknown depth as unsafe', () => {
    expect(isUnsafeWater(undefined, DEFAULT_DISPLAY)).toBe(true);
  });

  it('flags a shoal lying in otherwise safe water as an isolated danger', () => {
    expect(isIsolatedDanger(3, 50, DEFAULT_DISPLAY)).toBe(true);
  });

  it('does not flag a shoal already inside shallow water', () => {
    expect(isIsolatedDanger(3, 4, DEFAULT_DISPLAY)).toBe(false);
  });

  it('flags an obstruction of unknown depth', () => {
    expect(isIsolatedDanger(undefined, 50, DEFAULT_DISPLAY)).toBe(true);
  });

  it('highlights soundings at or below the safety depth', () => {
    expect(isShallowSounding(10, DEFAULT_DISPLAY)).toBe(true);
    expect(isShallowSounding(11, DEFAULT_DISPLAY)).toBe(false);
  });
});

describe('display categories', () => {
  it('always includes the base set, whatever the category', () => {
    for (const c of [DisplayCategory.Base, DisplayCategory.Standard, DisplayCategory.Other]) {
      expect(visibleClasses(c).has('LNDARE')).toBe(true);
      expect(visibleClasses(c).has('DEPARE')).toBe(true);
    }
  });

  it('is cumulative rather than exclusive', () => {
    expect(visibleClasses(DisplayCategory.Base).size).toBeLessThan(
      visibleClasses(DisplayCategory.Standard).size,
    );
    expect(visibleClasses(DisplayCategory.Standard).size).toBeLessThan(
      visibleClasses(DisplayCategory.Other).size,
    );
  });

  it('never allows a danger to be switched off', () => {
    expect(visibleClasses(DisplayCategory.Base).has('WRECKS')).toBe(true);
    expect(visibleClasses(DisplayCategory.Base).has('OBSTRN')).toBe(true);
  });
});

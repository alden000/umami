import type { ColourToken } from './colours.js';

/**
 * S-52 display settings.
 *
 * The safety contour is the single most consequential setting on an ECDIS and
 * the reason this module exists at all. It divides the chart into water the
 * vessel may enter and water it may not, drives the two- or four-shade depth
 * colouring, and determines what counts as an isolated danger. A USV inherits
 * exactly the same question, and answering it badly is how vessels ground.
 */
export interface DisplaySettings {
  /**
   * Safety contour, metres. The boundary between safe and unsafe water.
   *
   * S-52 requires that if no contour with this exact value exists in the
   * chart, the next DEEPER available contour is used - never the shallower
   * one. Rounding the safe way is the whole point: a vessel must not be shown
   * water as navigable because the chart lacked the contour it asked for.
   */
  readonly safetyContour: number;
  /** Soundings at or below this are highlighted, metres. */
  readonly safetyDepth: number;
  /** Shallow pattern boundary, metres. */
  readonly shallowContour: number;
  /** Deep water boundary, metres. */
  readonly deepContour: number;
  /** Four shades of depth rather than two. */
  readonly fourShades: boolean;
  /** Fill shallow water with a pattern as well as a colour, for colour-blind users. */
  readonly shallowPattern: boolean;
  /** Base, standard or all. See `DisplayCategory`. */
  readonly category: DisplayCategory;
  /** Draw light sectors and arcs. */
  readonly showLightSectors: boolean;
  /** Show the vessel to scale rather than as a symbol, above a zoom threshold. */
  readonly scaledOwnShip: boolean;
}

/**
 * S-52 display categories.
 *
 * `Base` cannot be switched off - it is the minimum an ECDIS must always show,
 * and it exists so that no configuration can hide the coastline or a danger.
 */
export enum DisplayCategory {
  Base = 'base',
  Standard = 'standard',
  Other = 'other',
}

export const DEFAULT_DISPLAY: DisplaySettings = {
  safetyContour: 10,
  safetyDepth: 10,
  shallowContour: 2,
  deepContour: 30,
  fourShades: true,
  shallowPattern: false,
  category: DisplayCategory.Standard,
  showLightSectors: true,
  scaledOwnShip: true,
};

/**
 * Choose the contour to use as the safety contour from those the chart carries.
 *
 * Returns the shallowest available contour that is at least the requested
 * depth; if none is that deep, the deepest available. Never returns a contour
 * shallower than requested when a deeper one exists - see `DisplaySettings`.
 */
export function resolveSafetyContour(
  requested: number,
  availableContours: readonly number[],
): number {
  if (availableContours.length === 0) return requested;
  const sorted = [...availableContours].sort((a, b) => a - b);
  return sorted.find((d) => d >= requested) ?? (sorted[sorted.length - 1] as number);
}

/** Which depth band a depth area falls into, as a colour token. */
export function depthShadeToken(
  drval1: number | undefined,
  settings: DisplaySettings,
): ColourToken {
  // DRVAL1 is the shallowest depth in the area; an area with no DRVAL1 is
  // treated as unsurveyed, which is not the same as deep.
  if (drval1 === undefined) return 'NODTA';
  if (drval1 < 0) return 'DEPIT'; // intertidal, dries
  if (!settings.fourShades) {
    return drval1 < settings.safetyContour ? 'DEPVS' : 'DEPDW';
  }
  if (drval1 < settings.shallowContour) return 'DEPVS';
  if (drval1 < settings.safetyContour) return 'DEPMS';
  if (drval1 < settings.deepContour) return 'DEPMD';
  return 'DEPDW';
}

/**
 * True when a depth area is unsafe for the configured safety contour.
 *
 * Deliberately strict: an area whose shallowest depth is unknown counts as
 * unsafe. Treating unknown as safe is how a route planner sends a vessel
 * through an unsurveyed patch.
 */
export function isUnsafeWater(drval1: number | undefined, settings: DisplaySettings): boolean {
  return drval1 === undefined || drval1 < settings.safetyContour;
}

/**
 * Whether a sounding should be shown highlighted.
 *
 * S-52 draws soundings at or shallower than the safety depth in a heavier
 * style so a shoal patch reads at a glance rather than needing to be read.
 */
export function isShallowSounding(valsou: number, settings: DisplaySettings): boolean {
  return valsou <= settings.safetyDepth;
}

/**
 * Whether an obstruction must carry the isolated danger symbol.
 *
 * Applies to wrecks, rocks and obstructions lying in water the vessel would
 * otherwise treat as navigable. An isolated danger in deep water is far more
 * dangerous than the same object in water already marked unsafe, which is why
 * S-52 singles it out with its own symbol rather than a depth shade.
 */
export function isIsolatedDanger(
  valsou: number | undefined,
  surroundingDepth: number | undefined,
  settings: DisplaySettings,
): boolean {
  if (valsou === undefined) return true; // depth unknown: assume the worst
  if (valsou >= settings.safetyContour) return false; // not a danger at this setting
  // Dangerous, and sitting in water the mariner is treating as safe.
  return surroundingDepth === undefined || surroundingDepth >= settings.safetyContour;
}

/** Object classes each display category includes. */
export const CATEGORY_CLASSES: Readonly<Record<DisplayCategory, readonly string[]>> = {
  [DisplayCategory.Base]: [
    'LNDARE',
    'COALNE',
    'DEPARE',
    'DEPCNT',
    'OBSTRN',
    'WRECKS',
    'UWTROC',
    'SLCONS',
    'UNSARE',
    'M_COVR',
  ],
  [DisplayCategory.Standard]: [
    'BOYLAT',
    'BOYCAR',
    'BOYISD',
    'BOYSAW',
    'BOYSPP',
    'BCNLAT',
    'BCNCAR',
    'BCNISD',
    'BCNSAW',
    'BCNSPP',
    'LIGHTS',
    'DAYMAR',
    'TSSLPT',
    'TSEZNE',
    'TSSBND',
    'TSELNE',
    'DWRTPT',
    'FAIRWY',
    'ACHARE',
    'RESARE',
    'CTNARE',
    'PRCARE',
    'BRIDGE',
    'CBLOHD',
    'DRGARE',
    'MORFAC',
    'PONTON',
    'HULKES',
    'PILPNT',
  ],
  [DisplayCategory.Other]: [
    'SOUNDG',
    'LNDMRK',
    'BUAARE',
    'MIPARE',
    'PIPSOL',
    'CBLSUB',
    'FLODOC',
    'M_QUAL',
    'M_NSYS',
  ],
};

/** Object classes visible at a given display category. Cumulative, as S-52 requires. */
export function visibleClasses(category: DisplayCategory): Set<string> {
  const out = new Set(CATEGORY_CLASSES[DisplayCategory.Base]);
  if (category === DisplayCategory.Base) return out;
  for (const c of CATEGORY_CLASSES[DisplayCategory.Standard]) out.add(c);
  if (category === DisplayCategory.Standard) return out;
  for (const c of CATEGORY_CLASSES[DisplayCategory.Other]) out.add(c);
  return out;
}

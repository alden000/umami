import type { AisBoundingBox } from '@umami/ais';

/**
 * The AIS area of interest: what is asked of the provider, and how it is
 * remembered between sessions.
 *
 * Kept apart from the React components because both the hook that persists it
 * and the panel that edits it need the same notion of what a valid box is.
 * A window that is merely *plausible* is not enough - a transposed corner or a
 * latitude typed where a longitude belongs produces a subscription that
 * silently returns nothing, which is indistinguishable from an area with no
 * traffic.
 */

/**
 * The whole world, which is also what the provider falls back to when asked for
 * nothing. The right default for a first load: an operator who has not yet said
 * what they care about is better served by seeing traffic and narrowing down
 * than by an empty chart they have to diagnose.
 */
export const WHOLE_WORLD: AisBoundingBox = { south: -90, west: -180, north: 90, east: 180 };

const STORAGE_KEY = 'umami.aisstream.window';

/**
 * Why a box can't be used, or undefined if it can.
 *
 * West greater than east is *not* an error: that is how a box spanning the
 * antimeridian is written, and `isInsideBoundingBox` reads it that way.
 */
export function windowError(box: AisBoundingBox): string | undefined {
  const values = [box.north, box.south, box.west, box.east];
  if (!values.every(Number.isFinite)) return 'All four corners must be numbers.';
  if (Math.abs(box.north) > 90 || Math.abs(box.south) > 90) {
    return 'Latitude must be between -90 and 90.';
  }
  if (Math.abs(box.west) > 180 || Math.abs(box.east) > 180) {
    return 'Longitude must be between -180 and 180.';
  }
  if (box.north <= box.south) return 'North must be greater than south.';
  return undefined;
}

/** The remembered window, or the whole world if there is nothing usable stored. */
export function loadWindow(): AisBoundingBox {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    // Private windows and blocked site data both throw. Not remembering is a
    // normal state, not a failure.
    return WHOLE_WORLD;
  }
  if (!raw) return WHOLE_WORLD;

  try {
    const parsed = JSON.parse(raw) as Partial<AisBoundingBox>;
    const box: AisBoundingBox = {
      north: Number(parsed.north),
      south: Number(parsed.south),
      west: Number(parsed.west),
      east: Number(parsed.east),
    };
    // Stored data is input like any other. A box written by an older build, or
    // edited by hand, must not be able to produce a subscription this app would
    // refuse to let anyone type.
    return windowError(box) ? WHOLE_WORLD : box;
  } catch {
    return WHOLE_WORLD;
  }
}

export function saveWindow(box: AisBoundingBox): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(box));
  } catch {
    // Not being able to remember it is an inconvenience, not a failure; the
    // session still works with what was typed.
  }
}

/** One corner, as a mariner would write it. */
export function formatCorner(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}°${ns} ${Math.abs(lon).toFixed(4)}°${ew}`;
}

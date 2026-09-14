import { useEffect, useRef, useState } from 'react';
import type { AisBoundingBox } from '@umami/ais';
import { WHOLE_WORLD, windowError } from './ais-window.js';

/**
 * Editor for the AIS area of interest.
 *
 * Fields are held as text rather than numbers while they are being typed. A
 * numeric input that reparses on every keystroke cannot be edited: deleting the
 * last digit of `10` leaves `1`, a lone `-` is not a number, and `103.` is not
 * yet `103.5`. The box is committed only when all four corners parse into
 * something usable, and what is wrong is said plainly meanwhile.
 *
 * That is only half of it. A committed box comes straight back as a new
 * `value`, and rewriting the fields from it would undo the typing that caused
 * it - `103.` parses to 103, so the dot would vanish from under the cursor and
 * the next keystroke would give `1035`. So the value is only written back into
 * the fields when it changed somewhere *else*: the reset button, or a window
 * restored from a previous session. An echo of this component's own edit is
 * left alone.
 */
export interface AisWindowEditorProps {
  readonly value: AisBoundingBox;
  readonly onChange: (window: AisBoundingBox) => void;
  /** Shown as a hint, since a live connection follows an edit immediately. */
  readonly live: boolean;
}

type Draft = Record<keyof AisBoundingBox, string>;

const CORNERS: { key: keyof AisBoundingBox; label: string; hint: string }[] = [
  { key: 'north', label: 'N', hint: 'Northern latitude, -90 to 90' },
  { key: 'south', label: 'S', hint: 'Southern latitude, -90 to 90' },
  { key: 'west', label: 'W', hint: 'Western longitude, -180 to 180' },
  { key: 'east', label: 'E', hint: 'Eastern longitude, -180 to 180' },
];

function toDraft(box: AisBoundingBox): Draft {
  return {
    north: String(box.north),
    south: String(box.south),
    west: String(box.west),
    east: String(box.east),
  };
}

function parse(draft: Draft): AisBoundingBox {
  const num = (text: string): number => (text.trim() === '' ? NaN : Number(text));
  return {
    north: num(draft.north),
    south: num(draft.south),
    west: num(draft.west),
    east: num(draft.east),
  };
}

function sameBox(a: AisBoundingBox, b: AisBoundingBox): boolean {
  return a.north === b.north && a.south === b.south && a.west === b.west && a.east === b.east;
}

export function AisWindowEditor({ value, onChange, live }: AisWindowEditorProps): JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => toDraft(value));
  // The last box this editor emitted, so its own echo can be told apart from a
  // change made elsewhere.
  const emitted = useRef<AisBoundingBox>(value);

  useEffect(() => {
    if (sameBox(value, emitted.current)) return;
    emitted.current = value;
    setDraft(toDraft(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.north, value.south, value.west, value.east]);

  const edit = (key: keyof AisBoundingBox, text: string): void => {
    const next = { ...draft, [key]: text };
    setDraft(next);
    const box = parse(next);
    if (windowError(box)) return;
    emitted.current = box;
    onChange(box);
  };

  const error = windowError(parse(draft));
  const crossesAntimeridian = !error && parse(draft).west > parse(draft).east;

  return (
    <div className="ais-window">
      <div className="ais-window-fields">
        {CORNERS.map(({ key, label, hint }) => (
          <label key={key} className="ais-corner" title={hint}>
            <span>{label}</span>
            <input
              type="text"
              inputMode="decimal"
              value={draft[key]}
              onChange={(e) => edit(key, e.target.value)}
              spellCheck={false}
              data-testid={`ais-window-${key}`}
            />
          </label>
        ))}
        <button
          onClick={() => onChange(WHOLE_WORLD)}
          title="Subscribe to the whole world"
          data-testid="ais-window-reset"
        >
          World
        </button>
      </div>
      {error && (
        <div className="warning" data-testid="ais-window-error">
          {error} Not applied.
        </div>
      )}
      {crossesAntimeridian && (
        <div className="ais-note">
          West is east of east &mdash; read as a box spanning the antimeridian.
        </div>
      )}
      {!error && live && (
        <div className="ais-note">Applied to the live subscription.</div>
      )}
    </div>
  );
}

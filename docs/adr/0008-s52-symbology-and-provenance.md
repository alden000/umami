# ADR 0008 — S-52 colours are loadable data, and the bundled ones are an approximation

**Status:** accepted · **Date:** 2026-09-13

## Context

"Colors, symbols and look and feel should follow IHO and industry standards for
ECDIS display." The authoritative source is the IHO S-52 Presentation Library,
which is a controlled publication. Reproducing its tables from memory would be
both inaccurate and a misrepresentation.

## Decision

Colours are loaded through a `ColourTableSource`, never compiled in. Three
schemes ship — `DAY_BRIGHT`, `DUSK`, `NIGHT` — as an **approximation**, and the
API says so: `Palette.provenance` returns `"approximation"`.

Every colour in the system resolves by token (`DEPDW`, `LANDA`, `ISDNG`), never
by literal. A hex value anywhere outside `@umami/s52` is a bug.

## Consequences

Good: an operator holding the official Presentation Library replaces the source
and the entire display — chart, symbols, interface chrome — changes
consistently, with no other edit. The same mechanism serves a customer's own
tables.

Good: honest. The approximation is close enough that the display reads
correctly to a mariner and the intended contrasts hold, and it is clearly
labelled as unsuitable for a type-approved ECDIS.

Good: the three schemes are not decorative. Bridge lighting at night is a
safety matter — a display at day brightness destroys dark adaptation for
twenty minutes — which is why `NIGHT` is dark overall with the critical marks
still legible, and why the interface chrome follows the same schemes.

Bad: symbols are not yet drawn. Buoys, beacons, lights and topmarks need a
symbol set, and the official one has the same licensing position as the colour
tables. The architecture is ready; the artwork is not.

Bad: an approximation cannot be certified. Deliberate — this is a development
and testing environment, not a navigation system, and it should not be mistaken
for one.

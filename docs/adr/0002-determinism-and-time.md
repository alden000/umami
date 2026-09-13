# ADR 0002 — Fixed-step clock, decoupled from wall time

**Status:** accepted · **Date:** 2026-09-13

## Context

A simulator used to justify confidence in a control algorithm must reproduce a
failure exactly, or the failure cannot be investigated. It must also run at
interactive rates on a phone and far faster than real time in batch — without
those being different code paths, since a result obtained one way has to be
valid for the other.

## Decision

A fixed-step simulation clock (`SimClock`, default 10 Hz) that is the only
thing that advances simulation time. Renderers convert elapsed wall time into a
whole number of fixed steps; batch runs call `step()` in a loop. All randomness
comes from a seeded `Rng`. Nothing in the core reads the wall clock.

After a stall — a backgrounded tab, a slow frame — the clock **drops** backlog
rather than replaying it, bounded by `maxSteps`.

## Consequences

Good: identical results at 30 fps on a phone, 144 fps on a desktop, and flat
out in CI. Determinism is asserted by test, not assumed. Time scaling (pause,
1×, 60×) is a single multiplier with no special cases.

Good: dropping backlog means a stalled tab slips behind real time rather than
freezing while it replays minutes of simulation — the failure mode degrades
gracefully instead of appearing as a hang.

Bad: every consumer must be written against simulation time, and any accidental
`Date.now()` or `Math.random()` in the core silently breaks reproducibility.
Mitigated by convention (§10 of the architecture doc) and by the determinism
tests, which would catch it.

Bad: a fixed 10 Hz step limits the fastest dynamics that can be represented. Ample
for vessel motion; a future actuator or sensor model needing finer resolution
would want sub-stepping rather than a global rate change.

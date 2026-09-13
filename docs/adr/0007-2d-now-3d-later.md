# ADR 0007 — Snapshot boundary, 2D now and 3D later

**Status:** accepted · **Date:** 2026-09-13

## Context

2D is required now; interfacing with 3D visualisation is required later. The
cost of getting this wrong is a core that has grown display assumptions and
must be untangled.

## Decision

The simulation core emits `WorldSnapshot` — plain, JSON-serialisable data — and
knows nothing about how or whether it is displayed. Renderers consume
snapshots. So do recorders, the control bridge, and remote clients.

`WorldSnapshot` carries `attitude` (roll, pitch, heave) from the seakeeping
model, deliberately **not** fed back into the equations of motion, which stay
planar.

## Consequences

Good: a 3D view is a new snapshot consumer, not a change to the core. Because
snapshots are serialisable, it can equally run in another process or on another
machine — which is also how a remote client and a recorder work, for free.

Good: attitude is already available, so a 3D view has vessel motion without the
core growing a six-degree-of-freedom model, and a 2D display can show heel in a
turn today.

Bad: snapshot-per-frame allocates. At the rates involved (a few Hz to the
display, 10 Hz internally, a few hundred objects) this is not measurable. A
future scenario with thousands of contacts would want a diff or a reused
buffer, and the boundary is the right place to add one.

Bad: planar motion means roll is display-only. A USV whose control is affected
by roll — a small craft in a beam sea — is not represented. Moving to 6-DOF
later changes the dynamics package and the attitude fields become real outputs;
the snapshot boundary does not move.

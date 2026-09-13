# ADR 0001 — TypeScript monorepo, web-first delivery

**Status:** accepted · **Date:** 2026-09-13

## Context

The system must run on PC, mobile, tablet and web, display ECDIS-grade
charts with zoom and pan, ingest live AIS, and run a physics model fast enough
to be useful for batch algorithm evaluation.

## Decision

One TypeScript monorepo. MapLibre GL for the chart, React for the interface,
pnpm workspaces. The web client is the primary target; mobile and desktop are
the same client wrapped (Capacitor, Tauri). The simulation core is plain
TypeScript with no DOM dependency, so it also runs headless in Node.

## Alternatives considered

**Flutter/Dart.** Strong native feel and genuinely good cross-platform reach.
Rejected on the charting ecosystem: S-57 ingest, vector tile rendering and
ECDIS symbology would all be hand-built on Canvas, and reusing the sim core in
CI is clumsier.

**Game engine (Unity/Godot).** Best physics and a free path to 3D. Rejected
because ECDIS-grade 2D chart rendering, S-57 ingest and web delivery all become
custom work, and web builds are heavy on mobile — where this has to run.

**Native per platform over a C++/Rust core.** Highest fidelity and performance,
far the highest cost, and the slowest route to something usable. A reasonable
future migration for the dynamics core alone (see Consequences).

## Consequences

Good: one codebase; the richest geospatial ecosystem available; the sim core
runs unchanged in a browser, in CI, and on a server; 3D later is a library
choice (three.js, Cesium, deck.gl) rather than a platform change.

Bad: JavaScript numerics are slower than native. Measured at ~57,000 steps/s
(5,600× real time) for a three-vessel scenario, which is ample for interactive
use and for batch runs in the thousands. If a future workload needs millions of
runs, the dynamics core is the piece to port — it is already isolated behind
`@umami/dynamics` with no dependency on anything above it.

Bad: bundle size. The web client is ~1 MB gzipped-to-283 kB, dominated by
MapLibre. Acceptable for an application; worth code-splitting before it grows.

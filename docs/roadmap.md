# Roadmap

Ordered by what unblocks the most, not by size. Phase 0 is done; everything
below it is sequenced so each phase leaves the system usable.

## Phase 0 — Framework — **done**

Monorepo, core utilities, vessel dynamics with three propulsion types, AIS
ingest, simulation core with the full control stack, external control protocol,
chart data model, S-52 colour and safety logic, headless runner, web client.
121 tests. See `architecture.md`.

## Phase 1 — Make it trustworthy

The open issue and the gaps that would otherwise be built on.

1. **Fix cross-current advection.** A vessel under thrust is not set by a
   current (`architecture.md` §8). Tidal set is central to realistic USV work,
   and everything about station keeping and track keeping sits on top of it.
   *Unskip the covering test in `packages/sim/src/world.test.ts`.*
2. **Gain scheduling with speed.** Gains are tuned at one speed; steering
   authority is speed-dependent for every drive type. Schedule across a speed
   range and interpolate.
3. **Calibrate the USV.** Replace derived coefficients for the own vessel with
   ones fitted to turning-circle and zig-zag trials — real or from a
   higher-fidelity model. This is the vessel whose behaviour conclusions depend
   on.
4. **WebSocket transport for the bridge.** The protocol and server are done and
   tested; this is the thin wrapper that lets external software actually
   connect.

## Phase 2 — Charts on screen

5. ~~**Run a real exchange set through the pipeline** and display it.~~ **Done** —
   verified against NOAA US5NY1CM (New York harbour): 57 layers, 6695 features,
   rendering in day and night schemes. Four pipeline defects found and fixed in
   the process.
6. **S-52 symbols.** Buoys, beacons, lights, topmarks, with IALA A/B taken from
   the chart rather than assumed. Colours are already token-resolved, and the
   features are already in the tiles. To be authored in-house: OpenCPN's set is
   the obvious existing source but is GPL-2+, which was judged the wrong
   dependency for this product.
7. **Chart precedence and scale bands.** Draw the right cell at the right zoom
   and suppress the coarser one beneath it.
8. **Chart queries for the USV.** Depth and hazard lookup through
   `ChartProvider`, so route checking and grounding avoidance can consult the
   same chart the display draws.

## Phase 3 — Reach

9. **Capacitor and Tauri wrappers.** The client is already phone-width clean
   and offline-capable, so these are packaging.
10. **Hosted mode.** Run the core server-side, stream snapshots to thin
    clients. The snapshot boundary already supports it; this is deployment plus
    multi-client session management.
11. **AIS relay.** A small service holding the aisstream.io credential so
    browser clients can consume live AIS without the key shipping in the
    bundle (ADR 0004).

## Phase 4 — Evidence

12. **Scoring and batch evaluation.** CPA distributions, COLREGs compliance,
    track-keeping error, grounding checks — across thousands of scenario
    variations. This is what turns the headless runner from a demo into a
    regression suite, and it is where the tool starts producing evidence rather
    than impressions.
13. **Scenario generation.** Parameterised sweeps over encounter geometry,
    traffic density, and weather.
14. **Recording and replay of full runs.** Snapshots are already serialisable.

## Phase 5 — Fidelity and perception

15. **Sensor models.** Radar with realistic detection and clutter, camera
    frusta, GNSS error. Needed to test perception rather than only control.
16. **6-DOF motion** where it matters. The snapshot boundary does not move;
    `attitude` becomes a real output rather than display-only (ADR 0007).
17. **3D visualisation.** A second snapshot consumer.
18. **S-101 ingest.** A second ingest path writing the same tile schema
    (ADR 0003).

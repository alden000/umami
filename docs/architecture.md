# Architecture

A maritime simulation environment for developing and testing USV algorithms and
AI, on a chart display that follows IHO ECDIS conventions, fed by real or
recorded AIS, running on desktop, mobile, tablet and web.

This document describes the shape of the system and why it has that shape.
Individual decisions are recorded as ADRs in `adr/`; this is the map.

---

## 1. What the system is for

The product is not the simulator. The product is **confidence in a control
algorithm** — evidence that a USV will behave correctly when a laden tanker
holds its course, when the tide sets across a channel, when AIS drops out for
ninety seconds, when a fishing boat alters without warning.

Every structural decision below follows from that, and three consequences are
worth stating up front because they are load-bearing:

**The thing under test must be replaceable.** A control algorithm reaches the
simulation through one narrow interface (§5). It can be TypeScript in the same
process, a Python script over a WebSocket, or a real autopilot on the bench.
The simulation cannot tell the difference, so a result obtained one way is
valid the others.

**Runs must be reproducible.** A failure seen once must be reproducible
exactly, or it cannot be investigated. Hence a fixed time step decoupled from
frame rate, seeded randomness, and no wall-clock dependency anywhere in the
core (ADR 0002).

**Measured behaviour must stay distinguishable from modelled behaviour.** A
real vessel's AIS track is evidence. A simulated vessel's track is a
hypothesis. The system never blurs the two (§4.2).

---

## 2. Shape of the system

```
                        ┌──────────────────────────────────────────┐
                        │            EXTERNAL ALGORITHM            │
                        │  (the thing under test — any language)   │
                        └────────────────────┬─────────────────────┘
                                             │  control protocol
                                             │  (JSON, marine units)
┌────────────────────────────────────────────┼─────────────────────────────┐
│  @umami/bridge                             ▼                             │
│  transport-agnostic: WebSocket · stdio · in-process                      │
└────────────────────────────────────────────┬─────────────────────────────┘
                                             │  ActuatorDemand
┌────────────────────────────────────────────▼─────────────────────────────┐
│  @umami/sim          THE SIMULATION CORE — headless, deterministic       │
│                                                                           │
│   World ── fixed-step clock ── entities ── environment ── tangent plane   │
│     │                                                                     │
│     ├── simulated vessels (own USV, ghost targets)  ← integrated          │
│     ├── AIS contacts                                ← observed only       │
│     └── control stack: actuator ▸ heading ▸ course ▸ waypoint ▸ station   │
│                                                                           │
│                          emits ── WorldSnapshot ──▶ (plain JSON)          │
└───────┬───────────────────────────────────────────────────┬──────────────┘
        │                                                   │
┌───────▼──────────────┐  ┌──────────────────┐   ┌──────────▼──────────────┐
│  @umami/dynamics     │  │  @umami/ais      │   │  RENDERERS              │
│  hull + propulsion   │  │  sources·decode  │   │  2D chart (now)         │
│  waterjet │ shaft    │  │  track manager   │   │  3D view (later)        │
│  outboard│ +rudder   │  │                  │   │  headless (no render)   │
└──────────────────────┘  └──────────────────┘   └──────────┬──────────────┘
                                                            │
                          ┌─────────────────────────────────▼──────────────┐
                          │  @umami/enc (S-57 data) · @umami/s52 (drawing) │
                          └────────────────────────────────────────────────┘

  @umami/core — units, geodesy, fixed-step clock, seeded RNG, event bus
```

### Packages

| Package | Responsibility | Depends on |
|---|---|---|
| `@umami/core` | Units, WGS84 geodesy, tangent plane, simulation clock, seeded RNG, event bus | — |
| `@umami/dynamics` | Hull hydrodynamics, propulsion models, environment forces, vessel library | core |
| `@umami/ais` | AIS model, AIVDM decoder, pluggable sources, track manager | core |
| `@umami/sim` | World, entities, control stack, scenarios, collision assessment | core, dynamics, ais |
| `@umami/enc` | S-57 object model, chart catalogue, chart provider interface | core |
| `@umami/s52` | Colour tables, display settings, safety contour and danger logic | core, enc |
| `@umami/bridge` | External control protocol and server | core, sim |
| `apps/web` | React + MapLibre client — web, and wrapped for mobile, tablet, desktop | all |
| `apps/headless` | Batch/CI runner, no rendering | core, sim, dynamics, ais, bridge |
| `tools/enc-ingest` | Offline S-57 → vector tiles + catalogue pipeline | — (GDAL, tippecanoe) |

The dependency graph is acyclic and the core has no dependencies at all. That
is not tidiness: it is what lets the simulation core run unchanged in a browser
tab, in a Node process in CI, and inside a server driving many clients.

---

## 3. The seams that matter

A framework is defined by where it can be cut. Five seams carry the weight, and
each exists because something specific is expected to change behind it.

### 3.1 Propulsion is separate from the hull

`PropulsionModel` converts actuator demands into body-frame forces; the hull
knows nothing about how it is driven. Three implementations ship: **waterjet**
(the USV default), **shaft-and-rudder**, and **outboard**.

This is not abstraction for its own sake. The distinction that matters is
`steersAtZeroSpeed`:

- A **waterjet** vectors its jet through a steering nozzle. Turning moment is
  proportional to impeller thrust and independent of speed through the water.
  The craft can spin on the spot and hold station against wind and tide with no
  way on. Astern is a reverse bucket dropped into the jet — which also reverses
  the steering force, a fact that has already caused one real bug (§7).
- An **outboard** is also vectored thrust, so it also steers at zero speed —
  but only while driving. Chop the throttle mid-turn and the turning moment
  vanishes. Astern is a gear shift through neutral, taking real time.
- A **shaft-and-rudder** vessel steers by lift on a foil, which scales with the
  square of the flow over it. With no way on there is no steering, beyond the
  weak authority the propeller race provides while the engine turns ahead.

A control algorithm that assumes the wrong one fails precisely where a USV most
needs to be trusted: station keeping, berthing, recovery. Making this a
first-class, queryable property means such an algorithm can branch on it rather
than discover it.

### 3.2 AIS sources are pluggable

`AisSource` is a thin contract: start, stop, emit normalised messages. Provider
specifics — field names, units, capitalisation, rate limits — stop at the
adapter. Shipping now: **aisstream.io** (live WebSocket), **replay** (recorded
JSONL or raw NMEA), and the AIVDM decoder for any receiver producing sentences.

The simulation cannot tell a live feed from a replayed one, which is exactly
the point: the same collision-avoidance code is testable against live traffic,
a replayed incident, and a synthetic scenario without modification. See ADR
0004.

### 3.3 Chart data is separate from chart drawing

S-57 is the data; S-52 is how it is drawn. `@umami/enc` and `@umami/s52` are
separate packages for the same reason the standards are separate documents.
`ChartProvider` is an interface, so charts can come from bundled tiles on a
phone with no network, a tile server ashore, or an in-memory fixture in a test.

This is also the seam that keeps S-57 from being load-bearing. S-101 is coming
and is a different encoding of similar content; when it matters it becomes
another provider and another ingest path, not a rewrite.

Where no ENC covers the area, an optional web basemap can be drawn beneath the
chart — never over it, and never without a standing warning that it carries no
depths. See ADR 0010.

A chart archive can be hosted, or opened from the operator's own disk through
the browser's file API and read in place. The second is not a convenience: it
means a publicly deployed build can display licensed charts that never leave
the machine they are licensed to, which is what makes deploying this to a
public URL defensible at all.

### 3.4 The renderer consumes snapshots, nothing else

The core emits `WorldSnapshot` — plain, JSON-serialisable data — and knows
nothing about how or whether it is displayed. The 2D chart consumes snapshots.
A 3D view will consume the same snapshots. A recorder writes them to a file. A
remote client receives them over a socket. See ADR 0007.

`WorldSnapshot` already carries `attitude` (roll, pitch, heave) computed by the
seakeeping model and deliberately **not** fed back into the equations of
motion, which stay planar. It exists so a 3D view has vessel attitude available
without the core growing a six-degree-of-freedom model.

### 3.5 Control enters at one place, at whatever level suits

Everything — a waypoint route, a course demand, a raw rudder angle — converges
on a single `ActuatorDemand` of `{ throttle, steer }`, both normalised to
−1..1, with starboard positive whatever the drive. An algorithm can therefore
enter the stack at the level it is actually testing (§5).

---

## 4. The simulation core

### 4.1 Time

A fixed-step clock, default 10 Hz, decoupled from frame rate and wall clock
(ADR 0002). The integrator always advances by exactly `stepSeconds`. Renderers
convert elapsed wall time into a whole number of steps; batch runs call `step()`
in a loop. Both produce identical results.

`timeScale` multiplies sim time against wall time: 0 pauses, 1 is real time, 60
compresses an hour into a minute. The headless runner ignores it entirely and
runs flat out — about **5,600× real time** measured, ~57,000 steps/s.

After a stall — a backgrounded tab, a slow frame — the clock drops backlog
rather than replaying it. The simulation slips behind real time instead of
freezing while it tries to catch up.

### 4.2 Three populations, kept distinct

| | Integrated? | Source of truth | Drawn as |
|---|---|---|---|
| Own USV | yes | dynamics model | to scale, own-ship symbol |
| Ghost targets | yes | dynamics model | to scale, distinct colour |
| AIS contacts | **no** | received reports, dead-reckoned between them | target symbol, faded when extrapolated |

AIS contacts are never integrated. Their positions come from reports and are
straight-line dead-reckoned in between, and past a configurable limit they are
dropped from the picture rather than extrapolated further — showing a target
that has not reported for five minutes at a confidently projected position
presents a guess as knowledge.

Smoothing real tracks through a motion model would turn measured behaviour into
modelled behaviour without anyone noticing. That is the most tempting available
mistake here and the one that would most quietly destroy the tool's value.

A contact can be **promoted** to a ghost — taking its reported identity,
dimensions and kinematics as initial conditions and handing it to the dynamics
model. The use case is specific and common: a real vessel on the live feed is
about to do something interesting, and you want to take it over and make it do
something worse.

### 4.3 Vessel dynamics

A 3-DOF manoeuvring model (surge, sway, yaw) in the Fossen formulation,
integrated with RK4 in a local tangent plane that re-anchors when own ship
strays past 50 km. Hydrodynamic derivatives are estimated from principal
particulars via Clarke's (1983) regressions, so **any vessel seen on AIS can be
given type-appropriate motion from length, beam and ship type alone** — which
is what makes a live feed usable as traffic.

It is an estimate, not a towing-tank result. Accuracy is "recognisably right
for the type": a laden VLCC takes over a mile to stop and turns through several
ship lengths; a 12 m USV does neither. Verified by test, not by assertion (§6).

A vessel that matters — the own USV above all — should have measured
coefficients supplied explicitly and its autopilot tuned against them. See ADR
0006 for the fidelity argument and the calibration path.

### 4.4 Control stack

```
  waypoint route ──▶ line-of-sight guidance ──┐
                                              ├──▶ course demand
  course + speed ─────────────────────────────┘        │
                                                       ▼
                                          course loop (slow outer)
                                                       │  heading setpoint
                                                       ▼
  heading + speed ──────────────────────▶  heading autopilot (PID)
                                                       │  steer −1..1
                                                       ▼
  raw actuator ────────────────────────▶     ActuatorDemand
                                                       │
                                                       ▼
                                            propulsion model ──▶ forces
```

Two details are not arbitrary:

**Course is an outer loop, not a re-tuned heading loop.** The response from
helm to course over ground is non-minimum-phase — putting the helm over kicks
the stern out, so the ground track initially swings *opposite* to the bow.
Gains tuned against the heading response go unstable when closed around course.
The course loop therefore trims the heading setpoint at a fraction of the inner
loop's bandwidth.

**Autopilot gains are found by trial, not by formula.** Pole placement on an
identified Nomoto model gets the shape right but omits steering gear slew rate,
the speed a hull loses in a turn, sway-yaw coupling and saturation. Across this
fleet those omissions decide whether a vessel settles or circles indefinitely.
Gains are therefore searched over proportional gain and derivative time, each
candidate scored by flying an actual heading step against the actual dynamics,
and cached per vessel class and speed. All seventeen reference classes settle
exactly on a demanded heading. See ADR 0006.

---

## 5. The external control interface

One protocol, three transports, five modes. Versioned from the start, since an
algorithm may be developed against one revision and run against a later one; a
mismatched major version is refused rather than tolerated.

| Mode | What the client supplies | What it is for |
|---|---|---|
| `waypoint` | route + speeds | mission and route-planning logic |
| `course-speed` | course over ground + speed | guidance laws; the sim owns steering |
| `heading-speed` | heading + speed | as above, without track-keeping |
| `station-keep` | a position | station holding, recovery, loiter |
| `actuator` | throttle + steer, −1..1 | low-level controllers, hardware in the loop |

Clients may also create and drive ghost traffic, set wind, tide and sea state,
and control the clock — so an adversarial scenario can be built by the same
software being tested, which is how you get coverage rather than anecdotes.

Wire units are **marine** (degrees, knots): this is the boundary a human reads
and where an existing autopilot or ground station is most likely adapted in.
Conversion to SI happens once, on entry. Inside the system, SI everywhere — the
sole exception being geodetic positions in decimal degrees.

---

## 6. Verification

**121 tests** across nine test files. What they are for is worth being explicit
about, because tests on a physics model are easy to write and easy to make
meaningless.

- **Physics is checked against behaviour, not against itself.** A container
  ship must reach its service speed at full ahead; a VLCC's turning circle must
  be several times a patrol boat's; a laden tanker must take more than a
  kilometre and more than ten times a USV's distance to crash-stop; a
  high-sided ship must make leeway downwind.
- **The propulsion distinction is tested on the same hull.** Waterjet against
  shaft-and-rudder with identical particulars and identical installed thrust,
  so the test measures the drive rather than the boat. A rudder with the engine
  stopped produces exactly zero turning moment.
- **The AIVDM decoder is checked against real traffic**, not synthetic
  payloads: a Class A report from a vessel moored in Seattle, and a two-part
  type 5 for *EVER DIADEM*, IMO 9134270, bound for New York.
- **Determinism is asserted directly.** The same scenario run twice produces
  bit-identical positions; stepping one at a time and stepping in bulk agree.
- **Safety logic is tested for its safe direction.** The safety contour rounds
  to the next *deeper* contour; unknown depth counts as unsafe; no display
  category can hide a wreck.
- **The web client is verified by running it**, in Chromium at desktop and
  phone widths — which is how both of its rendering bugs were found.
- **The chart pipeline is verified against a real ENC**, not a fixture: a NOAA
  harbour cell (US5NY1CM, New York) through GDAL and tippecanoe and onto the
  screen. Four defects in the pipeline survived code review and died on first
  contact with real data (§7).

---

## 7. What has already been learned

Bugs found during construction, recorded because each says something about the
domain rather than about a typo:

**The Coriolis term had the wrong sign.** It is summed with the other forces, so
it must carry `−C(ν)ν`, not `C(ν)ν`. Every centripetal term in a turn was
inverted. The vessel still turned and still looked plausible — it was the
sway-yaw coupling that was wrong, and it surfaced as course-keeping
instability that read like a badly tuned autopilot.

**Clarke's regressions produce impossible hulls when extrapolated.** A harbour
tug at B/L 0.43 is nothing like the merchant hulls the fit was built on;
evaluating it there returned a *positive* yaw added-mass term, an indefinite
mass matrix, negative inertia, and NaN within seconds. Inputs are now clamped
to the fitted envelope and the matrix is conditioned to be physically
realisable.

**Speed control inverted the steering loop.** The speed controller dipped the
throttle slightly negative to shed a fraction of a knot of overspeed. On a
waterjet that deploys the reverse bucket, which reverses the steering force —
so the control loop inverted and the vessel chased its own tail. Real vessels
shed that overspeed by easing the throttle and letting drag do the work.
Throttle is now floored at zero unless astern is what was actually asked for.

**Absence of data was being drawn as deep water.** The chart background was
`DEPDW`, so anything not covered by a depth area — outside the cell, a coverage
hole, under an unsounded pier — rendered as navigable deep water. S-52 has
`NODTA` for precisely this, and the distinction is the same one the safety
contour logic already makes about unknown soundings: unknown is not safe. With
no ENC at all the display is now honestly blank rather than an empty ocean.

**Directional instability is sometimes the right answer.** An early fix forced
every derived hull to be directionally stable. Large full-form tankers really
*are* course-unstable and really do need continuous helm; "correcting" that
removed one of the more instructive things an algorithm can be tested against.
The correction is now opt-in.

---

## 8. Open issues

**Current does not set a vessel that is under thrust.** With a two-knot beam
current, a vessel making six knots should show course over ground about 19°
off its heading; instead COG tracks heading to within a degree, and steady-state
body sway settles near zero when it should settle at the current's athwartships
component.

Minimal repro: heading-hold on 108° at 6 kn, current setting 000 at 1 kn, run
900 s — the vessel settles on 166° instead of 108°, and the error grows with
drift. It is an equilibrium, not an instability: the vessel is steady and not
sideslipping, which is itself the clue.

The suspect is how current enters the equations. Body velocities are integrated
as ground-referenced while hydrodynamic forces are evaluated against relative
velocity (`VesselDynamics.totalForce`), and a vessel under thrust does not reach
the equilibrium that pairing implies. Drift with no way on is correct — that
test passes — so the error is specific to the powered case.

Covered by a skipped test in `packages/sim/src/world.test.ts` carrying the
intended assertions. **This should be fixed before the environment model is
relied on**, since tidal set is central to most realistic USV work.

---

## 9. What is not built yet

Deliberately, so the shape could be settled first. Roadmap in `roadmap.md`.

- **S-52 point symbols.** Buoys, beacons, lights, daymarks and topmarks are
  ingested and present in the tiles but have no artwork, so they currently draw
  as plain marks. Colours are token-resolved and ready; the symbols are to be
  authored in-house rather than taken from an existing set (see below).
- **Mobile and desktop wrappers.** Capacitor and Tauri shells around the same
  web client. The client is already phone-width clean and offline-capable, and
  deploys to GitHub Pages as a static build.
- **WebSocket transport for the bridge.** The protocol and server exist and are
  tested over an in-process transport; the socket is a thin wrapper (ADR 0005).
- **Sensor models.** Radar, camera and GNSS error models, for testing
  perception rather than control.
- **Scoring.** Automated pass/fail over batch runs — CPA distributions, COLREGs
  compliance, track-keeping error — which is what turns the headless runner
  into a regression suite.

---

## 10. Conventions

- **SI everywhere inside**, marine units only at the edges: UI, AIS wire format,
  scenario files, control protocol. Geodetic positions in decimal degrees are
  the sole exception.
- **Angles**: radians internally, `wrapAngle` to [0, 2π) for headings,
  `wrapAngleSigned` to (−π, π] for errors. Starboard is positive, always.
- **No `Math.random()` in the core.** Seeded `Rng`, always, or runs stop being
  reproducible.
- **No colour literals outside `@umami/s52`.** Every colour resolves by token.
- **No wall-clock reads in the core.** Time comes from `SimClock`.

Development uses TypeScript sources directly across workspace packages — no
build step between packages, so a change is visible to its consumers
immediately and `vitest` and `vite` both resolve straight through.

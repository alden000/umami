# Umami

A maritime simulation environment for developing and testing USV algorithms and
AI, with an ECDIS-convention chart display, fed by live or recorded AIS, running
on desktop, mobile, tablet and web.

> **Status: framework.** The architecture, the simulation core, dynamics, AIS
> ingest, the external control interface and a working client are in place and
> tested. Chart rendering from real ENC data, S-52 symbols, and the platform
> wrappers are scaffolded but not finished — see [`docs/roadmap.md`](docs/roadmap.md).
> One known defect is documented in [`docs/architecture.md`](docs/architecture.md) §8.

## Quick start

```sh
pnpm install

pnpm test          # 121 tests across seven packages
pnpm typecheck

pnpm dev           # web client at http://localhost:5173
pnpm headless      # batch runner, ~5600x real time
```

The headless runner with no arguments runs a built-in crossing situation in the
Singapore Strait:

```
  0:00  1.20000 103.78001  HDG 090  COG 090  SOG 12.0kn  | MV CROSSING: 3.84nm CPA 0.03nm TCPA 10.8min crossing-give-way  ** CLOSE QUARTERS **
  4:00  1.20004 103.79467  HDG 090  COG 090  SOG 13.9kn  | MV CROSSING: 2.40nm CPA 0.24nm TCPA 6.3min crossing-give-way  ** CLOSE QUARTERS **
  8:00  1.20002 103.81015  HDG 090  COG 090  SOG 14.0kn  | MV CROSSING: 0.90nm CPA 0.24nm TCPA 2.3min crossing-give-way  ** CLOSE QUARTERS **

7200 steps in 0.13s wall clock (5760x real time, 57600 steps/s)
```

The USV holds its course into a close-quarters situation because no avoidance
algorithm is fitted — that is the thing under test.

## What it does today

- **Vessel dynamics** — 3-DOF manoeuvring model with waterjet, shaft-and-rudder
  and outboard propulsion. Seventeen reference vessel classes; any AIS contact
  gets type-appropriate motion from its reported dimensions and ship type.
- **AIS** — live aisstream.io, recorded JSONL or raw NMEA, and an AIVDM decoder
  verified against real traffic. Track management with dead reckoning, identity
  merging and implausible-jump rejection.
- **Ghost targets** — dropped on the chart with one tap, driven by any control
  mode or scripted; real AIS contacts can be taken over and made to misbehave.
- **External control** — one versioned protocol, five modes from waypoints down
  to raw actuator demands, over WebSocket, stdio, or in-process.
- **Chart display** — MapLibre with zoom and pan, S-52 day/dusk/night colour
  schemes, own ship and targets drawn to scale with heading lines and velocity
  vectors, CPA/TCPA and COLREGs encounter classification.
- **Deterministic and fast** — identical results at any frame rate or time
  scale; ~5,600× real time headless.

## Where to look

| | |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | How the system is put together and why |
| [`docs/adr/`](docs/adr/) | Individual decisions, alternatives, and costs |
| [`docs/roadmap.md`](docs/roadmap.md) | What is next, in order |
| [`tools/enc-ingest/`](tools/enc-ingest/) | S-57 chart ingest pipeline |

## Layout

```
packages/core       units, geodesy, fixed-step clock, seeded RNG
packages/dynamics   hull hydrodynamics, propulsion models, vessel library
packages/ais        AIS model, AIVDM decoder, sources, track manager
packages/sim        world, entities, control stack, scenarios, collision
packages/enc        S-57 object model, chart catalogue, provider interface
packages/s52        colour tables, safety contour and danger logic
packages/bridge     external control protocol and server
apps/web            React + MapLibre client
apps/headless       batch runner
tools/enc-ingest    offline S-57 to vector tiles
```

## Charts and licensing

ENCs are licensed data. Nothing under `data/` is committed — `.gitignore`
excludes both source cells and built tiles. The pipeline ships; the charts do
not.

The bundled S-52 colour tables are an **approximation** of the IHO Presentation
Library, and the API says so (`Palette.provenance`). They are suitable for
development and testing, not for a type-approved ECDIS. An operator holding the
official library swaps one source and the whole display follows — see
[ADR 0008](docs/adr/0008-s52-symbology-and-provenance.md).

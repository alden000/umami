# Working in this repository

Read [`docs/architecture.md`](docs/architecture.md) first — it explains the
seams and why they are where they are. Individual decisions are in
[`docs/adr/`](docs/adr/).

## Commands

```sh
pnpm test                       # all tests
pnpm typecheck                  # tsc across the workspace
npx vitest run packages/sim     # one package
pnpm dev                        # web client
pnpm headless -- --duration 600 # batch runner
```

Packages resolve to TypeScript sources directly — there is no build step
between them, so a change is visible to consumers immediately.

## Conventions that matter

- **SI inside, marine units only at the edges** (UI, AIS wire, scenario files,
  control protocol). Geodetic positions in decimal degrees are the exception.
- **Angles**: radians internally; `wrapAngle` for headings, `wrapAngleSigned`
  for errors. Starboard positive, always.
- **No `Math.random()` and no wall-clock reads in the simulation core.** Use
  the seeded `Rng` and `SimClock`, or determinism silently breaks.
- **No colour literals outside `@umami/s52`.** Every colour resolves by token.
- **Never integrate AIS contacts.** They are observations, dead-reckoned
  between reports. Simulated vessels are hypotheses. Keeping these separate is
  the point of the tool.

## Testing physics

Assert *behaviour*, not internals — a tanker's stopping distance, a turning
circle, leeway downwind. When comparing propulsion types, hold the hull
constant and vary only the drive, or the test measures boat size instead.

Several bugs here were found because a test asserted something physical and
failed. If a physics test fails, suspect the model before the test.

## Known open issue

Current does not set a vessel that is under thrust — see `architecture.md` §8.
A skipped test in `packages/sim/src/world.test.ts` carries the repro and the
intended assertions. Fix before relying on the environment model.

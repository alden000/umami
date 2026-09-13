# Architecture decision records

Each records a decision, what was rejected, and what it costs. They are dated
and immutable: a decision that changes gets a new ADR that supersedes the old
one rather than an edit, so the reasoning stays reviewable.

| # | Decision |
|---|---|
| [0001](0001-technology-stack.md) | TypeScript monorepo, web-first delivery |
| [0002](0002-determinism-and-time.md) | Fixed-step clock, decoupled from wall time |
| [0003](0003-enc-ingest-pipeline.md) | Offline S-57 ingest to vector tiles |
| [0004](0004-ais-ingest-and-sources.md) | Pluggable AIS sources, normalised at the edge |
| [0005](0005-external-control-interface.md) | One control protocol, several transports, five modes |
| [0006](0006-vessel-dynamics-fidelity.md) | Fidelity target, and how autopilot gains are found |
| [0007](0007-2d-now-3d-later.md) | Snapshot boundary, 2D now and 3D later |
| [0008](0008-s52-symbology-and-provenance.md) | S-52 colours are loadable data |
| [0009](0009-scenarios-and-ghost-targets.md) | Ghost targets are full dynamic vessels |

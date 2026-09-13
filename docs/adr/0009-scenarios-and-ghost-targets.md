# ADR 0009 — Ghost targets are full dynamic vessels

**Status:** accepted · **Date:** 2026-09-13

## Context

"Allow user to create drop in ghost targets on the fly, and controllable in
some manner." The cheap implementation is a marker interpolated along a line.

## Decision

A ghost is a full `SimulatedEntity` — the same class as the own USV, with the
same dynamics model and the same control stack. It can be dropped on the chart
with one tap, driven by any control mode, scripted with timed course and speed
changes, or handed to external software over the bridge.

An AIS contact can also be **promoted** to a ghost, taking its reported
identity, dimensions and kinematics as initial conditions.

## Consequences

Good: ghosts cannot do things ships cannot do. They take time to build a rate
of turn, lose speed in a turn, cannot stop instantly, and heel. Testing
collision avoidance against targets that *can* do impossible things produces
algorithms that fail against targets that cannot.

Good: promotion covers a specific and common need — a real vessel on the live
feed is about to do something interesting, and you want to take it over and
make it do something worse.

Good: scripted manoeuvres are timed demands rather than a behaviour model. What
is under test is the USV's response, and a reproducible provocation is worth
more than a clever adversary. A stand-on vessel that holds on and then alters
late is the case that matters, and it is three lines of scenario.

Bad: a ghost costs a full dynamics integration and, on first use of its class,
an autopilot tuning run. Measured at ~57,000 steps/s for three vessels; a
scenario with hundreds of independently manoeuvring ghosts would need
profiling, and non-manoeuvring traffic is better supplied as replayed AIS.

Bad: a promoted contact leaves the AIS picture and joins the simulated one, so
it stops being evidence and becomes a hypothesis. It is deliberately excluded
from the track list at that point so it cannot appear twice — to the display or
to the algorithm.

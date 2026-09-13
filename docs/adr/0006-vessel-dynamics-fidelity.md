# ADR 0006 — Fidelity target, and how autopilot gains are found

**Status:** accepted · **Date:** 2026-09-13

## Context

The requirement: "accurate enough to represent the vessel types and move
realistically". That needs a definition, because both over- and under-shooting
it are expensive — a towing-tank-grade model for every AIS contact is
unaffordable, and kinematic markers sliding along lines produce algorithms that
fail against real ships.

## Decision

**Fidelity target: recognisably right for the type.** A laden VLCC takes over a
mile and many ship lengths to stop and cannot turn inside a harbour; a 12 m USV
does neither. Vessels heel in a turn, take time to build a rate of turn, lose
speed while turning, and make leeway. That is the bar, and it is asserted by
test rather than claimed.

**Model:** 3-DOF Fossen manoeuvring model, RK4 at 10 Hz, with hydrodynamic
derivatives estimated from principal particulars via Clarke's (1983)
regressions. Any AIS contact can therefore be given type-appropriate motion
from length, beam and ship type alone.

**Propulsion is a separate pluggable model** from the hull. See §3.1 of the
architecture doc: `steersAtZeroSpeed` is the distinction that matters.

**Autopilot gains are found by trial**, not by formula. Pole placement on an
identified Nomoto model sets the starting point and the scale; each candidate
is then scored by flying an actual heading step against the actual dynamics,
searching over proportional gain and derivative time, and the best is kept and
cached per vessel class and speed.

## Why trial rather than pole placement alone

First-order Nomoto omits steering gear slew rate, the speed a hull loses in a
turn, sway-yaw coupling and saturation. Across this fleet those are not
second-order corrections — they are the difference between a vessel that
settles on its heading and one that circles indefinitely. Several open-loop
designs were tried and each left some part of the fleet limit-cycling tens of
degrees wide. Searching against the real plant produced gains where all
seventeen reference classes settle exactly.

The search is parameterised as (kp, kd/kp) rather than (kp, kd) because both
axes are then physical and scale-free: 1/kp is the heading error at which
steering saturates, and kd/kp is a time in seconds. The same grid consequently
spans a 333 m tanker and a 9 m USV, whose sensible kd values differ by four
orders of magnitude.

## Consequences

Good: one grid tunes the whole fleet; adding a vessel class needs no tuning
work. Gains are known to work rather than believed to.

Bad: tuning costs tens of thousands of integration steps per class and speed
(~1.2 s). Cached, so paid once per process.

Bad: gains are tuned in calm water at one speed. Steering authority is
speed-dependent for every drive — a rudder's with the square of flow, a
waterjet's with throttle — so a vessel operating far from its tuning speed will
be less crisp. Identification uses the *commanded* speed, which covers the
common case; full gain scheduling is future work.

**Limits, stated plainly.** These are estimates, not tank results. Clarke's
regressions are extrapolated for small, beamy, shallow-draught hulls, and
inputs are clamped to the fitted envelope to keep the mass matrix physically
realisable. A vessel that matters — the own USV above all — should have
coefficients calibrated against turning-circle and zig-zag trials and supplied
explicitly, and its autopilot tuned against those. The framework supports this:
pass `HydroCoefficients` directly instead of deriving them.

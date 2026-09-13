# ADR 0005 — One control protocol, several transports, five modes

**Status:** accepted · **Date:** 2026-09-13

## Context

The USV must be drivable by external software. The requirement named course and
speed, or waypoints and speed, as candidates. Propulsion is waterjet, with
inboard and outboard as options.

## Decision

Support **both**, plus three more, as explicit modes over one versioned
JSON protocol: `waypoint`, `course-speed`, `heading-speed`, `station-keep`,
`actuator`. All converge on one `ActuatorDemand` of `{ throttle, steer }`,
normalised −1..1, starboard positive whatever the drive is.

The bridge is a plain object handling messages, not something that owns a
socket. WebSocket, stdio and in-process all work.

## Consequences

Good: an algorithm enters the stack at the level it is testing — a mission
planner against `waypoint`, a guidance law against `course-speed`, a low-level
controller or real autopilot hardware against `actuator` — on the same vessel
model. Adding a mode costs a case in one switch.

Good: because the transport is pluggable, a test written against the in-process
bridge is valid for the WebSocket one. That is what makes CI meaningful here.

Good: modes are mutually exclusive by construction, so a client cannot leave
a vessel in an ambiguous state by sending a course while it believes it is
following a route.

Good: marine units on the wire. This is the boundary a human reads and where an
existing autopilot or ground station is most likely adapted in.

Bad: a normalised `steer` hides what the actuator physically is. Deliberate —
it is what lets one algorithm drive a waterjet, an outboard and a rudder — and
the underlying positions are published in telemetry for anyone who needs them.

Bad: `courseTrimRateFor` currently takes a synthetic Nomoto model in the bridge
rather than the vessel's identified one. Works, but the host should pass the
real cached model.

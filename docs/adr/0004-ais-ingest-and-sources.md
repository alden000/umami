# ADR 0004 — Pluggable AIS sources, normalised at the edge

**Status:** accepted · **Date:** 2026-09-13

## Context

The system must accept a live AIS feed (aisstream.io initially) or recorded
data, and be designed for other sources later — a national coastal receiver, a
satellite provider, a ship's own transponder over NMEA 0183.

## Decision

`AisSource` is a thin contract — start, stop, emit normalised `AisMessage`.
Every provider-specific concern stops at its adapter. A `TrackManager` turns the
message stream into a picture: merging Class B's two-part static reports,
holding identity across updates, rejecting implausible position jumps,
dead-reckoning between reports, and forgetting contacts that go quiet.

Shipping: aisstream.io (live), replay (JSONL or raw NMEA), and an AIVDM decoder
for any receiver producing sentences.

## Consequences

Good: the simulation cannot tell a live feed from a replayed one, so the same
collision-avoidance code is testable against live traffic, a replayed incident,
and a synthetic scenario without modification.

Good: replay preserves original inter-message timing. Real AIS is irregular —
Class A every 2–10 s depending on speed and turn rate, Class B every 30 s, with
dropouts — and an algorithm tuned against evenly spaced synthetic updates
behaves differently the first time it meets a real feed.

Good: a single bad fix — from MMSI misprogramming or multipath — can make a
target appear to jump across a traffic separation scheme, and a
collision-avoidance algorithm will faithfully react. Rejecting positions that
would need an impossible speed removes that whole class of spurious alerts
cheaply.

**Security constraint:** the aisstream.io API key is a server-side credential.
The source must not be constructed in a browser, where the key would ship in
the bundle and be readable in devtools. Run it in the headless runner, the
desktop app, or a small relay, and have browser clients consume the relay.

Bad: the normalised model is a lowest common denominator. Fields no source
provides are absent, and a provider-specific field needs a model change to
surface. Judged the right trade for keeping every consumer source-agnostic.

**Verification note:** position report field mappings are confirmed against the
live schema. Static-data field names (`ShipStaticData`) are modelled on ITU-R
M.1371 message 5 and read defensively with fallbacks, so an unexpected name
degrades one field rather than dropping a vessel's identity. Confirm against a
live feed before relying on draught or ETA.

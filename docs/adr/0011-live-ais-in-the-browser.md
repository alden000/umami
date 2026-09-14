# ADR 0011 — Live AIS from the browser, on the operator's own key

**Status:** accepted · **Date:** 2026-09-14
**Refines:** [ADR 0004](0004-ais-ingest-and-sources.md)

## Context

ADR 0004 built the aisstream.io adapter and warned against constructing it in a
browser, because a key in a static bundle ships to every visitor and is
readable in devtools. That warning still holds, and it left live AIS with no
route into the deployed client at all — which is now a public GitHub Pages
build with no backend to hold a credential.

## Decision

Connect from the browser, on a key the **operator supplies at runtime** and
which is kept in their own `localStorage`. Nothing is committed, nothing enters
the bundle, and the key travels only to aisstream.io.

The distinction ADR 0004 missed is between a key *baked into the artifact* and
a key *entered by the person using it*. The first is a credential handed to
every visitor; the second is the visitor's own credential, on their own
machine, against their own quota. Only the first was ever the problem.

`VITE_AIS_STREAM_URL` points the client at a relay instead, for deployments
that would rather hold one credential server-side than ask each operator for
their own. That is the arrangement ADR 0004 originally assumed, still available
and no longer the only option.

## Consequences

Good: live AIS works on a public static deployment with no backend, and the
same pattern as charts opened from local disk — public app, private inputs.

Good: each operator uses their own account, so nobody shares a rate limit.
aisstream.io allows three concurrent connections per account and three per IP.

Good: subscription follows the map view, so the feed carries the area being
looked at rather than the world.

The provider's limits are enforced in the adapter, not left to callers. It
accepts at most one subscription per second, so `updateSubscription` holds an
update inside that window and a newer one supersedes it — panning a map
generates updates far faster than once a second, and a closed connection is a
worse outcome than a slightly stale bounding box. The subscription is also sent
immediately on open, because the service hangs up if none arrives within three
seconds.

Bad: the key is visible to whoever is using the browser. That is inherent —
it's theirs — but it means a shared or kiosk machine leaks it through
`localStorage`, and the relay option is the answer where that matters.

Bad: live AIS needs a network, like the web basemap and unlike everything else
here.

Bad: contacts arrive at real-world positions, which may be nowhere near the
scenario's own ship. The chart, the basemap and the simulated vessels can each
be in three different places. Nothing prevents it, and nothing should — but it
is a way to be confused about what you are looking at.

`ShipStaticData` field names are still not published by the provider; they are
read defensively, so an unexpected name costs one field rather than a vessel's
identity. Position report fields are confirmed against the documentation and
covered by tests built from the documented envelope.

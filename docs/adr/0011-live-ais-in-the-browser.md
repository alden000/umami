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

The subscribed area is a **fixed window**, not the map view. Following the view
was the original arrangement and was worse in both directions: zooming in on one
vessel silently unsubscribed from the traffic around it, and zooming out asked
the provider for a region nobody was watching. Either way the picture changed
because of where the operator happened to be looking, which is the opposite of
what a traffic picture is for. It also generated subscription updates far faster
than the one per second the provider accepts, for no gain.

The window is entered by the operator and kept in their own `localStorage`,
alongside the key and for the same reason: it is theirs, it is not a secret, and
a tool that forgets where you work every time you open it is a tool you argue
with. A first load defaults to the whole world - somebody who has not yet said
what they care about is better served seeing traffic and narrowing down than by
an empty chart they then have to diagnose. Editing it re-subscribes a live
connection in place rather than reconnecting, which would throw away the
contacts already gathered.

A stored window is validated on the way back in, not trusted. It was written by
this app, but it can also have been written by an older build or edited by hand,
and a box that would be refused from the keyboard must not get in through
storage instead - a transposed corner produces a subscription that returns
nothing, which looks exactly like quiet water.

`updateSubscription` remains on the source for callers that do want to follow
something - the headless runner following own ship, for instance - and still
enforces the rate limit.

The box is sent, not enforced. The adapter used to re-check each report against
its own copy of it and drop anything outside, which is the wrong instinct twice
over: a report that arrives is a real vessel that really reported, and the
window between a box changing locally and the provider acting on it is exactly
when contacts would go missing with nothing to say why. Everything received is
now accepted and tracked. What is *shown* is a separate, downstream question -
and one the display should answer, since a contact that exists is worth knowing
about even when it is off the edge of the area asked for.

The replay source still filters locally, because there is no provider to ask
and the box would otherwise do nothing at all.

`updateSubscription` must never throw, because of where it is called from: a
map's `moveend` handler, which MapLibre runs inside its render task queue. An
exception escaping that queue leaves it flagged as still running and the chart
renders no further frame for the life of the page, in silence. A stale bounding
box is a nuisance; a dead chart is the tool not working. So a subscription that
cannot be sent is held rather than attempted — the socket is assigned while it
is still `CONNECTING`, which is exactly when sending on it throws, and every
reconnect passes through that window.

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

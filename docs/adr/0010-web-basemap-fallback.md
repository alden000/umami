# ADR 0010 — Web basemap as a fallback, never as a chart

**Status:** accepted · **Date:** 2026-09-14

## Context

An ENC only covers the water it was surveyed for, and a licensed exchange set
is not always to hand. Without one the display is `NODTA` — correct, and
useless for finding your way around while setting up a scenario. A web basemap
would at least give a coastline.

## Decision

Offer an optional raster basemap drawn **beneath** the chart: OpenStreetMap,
optionally with the OpenSeaMap seamark overlay. Default is `none`.

Where an ENC has coverage it wins outright. The basemap only ever fills what
the chart does not cover.

## Why beneath, and why a warning

OSM has a coastline. It has **no depth areas, no soundings, no safety contour,
no dredged depths**. A surveyed chart and a crowd-sourced coastline are not
interchangeable, and the difference is precisely the information a USV needs in
order not to ground. Letting a basemap draw over an ENC would hide the data
that matters behind the data that doesn't.

The same reasoning drives the persistent banner whenever a basemap is active.
This codebase already refuses to draw unknown depth as deep water (§7 of the
architecture doc); a basemap is that same failure at the scale of the whole
display, and the only honest mitigation is to say so on screen and not let it
be dismissed.

The seamark overlay is included because it is the one genuinely nautical part:
buoys, beacons and lights from OSM's seamark tags. It partially covers the gap
left by the S-52 point symbols not yet being drawn (ADR 0008). It is still
crowd-sourced and still carries no depths.

## Consequences

Good: an area with no ENC is usable for building and watching scenarios.

Good: the seamark overlay gives some nautical marks before our own symbol set
exists.

Bad: **it breaks the offline property.** Every other part of this system works
with no network — the style deliberately has no remote glyph or sprite server
(ADR 0001). A basemap needs tiles on demand, and the OSM tile policy forbids
pre-fetching a region to cache it. This is why the default is `none` rather
than "on when no chart is loaded": turning it on is a decision to require a
network, and that decision should be made deliberately.

Bad: the public endpoints are not suitable for production. The OSM Foundation's
policy permits individual interactive use, requires visible attribution that
cannot be hidden behind a toggle, forbids bulk or pre-emptive fetching, and
states that commercial services "should be especially aware that access may be
withdrawn at any point". `VITE_BASEMAP_TILE_URL` and `VITE_SEAMARK_TILE_URL`
point the app at your own tile server, which is what the policy recommends for
anything beyond individual use.

Attribution is carried on the source definitions rather than added separately,
so the credit cannot be present without the tiles or the tiles without the
credit. The map's attribution control is consequently no longer suppressed.

Licensing: OSM data is ODbL; OpenSeaMap tiles are CC-BY-SA 2.0. Both require
attribution, and the share-alike terms are worth checking against your intended
distribution before shipping either.

Bad: raster tiles are drawn for a bright screen in daylight and are far louder
than an S-52 palette. They are dimmed and desaturated per colour scheme, most
heavily at night, because a bright basemap would undo the reason the night
scheme exists. That is a compromise on both sides: the basemap is muted, and it
still does not sit inside the palette the way chart data does.

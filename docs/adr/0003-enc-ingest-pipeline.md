# ADR 0003 — Offline S-57 ingest to vector tiles

**Status:** accepted · **Date:** 2026-09-13

## Context

Charts must come from IHO S-57 ENC cells, render at ECDIS quality, work
offline on a tablet, and — explicitly — be **easy to upgrade and reload** as new
editions are issued.

## Decision

Convert S-57 offline, at install time, into PMTiles plus a `ChartCatalogue`
manifest (`tools/enc-ingest`). The application reads tiles and manifest; it
never parses S-57. A new exchange set is a new pipeline run and a rewritten
manifest — no code change, no rebuild.

Cells carry their **usage band**, and chart precedence is decided by
navigational purpose rather than file order. Updates apply only in strict
edition and update-number sequence.

## Alternatives considered

**Parse S-57 in the application.** Rejected: ISO/IEC 8211 is a dense binary
exchange format designed for hydrographic offices, not for a renderer to walk
sixty times a second on a phone.

**A tile server.** Rejected as the default: the application must work with no
network at sea, and requiring a server would mean either deploying one
everywhere or maintaining a different chart path per platform. PMTiles is a
single file, range-requested over HTTP *or* read from disk, so one path serves
web, phone bundle and desktop folder.

## Consequences

Good: chart updates are a data operation. A deployment carries only the cells
it is licensed for. GDAL and tippecanoe are build-time dependencies only.

Good: this is the seam that keeps S-57 from being load-bearing. S-101 becomes
a second ingest path writing the same tile schema and manifest; `ChartProvider`
and everything above it are unaffected.

Bad: ingest must be re-run when new cells arrive — acceptable, and exactly the
operational model an ECDIS already has.

Bad: `mergeCatalogue` refusing out-of-order updates will reject a genuinely
corrupted sequence rather than repairing it. That is the intended direction:
an out-of-order ENC update yields a chart that looks correct and is wrong.

# ENC ingest pipeline

Converts an IHO S-57 exchange set into vector tiles the application can draw,
plus a catalogue manifest describing what was installed.

The pipeline is deliberately offline and outside the application. S-57 is a
dense binary format (ISO/IEC 8211) designed for exchange between hydrographic
offices, not for a renderer to parse sixty times a second on a phone. Decoding
it once, at install time, into tiles indexed for spatial access is the
difference between a chart that draws instantly on a tablet and one that does
not draw at all.

## Why this shape

**Charts are data, not code.** A new edition of a cell is a new input to this
pipeline and a rewritten manifest. Nothing is rebuilt, no code changes, and a
deployment can carry only the cells it is licensed for. This is the whole
answer to "must be able to allow easy upgrading and loading of S-57 ENC files
in the future".

**PMTiles as the tile container.** A single file, range-requested over HTTP,
also readable directly from disk. It works from a web server, from an app
bundle on iOS or Android, and from a local folder on a desktop, with no tile
server to deploy. Given that the application has to run on all of those, a
format that needs a server would mean either a server everywhere or a different
chart path per platform.

**S-101 is the reason for the seam.** The successor to S-57 is a different
encoding of similar content. When it matters, it becomes a second ingest path
writing the same tile schema and the same manifest; `ChartProvider` and
everything above it are unaffected.

## Requirements

GDAL 3.x with the S-57 driver (`ogrinfo --formats | grep S57`) and
[tippecanoe](https://github.com/felt/tippecanoe). Both are build-time
dependencies only; neither ships with the application.

## Usage

```sh
./ingest.sh /path/to/exchange-set /path/to/output
```

The exchange set is the directory containing `CATALOG.031` and the `ENC_ROOT`
tree as supplied by the hydrographic office.

## What it produces

```
output/
  catalogue.json        # ChartCatalogue: cells, editions, bounds, tile paths
  charts.pmtiles        # all cells, one file, layer per S-57 object class
```

Each feature carries its S-57 attributes unchanged, plus `_cell` and
`_usageBand` so the renderer can apply chart precedence. Object classes the
application does not yet style are ingested anyway rather than dropped, so
adding symbology later is a style change and not a re-ingest.

## Update handling

S-57 update files (`.001`, `.002`, ...) apply in strict sequence against a base
cell. GDAL applies them when `OGR_S57_OPTIONS=UPDATES=APPLY` is set, which
`ingest.sh` does. `mergeCatalogue` then refuses any edition or update number
older than what is installed — applying ENC updates out of order yields a chart
that looks correct and is wrong, which is the worst available outcome.

## Licensing

ENCs are licensed data. Nothing under `data/` is committed; `.gitignore`
excludes both source cells and built tiles. Ship the pipeline, not the charts.

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

## Files

| | |
|---|---|
| `ingest.sh` | the pipeline |
| `tag_features.py` | stamps object class and cell provenance onto each feature |
| `write_catalogue.py` | builds the `ChartCatalogue` manifest |

## Requirements

GDAL 3.x with the S-57 driver (`ogrinfo --formats | grep S57`) and
[tippecanoe](https://github.com/felt/tippecanoe). Both are build-time
dependencies only; neither ships with the application.

## Usage

```sh
./ingest.sh /path/to/ENC_ROOT /path/to/output
```

Point it at the `ENC_ROOT` tree as supplied by the hydrographic office. It
reports what each cell contributed, by object class:

```
  converting US5NY1CM
    57 layers, 6695 features
      ACHBRT=615 ACHARE=11 BCNLAT=3 BOYLAT=56 COALNE=66 DEPARE=323
      DEPCNT=368 LIGHTS=61 LNDARE=40 OBSTRN=117 SOUNDG=3464 WRECKS=28 ...
```

Read that output. A cell missing the classes you expect means something went
wrong upstream, and it is far cheaper to notice here than to wonder later why
the chart looks sparse. A cell that yields nothing is refused outright.

To view the result in the web client:

```sh
cp output/charts.pmtiles apps/web/public/
VITE_CHART_URL=/charts.pmtiles pnpm dev
```

## Verified against

NOAA US5NY1CM (New York harbour, usage band 5), GDAL 3.8.4, tippecanoe 2.49 —
57 layers, 6695 features, rendering in day, dusk and night schemes.

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

## Notes from making this work

Four things here are not obvious and were each found by running the pipeline
against a real cell rather than by reading the code:

**One OGR layer per object class.** The S-57 driver does not expose a single
layer with a class attribute; it exposes ~60 layers named `DEPARE`, `LNDARE`,
`BOYLAT` and so on, and carries only a numeric `OBJL` code on the feature.
GeoJSON and GeoJSONSeq hold one layer, so converting the whole datasource in
one call keeps only the first layer and warns. Each layer is therefore
converted separately and tagged with `OBJL_NAME` here, which is the field every
renderer style filter keys on.

**Most layers report no geometry type.** `ogrinfo` prints `12: DEPARE` rather
than `12: DEPARE (Polygon)` for any layer whose geometry is `Unknown (any)`,
which is most of them. Parsing the layer list with a pattern that expects a
parenthesised type silently drops exactly the layers that matter.

**`OGR_S57_OPTIONS` is not reliable.** On GDAL 3.8.4, merely setting it changed
the layer count from 58 to 62 regardless of the value given, and
`RETURN_PRIMITIVES=OFF` did not suppress the primitive layers. Options are
passed explicitly with `-oo`, and `DSID`, `IsolatedNode`, `ConnectedNode`,
`Edge` and `Face` are excluded by name.

**`DSID` has no geometry.** It is the first layer of every cell, so any code
that reaches for `geometryFields[0]` across layers throws on the first one.
Combined with a broad `except`, that silently produced whole-world cell bounds,
which would have let one harbour chart suppress every other chart at every zoom.

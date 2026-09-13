#!/usr/bin/env python3
"""Stamp object-class and cell provenance onto each GeoJSON feature.

Invoked once per (cell, OGR layer) pair by ingest.sh. Appends the tagged
features to an output file and prints only the feature count to stdout, so the
caller can both accumulate the data and report what each object class actually
contributed.

The object class comes from the OGR layer name, not from a per-feature
attribute. GDAL's S-57 driver exposes one layer per S-57 object class (DEPARE,
LNDARE, BOYLAT, ...) and carries only a numeric OBJL code on the feature, so
once ogr2ogr has flattened a layer to GeoJSONSeq the acronym exists nowhere
unless it is written here. Every style filter in apps/web/src/chart-style.ts
keys on `OBJL_NAME`; getting this wrong means every filter downstream silently
matches nothing.

Usage: tag_features.py <layer-geojsonl> <cell-name> <usage-band> <layer-name>
                       <output-geojsonl>
"""
import json
import sys


def main() -> int:
    if len(sys.argv) != 6:
        print(__doc__, file=sys.stderr)
        return 2

    path, cell, band, layer, out_path = sys.argv[1:6]

    count = 0
    with open(path) as src, open(out_path, "a") as dst:
        for line in src:
            line = line.strip()
            if not line:
                continue
            try:
                feature = json.loads(line)
            except json.JSONDecodeError:
                # A truncated final line is normal when ogr2ogr skips a failing
                # feature; drop it rather than abandoning the layer.
                continue
            props = feature.setdefault("properties", {}) or {}
            props["OBJL_NAME"] = layer
            props["_cell"] = cell
            props["_usageBand"] = int(band) if band.isdigit() else 0
            feature["properties"] = props
            dst.write(json.dumps(feature) + "\n")
            count += 1

    print(count)
    return 0


if __name__ == "__main__":
    sys.exit(main())

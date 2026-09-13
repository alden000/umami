#!/usr/bin/env python3
"""Stamp OGR-layer/cell provenance onto each GeoJSON feature and print it.

Invoked once per (cell, OGR layer) pair by ingest.sh. The object class comes
from the OGR layer name, not a per-feature attribute: GDAL's S-57 driver
exposes one layer per S-57 object class (DEPARE, LNDARE, BOYLAT, ...) rather
than a single layer carrying a class field, so this is the only place the
class name is actually known once ogr2ogr has flattened one layer to
GeoJSONSeq. Every renderer style filter in apps/web/src/chart-style.ts keys on
`OBJL_NAME`, so getting this wrong here means every filter downstream silently
matches nothing - which is exactly the bug this script replaces.
"""
import json
import sys


def main() -> None:
    path, cell, band, layer = sys.argv[1:5]
    with open(path) as f:
        lines = f.readlines()
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            feature = json.loads(line)
        except json.JSONDecodeError:
            continue
        props = feature.setdefault("properties", {}) or {}
        props["OBJL_NAME"] = layer
        props["_cell"] = cell
        props["_usageBand"] = int(band) if band.isdigit() else 0
        feature["properties"] = props
        print(json.dumps(feature))


if __name__ == "__main__":
    main()

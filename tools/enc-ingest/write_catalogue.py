#!/usr/bin/env python3
"""Write the ChartCatalogue manifest for an ingested exchange set.

Usage: write_catalogue.py <exchange-set-dir> <output-catalogue.json>

The manifest is what the application reads to know which cells are installed,
where they sit, and which takes precedence where two overlap. Cell bounds
matter more than they look: `cellsAt` and `cellsForScale` in @umami/enc select
charts by bounds, so a cell claiming the whole planet suppresses every other
chart at every zoom.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

# Compilation scale by S-57 usage band, used when the cell does not state one.
BAND_SCALES = {1: 3_000_000, 2: 700_000, 3: 180_000, 4: 45_000, 5: 12_000, 6: 2_500}


def cell_bounds(path: str) -> dict | None:
    """Union of every geometry layer's extent, in degrees.

    Returns None rather than a default when the extent cannot be read. A cell
    with no usable bounds must be reported, not quietly given world bounds:
    that was the original defect here, where the very first layer of every
    S-57 cell (DSID, a metadata record with no geometry) raised on indexing
    and a bare `except` turned the failure into -90/-180/90/180.
    """
    try:
        result = subprocess.run(
            ["ogrinfo", "-json", "-so", "-al", "-oo", "UPDATES=APPLY", path],
            capture_output=True,
            text=True,
            check=True,
        )
        info = json.loads(result.stdout)
    except (subprocess.CalledProcessError, json.JSONDecodeError) as err:
        print(f"    WARNING: could not read extent of {path}: {err}", file=sys.stderr)
        return None

    west = south = east = north = None
    for layer in info.get("layers", []):
        # Metadata layers such as DSID carry no geometry fields at all.
        for field in layer.get("geometryFields") or []:
            extent = field.get("extent")
            if not extent or len(extent) != 4:
                continue
            lw, ls, le, ln = extent
            west = lw if west is None else min(west, lw)
            south = ls if south is None else min(south, ls)
            east = le if east is None else max(east, le)
            north = ln if north is None else max(north, ln)

    if west is None:
        return None
    return {"south": south, "west": west, "north": north, "east": east}


def main() -> int:
    exchange_set, out_path = sys.argv[1], sys.argv[2]
    cells = []
    incomplete = 0

    for root, _dirs, files in os.walk(exchange_set):
        for name in sorted(files):
            if not name.endswith(".000"):
                continue
            cell_name = name[:-4]
            path = os.path.join(root, name)

            # Highest update file sitting alongside the base cell.
            updates = [
                f
                for f in os.listdir(root)
                if f.startswith(cell_name + ".") and f[-3:].isdigit() and f[-3:] != "000"
            ]
            update_number = max((int(f[-3:]) for f in updates), default=0)

            band = (
                int(cell_name[2])
                if len(cell_name) > 2 and cell_name[2].isdigit()
                else 3
            )
            bounds = cell_bounds(path)
            if bounds is None:
                incomplete += 1
                continue

            cells.append(
                {
                    "name": cell_name,
                    "producer": cell_name[:2].upper(),
                    "usageBand": band,
                    "edition": 1,
                    "updateNumber": update_number,
                    "issueDate": datetime.now(timezone.utc).date().isoformat(),
                    "compilationScale": BAND_SCALES.get(band, 50_000),
                    "bounds": bounds,
                    "tileSource": "charts.pmtiles",
                }
            )

    with open(out_path, "w") as f:
        json.dump(
            {
                "version": 1,
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "cells": cells,
                "tileTemplate": "charts.pmtiles",
            },
            f,
            indent=2,
        )

    print(f"  {len(cells)} cell(s) catalogued")
    if incomplete:
        print(f"  WARNING: {incomplete} cell(s) omitted for unreadable bounds", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

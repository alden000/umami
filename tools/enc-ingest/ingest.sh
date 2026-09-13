#!/usr/bin/env bash
#
# Convert an S-57 exchange set into vector tiles and a chart catalogue.
#
# Usage: ./ingest.sh <exchange-set-dir> <output-dir>
set -euo pipefail

EXCHANGE_SET="${1:?usage: ingest.sh <exchange-set-dir> <output-dir>}"
OUTPUT="${2:?usage: ingest.sh <exchange-set-dir> <output-dir>}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v ogr2ogr >/dev/null || { echo "ogr2ogr not found: install GDAL with the S-57 driver" >&2; exit 1; }
command -v tippecanoe >/dev/null || { echo "tippecanoe not found" >&2; exit 1; }

mkdir -p "$OUTPUT"

# Apply update files in sequence, and keep attributes the renderer needs.
# RETURN_PRIMITIVES keeps geometry primitives distinct; LNAM_REFS preserves the
# feature relationships that light sectors and topmarks depend on.
export OGR_S57_OPTIONS="UPDATES=APPLY,SPLIT_MULTIPOINT=ON,ADD_SOUNDG_DEPTH=ON,RETURN_PRIMITIVES=OFF,LNAM_REFS=ON"

echo "Scanning exchange set: $EXCHANGE_SET"
mapfile -t CELLS < <(find "$EXCHANGE_SET" -name '*.000' | sort)
[ "${#CELLS[@]}" -gt 0 ] || { echo "no base cells (*.000) found" >&2; exit 1; }
echo "Found ${#CELLS[@]} base cell(s)"

for CELL_PATH in "${CELLS[@]}"; do
  CELL_NAME="$(basename "$CELL_PATH" .000)"
  echo "  converting $CELL_NAME"
  # -skipfailures: a single malformed feature must not abandon a whole cell.
  ogr2ogr -f GeoJSONSeq "$WORK/$CELL_NAME.geojsonl" "$CELL_PATH" \
    -t_srs EPSG:4326 -skipfailures -lco RS=NO 2>/dev/null || {
      echo "    WARNING: $CELL_NAME failed to convert, skipping" >&2
      continue
    }
  # Stamp cell provenance onto every feature so chart precedence can be applied
  # at draw time rather than being baked in here.
  USAGE_BAND="${CELL_NAME:2:1}"
  python3 - "$WORK/$CELL_NAME.geojsonl" "$CELL_NAME" "$USAGE_BAND" <<'PY'
import json, sys
path, cell, band = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    lines = f.readlines()
with open(path, "w") as f:
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            feature = json.loads(line)
        except json.JSONDecodeError:
            continue
        props = feature.setdefault("properties", {}) or {}
        props["_cell"] = cell
        props["_usageBand"] = int(band) if band.isdigit() else 0
        feature["properties"] = props
        f.write(json.dumps(feature) + "\n")
PY
done

echo "Building tiles"
# One layer per S-57 object class, so the style can address them individually.
# -z16 reaches berthing scale; -Z0 keeps an overview usable.
tippecanoe -o "$OUTPUT/charts.pmtiles" --force \
  -Z0 -z16 \
  --drop-densest-as-needed \
  --extend-zooms-if-still-dropping \
  --no-tile-compression \
  -L'{"file":"","layer":"enc"}' \
  "$WORK"/*.geojsonl

echo "Writing catalogue"
python3 - "$EXCHANGE_SET" "$OUTPUT/catalogue.json" <<'PY'
import json, os, subprocess, sys
from datetime import datetime, timezone

exchange_set, out_path = sys.argv[1], sys.argv[2]
cells = []
for root, _dirs, files in os.walk(exchange_set):
    for name in sorted(files):
        if not name.endswith(".000"):
            continue
        cell_name = name[:-4]
        path = os.path.join(root, name)
        # Highest update file present alongside the base cell.
        updates = [f for f in os.listdir(root)
                   if f.startswith(cell_name + ".") and f[-3:].isdigit() and f[-3:] != "000"]
        update_number = max((int(f[-3:]) for f in updates), default=0)

        bounds = None
        try:
            info = json.loads(subprocess.run(
                ["ogrinfo", "-json", "-so", "-al", path],
                capture_output=True, text=True, check=True).stdout)
            for layer in info.get("layers", []):
                ext = layer.get("geometryFields", [{}])[0].get("extent")
                if not ext:
                    continue
                west, south, east, north = ext
                bounds = bounds or [south, west, north, east]
                bounds = [min(bounds[0], south), min(bounds[1], west),
                          max(bounds[2], north), max(bounds[3], east)]
        except Exception:
            pass

        band = int(cell_name[2]) if len(cell_name) > 2 and cell_name[2].isdigit() else 3
        cells.append({
            "name": cell_name,
            "producer": cell_name[:2].upper(),
            "usageBand": band,
            "edition": 1,
            "updateNumber": update_number,
            "issueDate": datetime.now(timezone.utc).date().isoformat(),
            "compilationScale": {1: 3000000, 2: 700000, 3: 180000,
                                 4: 45000, 5: 12000, 6: 2500}.get(band, 50000),
            "bounds": ({"south": bounds[0], "west": bounds[1],
                        "north": bounds[2], "east": bounds[3]}
                       if bounds else
                       {"south": -90, "west": -180, "north": 90, "east": 180}),
            "tileSource": "charts.pmtiles",
        })

with open(out_path, "w") as f:
    json.dump({
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "cells": cells,
        "tileTemplate": "charts.pmtiles",
    }, f, indent=2)
print(f"  {len(cells)} cell(s) catalogued")
PY

echo "Done. Output in $OUTPUT"

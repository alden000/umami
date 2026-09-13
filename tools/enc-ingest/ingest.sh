#!/usr/bin/env bash
#
# Convert an S-57 exchange set into vector tiles and a chart catalogue.
#
# Usage: ./ingest.sh <exchange-set-dir> <output-dir>
set -euo pipefail

EXCHANGE_SET="${1:?usage: ingest.sh <exchange-set-dir> <output-dir>}"
OUTPUT="${2:?usage: ingest.sh <exchange-set-dir> <output-dir>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

  # GDAL's S-57 driver exposes one OGR layer per object class (DEPARE,
  # LNDARE, BOYLAT, SOUNDG, ...) - dozens of layers from a single cell.
  # GeoJSON/GeoJSONSeq are single-layer formats, so ogr2ogr given the whole
  # datasource with no layer selection silently keeps only the FIRST layer
  # it enumerates and prints a warning that this script used to throw away
  # with `2>/dev/null`. The renderer's `OBJL_NAME` filter therefore never
  # matched anything, against every cell, ever - a chart that looked like a
  # bug in styling was actually never receiving most of its data.
  #
  # The fix is to convert each layer separately and stamp its class name onto
  # every feature ourselves, then concatenate. `ogrinfo -q` lists exactly the
  # layers this cell actually contains, so nothing is assumed or hard-coded.
  mapfile -t LAYERS < <(ogrinfo -q "$CELL_PATH" 2>/dev/null \
    | grep -oP '^\d+:\s*\K[A-Z0-9_]+(?=\s*\()')
  if [ "${#LAYERS[@]}" -eq 0 ]; then
    echo "    WARNING: $CELL_NAME has no readable layers, skipping" >&2
    continue
  fi

  : > "$WORK/$CELL_NAME.geojsonl"
  CELL_OK=0
  USAGE_BAND="${CELL_NAME:2:1}"

  for LAYER in "${LAYERS[@]}"; do
    LAYER_FILE="$WORK/$CELL_NAME.$LAYER.geojsonl"
    # -skipfailures: a single malformed feature must not abandon a whole layer.
    if ogr2ogr -f GeoJSONSeq "$LAYER_FILE" "$CELL_PATH" "$LAYER" \
        -t_srs EPSG:4326 -skipfailures -lco RS=NO 2>/dev/null; then
      CELL_OK=1
      python3 "$SCRIPT_DIR/tag_features.py" "$LAYER_FILE" "$CELL_NAME" "$USAGE_BAND" "$LAYER" \
        >> "$WORK/$CELL_NAME.geojsonl"
    fi
    rm -f "$LAYER_FILE"
  done

  if [ "$CELL_OK" -eq 0 ]; then
    echo "    WARNING: $CELL_NAME failed to convert, skipping" >&2
    rm -f "$WORK/$CELL_NAME.geojsonl"
  fi
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

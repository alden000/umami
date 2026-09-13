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

# S-57 driver open options, passed explicitly with -oo rather than through the
# OGR_S57_OPTIONS environment variable. Measured against GDAL 3.8.4: merely
# setting that variable changed the layer count from 58 to 62 whatever value it
# was given, so its effect is not reliably the one written down. Explicit -oo
# is deterministic and visible in the command that actually ran.
#
# UPDATES=APPLY folds the .001, .002 ... update files into the base cell in
# sequence. SPLIT_MULTIPOINT with ADD_SOUNDG_DEPTH turns a SOUNDG multipoint
# into one feature per sounding carrying its depth, which is what makes
# soundings styleable at all. LNAM_REFS preserves the feature relationships
# light sectors and topmarks are built from.
OO_OPTS=(-oo UPDATES=APPLY -oo SPLIT_MULTIPOINT=ON -oo ADD_SOUNDG_DEPTH=ON -oo LNAM_REFS=ON)

# Layers the S-57 driver exposes that are not chart features: the dataset
# identification record, and the topological primitives edges and nodes are
# built from. RETURN_PRIMITIVES=OFF is supposed to suppress the primitives and
# does not (verified: they are listed either way), so they are excluded by name.
NON_FEATURE_LAYERS="DSID IsolatedNode ConnectedNode Edge Face"

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
  # Match the layer name without requiring a parenthesised geometry type.
  # Most S-57 layers report "Unknown (any)" geometry and ogrinfo then prints
  # them bare, as "12: DEPARE" - so a pattern anchored on "(" silently drops
  # DEPARE, LNDARE, COALNE, OBSTRN and WRECKS, which is to say every layer this
  # renderer draws. Verified against a NOAA cell: 25 of 62 layers matched.
  mapfile -t ALL_LAYERS < <(ogrinfo -q "${OO_OPTS[@]}" "$CELL_PATH" 2>/dev/null \
    | grep -oP '^\d+:\s*\K[A-Za-z0-9_]+')

  LAYERS=()
  for CANDIDATE in "${ALL_LAYERS[@]}"; do
    case " $NON_FEATURE_LAYERS " in
      *" $CANDIDATE "*) continue ;;
    esac
    LAYERS+=("$CANDIDATE")
  done
  if [ "${#LAYERS[@]}" -eq 0 ]; then
    echo "    WARNING: $CELL_NAME has no readable layers, skipping" >&2
    continue
  fi

  : > "$WORK/$CELL_NAME.geojsonl"
  CELL_OK=0
  CELL_FEATURES=0
  CLASS_REPORT=()
  USAGE_BAND="${CELL_NAME:2:1}"

  for LAYER in "${LAYERS[@]}"; do
    LAYER_FILE="$WORK/$CELL_NAME.$LAYER.geojsonl"
    # -skipfailures: a single malformed feature must not abandon a whole layer.
    if ogr2ogr -f GeoJSONSeq "$LAYER_FILE" "${OO_OPTS[@]}" "$CELL_PATH" "$LAYER" \
        -t_srs EPSG:4326 -skipfailures -lco RS=NO 2>"$WORK/err.txt"; then
      CELL_OK=1
      COUNT=$(python3 "$SCRIPT_DIR/tag_features.py" \
        "$LAYER_FILE" "$CELL_NAME" "$USAGE_BAND" "$LAYER" \
        "$WORK/$CELL_NAME.geojsonl")
      CELL_FEATURES=$((CELL_FEATURES + COUNT))
      [ "$COUNT" -gt 0 ] && CLASS_REPORT+=("$LAYER=$COUNT")
    else
      # Never silently. A layer that fails to convert is data missing from the
      # chart, and the whole reason the original bug went unnoticed is that its
      # warning was being discarded.
      echo "    WARNING: layer $LAYER failed: $(tail -1 "$WORK/err.txt")" >&2
    fi
    rm -f "$LAYER_FILE"
  done

  if [ "$CELL_OK" -eq 0 ] || [ "$CELL_FEATURES" -eq 0 ]; then
    echo "    WARNING: $CELL_NAME produced no features, skipping" >&2
    rm -f "$WORK/$CELL_NAME.geojsonl"
    continue
  fi

  # Report what each cell actually contributed, by object class. This is the
  # check that would have caught the original bug on its first run instead of
  # at the point someone noticed the chart was mostly empty.
  echo "    ${#LAYERS[@]} layers, $CELL_FEATURES features"
  echo "      ${CLASS_REPORT[*]}" | fold -s -w 100 | sed 's/^/      /'
done

echo "Building tiles"
# One layer per S-57 object class, so the style can address them individually.
# -z16 reaches berthing scale; -Z0 keeps an overview usable.
# -l names the layer for ALL input files. The -L form previously used here
# takes a per-file JSON description and silently matched nothing, so tippecanoe
# fell back to deriving the name from the filename ("US5NY1CMgeojsonl") - which
# would never match the `source-layer: 'enc'` every style layer asks for.
tippecanoe -o "$OUTPUT/charts.pmtiles" --force \
  -Z0 -z16 \
  -l enc \
  --drop-densest-as-needed \
  --extend-zooms-if-still-dropping \
  --no-tile-compression \
  "$WORK"/*.geojsonl 2>&1 | grep -vE "Reordering geometry|^ *[0-9.]+%" || true

echo "Writing catalogue"
python3 "$SCRIPT_DIR/write_catalogue.py" "$EXCHANGE_SET" "$OUTPUT/catalogue.json"

echo "Done. Output in $OUTPUT"

#!/usr/bin/env bash
# Zips the Factorio mod for its release: orrery_<version>.zip whose single top folder is orrery_<version>/
# (the mod portal's layout). The version goes into the zip's copy of info.json; the source stays as it is.
#   bash .github/factorio-zip.sh <mod dir> <version> <out dir>
set -euo pipefail
dir=${1%/} v=$2 out=$3
die() { echo "factorio-zip: $*" >&2; exit 1; }
[[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "want a version X.Y.Z, got '$v'"
[[ $(find "$dir" -name info.json) == "$dir/info.json" ]] && jq -e '.name == "orrery"' "$dir/info.json" > /dev/null ||
  die 'want one info.json, at the top, named orrery'
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
cp -R "$dir/." "$T/orrery_$v"
rm -f "$T/orrery_$v/CLAUDE.md" # notes for agents, not for every player who downloads the mod
jq --arg v "$v" '.version = $v' "$dir/info.json" > "$T/orrery_$v/info.json"
(cd "$T" && zip -qrX "orrery_$v.zip" "orrery_$v")
mkdir -p "$out"
mv "$T/orrery_$v.zip" "$out/"

#!/usr/bin/env bash
# Names the Mod's built jar for its release: orrery-<minecraft>-<version>.jar, one per Minecraft target.
#   bash .github/mod-jars.sh <mod dir> <out dir>
set -euo pipefail
mod=$1 out=$2
mc=$(sed -n 's/^minecraftVersion *= *//p' "$mod/gradle.properties")
jars=()
for f in "$mod"/build/libs/orrery-*.jar; do
  [[ -f $f && $f != *-dev.jar && $f != *-sources.jar ]] && jars+=("$f")
done
[[ -n $mc && ${#jars[@]} -eq 1 ]] || { echo "mod-jars: want one built jar and a minecraftVersion" >&2; exit 1; }
v=$(basename "${jars[0]}" .jar)
mkdir -p "$out"
cp "${jars[0]}" "$out/orrery-$mc-${v#orrery-}.jar"

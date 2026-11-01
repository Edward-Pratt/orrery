#!/usr/bin/env bash
# Packs the agent for its release: a gzipped tar of the agent's folder without node_modules/ and test/, file modes kept,
# its members named ./… as setup-agent-host.sh and deploy-agent.sh unpack them. The version goes into the tarball's copy
# of package.json, which the agent reports as agent-v<version>; the source stays as it is.
#   bash .github/agent-tarball.sh <agent dir> <version> <out file>
set -euo pipefail
umask 022 # the stamped package.json 644, like the checkout's files
dir=${1%/} v=$2 out=$3
die() { echo "agent-tarball: $*" >&2; exit 1; }
[[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "want a version X.Y.Z, got '$v'"
jq -e '.name == "orrery-agent"' "$dir/package.json" > /dev/null 2>&1 || die 'want a package.json named orrery-agent'
[[ -f $dir/src/index.ts ]] || die 'want src/index.ts'
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir "$T/a"
tar -cf - -C "$dir" --exclude=./node_modules --exclude=./test . | tar -xpf - -C "$T/a" # -p: the modes as they are
jq --arg v "$v" '.version = $v' "$dir/package.json" > "$T/a/package.json"
tar -czf "$out" -C "$T/a" .

#!/usr/bin/env bash
# A release's notes: the part's commits since its previous tag. Shared by release.yml and release.sh.
#   bash .github/notes.sh <hub|mod|web> <rev>
set -euo pipefail
part=$1 rev=$2
prev=$(git describe --tags --abbrev=0 --match "$part-v*" "$rev^" 2>/dev/null || true)
git log --oneline --no-decorate --no-color "${prev:+$prev..}$rev" -- "$part/"

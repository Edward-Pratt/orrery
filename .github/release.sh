#!/usr/bin/env bash
# Cuts a part's next release: tags HEAD of an up-to-date main and pushes only that tag (release.yml does the rest).
#   .github/release.sh <hub|mod|web> <major|minor|patch> [--yes]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
die() { echo "release: $*" >&2; exit 1; }

[[ $# -ge 2 && $1 =~ ^(hub|mod|web)$ && $2 =~ ^(major|minor|patch)$ && ($# -eq 2 || ($# -eq 3 && $3 == --yes)) ]] ||
  die 'usage: release.sh <hub|mod|web> <major|minor|patch> [--yes]'
part=$1 level=$2 yes=${3:-}

[[ $(git branch --show-current) == main ]] || die 'not on main'
[[ -z $(git status --porcelain --untracked-files=no) ]] || die 'uncommitted changes'
git fetch -q origin main
[[ -z $(git rev-list HEAD..origin/main) ]] || die 'behind origin/main: pull first'
[[ -z $(git rev-list origin/main..HEAD) ]] || die 'ahead of origin/main: push main first'

old=$(git tag -l "$part-v*" | grep -E "^$part-v[0-9]+\.[0-9]+\.[0-9]+$" | sort -V | tail -1 || true)
IFS=. read -r major minor patch <<< "${old#"$part-v"}" || true
major=${major:-0} minor=${minor:-0} patch=${patch:-0}
case $level in
  major) new=$((major + 1)).0.0 ;;
  minor) new=$major.$((minor + 1)).0 ;;
  patch) new=$major.$minor.$((patch + 1)) ;;
esac
new=$part-v$new

# A part tag on HEAD means nothing new: release.yml would take the notes from HEAD^ and repeat them.
[[ -z $(git tag --points-at HEAD -l "$part-v*") ]] || die "nothing to release: HEAD is already tagged for $part"
notes=$(bash "$HERE/notes.sh" "$part" HEAD)
[[ -n $notes ]] || die "nothing to release: no commits under $part/ since ${old:-the start}"

echo "${old:-(none)} → $new"
echo
echo "$notes"
echo
if [[ $yes != --yes ]]; then
  answer=
  read -r -p "Push $new? [y/N] " answer || true
  [[ $answer == y ]] || { echo 'Nothing pushed.'; exit 1; }
fi

git tag "$new"
git push -q origin "refs/tags/$new"
slug=$(git remote get-url origin)
slug=${slug#*github.com[:/]}
echo "Pushed $new: https://github.com/${slug%.git}/actions/workflows/release.yml"

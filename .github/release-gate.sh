#!/usr/bin/env bash
# The release's gate: a tag is released only if main's CI passed on its commit (release.sh tags only a pushed main).
# Finds the newest CI run of a push to main for <sha>: none fails; one still going is watched to its end; one that ended
# any way but success fails. A failed run can be re-run on main, and then the Release run: this asks again.
#   GH_TOKEN=… bash .github/release-gate.sh <owner/repo> <sha>
set -euo pipefail
[[ $# -eq 2 ]] || { echo "usage: $0 <owner/repo> <sha>" >&2; exit 2; }
repo=$1 sha=$2
die() { echo "release-gate: $*" >&2; exit 1; }

run=$(gh api "repos/$repo/actions/workflows/ci.yml/runs?head_sha=$sha&branch=main&event=push&per_page=1" \
  --jq '.workflow_runs[0] | select(.) | "\(.id) \(.status) \(.conclusion // "")"')
[[ -n $run ]] || die "no CI run of a push to main for $sha: push main and let CI pass first"
read -r id status conclusion <<< "$run"
if [[ $status != completed ]]; then
  echo "CI run $id on main is $status: waiting for it"
  gh run watch "$id" --repo "$repo" --exit-status > /dev/null || true # the conclusion below decides, not watch's exit
  conclusion=$(gh api "repos/$repo/actions/runs/$id" --jq '.conclusion // ""')
fi
[[ $conclusion == success ]] || die "CI run $id on main ended ${conclusion:-without a conclusion} for $sha: re-run it, then this release"
echo "CI run $id on main passed for $sha"

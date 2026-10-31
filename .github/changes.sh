#!/usr/bin/env bash
# Which parts CI runs. Reads REF_TYPE and REF_NAME from the environment and the changed files on stdin;
# pass `unknown` when the base can't be diffed, and every part runs. Prints GITHUB_OUTPUT lines.
#   git diff --name-only BASE...HEAD | REF_TYPE=branch REF_NAME=main bash .github/changes.sh
set -euo pipefail
hub=false mod=false web=false deploy=false agent=false factorio=false

if [[ ${REF_TYPE:-} == tag ]]; then
  # A release tag runs only its own part; no release ships deploy/.
  case ${REF_NAME%%-v*} in
    hub) hub=true ;; mod) mod=true ;; web) web=true ;; agent) agent=true ;; factorio) factorio=true ;;
  esac
elif [[ ${1:-} == unknown ]]; then
  hub=true mod=true web=true deploy=true agent=true factorio=true
else
  while IFS= read -r f; do
    case $f in
      .github/*) hub=true mod=true web=true deploy=true agent=true factorio=true ;;
      # The web build type-checks against exactly these two hub files, and the agent imports types.ts;
      # types.ts imports nothing. If api.ts or types.ts ever import another hub file, add it here.
      hub/src/api.ts | hub/src/types.ts) hub=true web=true agent=true ;;
      hub/*) hub=true ;;
      web/*) web=true ;;
      mod/*) mod=true ;;
      agent/*) agent=true ;;
      factorio/*) factorio=true ;;
      deploy/*) deploy=true ;;
    esac
  done
fi

printf 'hub=%s\nmod=%s\nweb=%s\ndeploy=%s\nagent=%s\nfactorio=%s\n' "$hub" "$mod" "$web" "$deploy" "$agent" "$factorio"

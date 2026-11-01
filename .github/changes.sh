#!/usr/bin/env bash
# Which parts CI runs. Reads REF_TYPE and REF_NAME from the environment and the changed files on stdin;
# pass `unknown` when the base can't be diffed, and every part runs. Prints GITHUB_OUTPUT lines.
#   git diff --name-only BASE...HEAD | REF_TYPE=branch REF_NAME=main bash .github/changes.sh
set -euo pipefail
hub=false mod=false web=false deploy=false agent=false factorio=false

if [[ ${REF_TYPE:-} == tag ]]; then
  # A release tag runs only its own part. An agent tag also runs deploy/'s tests: the agent Host's setup script and
  # the deploy/ files it installs are fetched at that tag.
  case ${REF_NAME%%-v*} in
    hub) hub=true ;; mod) mod=true ;; web) web=true ;; agent) agent=true deploy=true ;; factorio) factorio=true ;;
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
      # The agent's tests load these at runtime, to check the agent's copies against them: protocol.ts (the
      # parsers and LIMITS), factorio.ts (GAME_MODS) and agents.ts (HANDSHAKE_MS). agents.ts loads servers.ts and
      # its imports too, but no constant the agent compares lives there: a change to them that breaks loading
      # fails the hub's own tests, so they stay hub-only.
      hub/src/protocol.ts | hub/src/factorio.ts | hub/src/agents.ts) hub=true agent=true ;;
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

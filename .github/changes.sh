#!/usr/bin/env bash
# Which parts CI runs, from the changed files on stdin; pass `unknown` when the base can't be diffed, and every part
# runs. Prints GITHUB_OUTPUT lines. A release tag doesn't run CI: release.yml trusts main's run (release-gate.sh).
#   git diff --name-only BASE...HEAD | bash .github/changes.sh
set -euo pipefail
hub=false mod=false web=false deploy=false agent=false factorio=false

if [[ ${1:-} == unknown ]]; then
  hub=true mod=true web=true deploy=true agent=true factorio=true
else
  while IFS= read -r f; do
    case $f in
      .github/*) hub=true mod=true web=true deploy=true agent=true factorio=true ;;
      # The web build type-checks against api.ts, types.ts and what they import, and the agent imports types.ts.
      # test-changes.sh checks this against the live tree: an import added there without a line here fails it.
      hub/src/api.ts | hub/src/types.ts) hub=true web=true agent=true ;;
      hub/src/api-*.ts | hub/src/users/permissions.ts) hub=true web=true ;;
      # The agent's tests load these at runtime, to check the agent's copies against them: protocol.ts (the
      # parsers and LIMITS), factorio.ts (GAME_MODS) and agents.ts (HANDSHAKE_MS). agents.ts loads servers.ts and
      # its imports too, but no constant the agent compares lives there: a change to them that breaks loading
      # fails the hub's own tests, so they stay hub-only.
      hub/src/protocol.ts | hub/src/updates/factorio.ts | hub/src/agents/agents.ts) hub=true agent=true ;;
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

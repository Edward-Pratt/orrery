#!/usr/bin/env bash
# Tests changes.sh: which parts CI runs for a list of changed files, and its map against the live tree's imports.
#   bash .github/test-changes.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)

# run [unknown] <<< files  →  "hub mod web deploy agent factorio" as 1/0
run() {
  bash "$HERE/changes.sh" ${1:-} |
    sed -nE 's/^(hub|mod|web|deploy|agent|factorio)=//p' | sed 's/true/1/;s/false/0/' | tr '\n' ' ' | sed 's/ $//'
}
check() {
  local got; got=$(run "${@:3}" <<< "$2")
  if [[ $got == "$1" ]]; then echo "ok   $1 ← ${2//$'\n'/, } ${*:3}"
  else echo "FAIL want $1, got $got ← ${2//$'\n'/, } ${*:3}"; exit 1; fi
}

#     hub mod web deploy agent factorio
check '0 0 0 0 0 0' $'README.md\ndocs/protocol.md\nCLAUDE.md'
check '0 0 0 0 0 0' ''
check '1 0 0 0 0 0' hub/src/servers/servers.ts
check '0 1 0 0 0 0' mod/build.gradle
check '0 0 1 0 0 0' web/src/app/app.ts
check '0 0 0 1 0 0' deploy/install-web.sh
check '0 0 0 1 0 0' deploy/test-add-server.sh
check '0 0 0 1 0 0' $'deploy/setup-agent-host.sh\ndeploy/test-setup-agent-host.sh\ndeploy/factorio.container'
check '0 0 0 1 0 0' $'deploy/deploy-agent.sh\ndeploy/test-deploy-agent.sh\ndeploy/orrery-hub.service'
check '1 0 1 0 1 0' hub/src/api.ts
check '1 0 1 0 1 0' hub/src/types.ts
check '1 0 1 0 0 0' hub/src/api-users.ts
check '1 0 1 0 0 0' hub/src/users/permissions.ts
check '1 0 0 0 1 0' hub/src/protocol.ts
check '1 0 0 0 1 0' hub/src/updates/factorio.ts
check '1 0 0 0 1 0' hub/src/updates/factorio-fetch.ts
check '1 0 0 0 1 0' hub/src/agents/agents.ts
check '1 0 0 0 0 0' hub/package.json
check '0 0 0 0 1 0' agent/src/main.ts
check '0 0 0 0 0 1' factorio/control.lua
check '1 1 0 1 0 0' $'hub/src/start.ts\nmod/src/x.java\ndeploy/Caddyfile\ndocs/ROADMAP.md'
check '1 1 1 1 1 1' .github/workflows/ci.yml
check '1 1 1 1 1 1' $'.github/changes.sh\ndocs/x.md'
check '1 1 1 1 1 1' docs/x.md unknown

# The map against the live tree. The dashboard's build compiles hub/src/api.ts and types.ts and everything they import
# (types only, but a break there fails only that build), so their whole import tree must run the web job. The agent's
# tests and typecheck load what agent/ imports from hub/src directly (protocol.ts's own imports are the hub's tests'
# job), so each of those must run the agent job. Each path is asked of changes.sh itself.
ROOT=$(cd "$HERE/.." && pwd)
imports() { # <file>: the repo paths of its relative imports and re-exports, one per line
  local dir; dir=$(dirname "$1")
  { grep -oE "(from|import\() *['\"]\.{1,2}/[^'\"]+['\"]" "$ROOT/$1" || true; } | sed -E "s/^(from|import\() *['\"]//; s/['\"]$//" |
    while IFS= read -r rel; do realpath -m --relative-to="$ROOT" "$ROOT/$dir/$rel"; done
}
runs() { # <part> <path>: changes.sh runs that part for a change to this one path
  bash "$HERE/changes.sh" <<< "$2" | grep -qx "$1=true"
}
guard() { # <part> <why> <path>...
  local part=$1 why=$2 p; shift 2
  for p in "$@"; do
    runs "$part" "$p" || { echo "FAIL $p: $why, but changes.sh doesn't run $part for it"; exit 1; }
  done
  echo "ok   $part runs for each of: $*"
}
web_tree=() todo=(hub/src/api.ts hub/src/types.ts)
while ((${#todo[@]})); do
  f=${todo[0]} todo=("${todo[@]:1}")
  [[ " ${web_tree[*]} " == *" $f "* ]] && continue
  web_tree+=("$f")
  while IFS= read -r i; do todo+=("$i"); done < <(imports "$f")
done
guard web 'the dashboard build compiles it' "${web_tree[@]}"
agent_imports=()
while IFS= read -r i; do agent_imports+=("$i"); done < <(
  for f in $(cd "$ROOT" && git ls-files 'agent/src/*.ts' 'agent/test/*.ts'); do imports "$f"; done | grep '^hub/src/' | sort -u)
guard agent "agent/ imports it" "${agent_imports[@]}"

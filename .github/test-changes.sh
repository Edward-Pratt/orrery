#!/usr/bin/env bash
# Tests changes.sh: which parts CI runs for a list of changed files.
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
check '1 0 0 0 1 0' hub/src/protocol.ts
check '1 0 0 0 1 0' hub/src/updates/factorio.ts
check '1 0 0 0 1 0' hub/src/agents/agents.ts
check '1 0 0 0 0 0' hub/package.json
check '0 0 0 0 1 0' agent/src/main.ts
check '0 0 0 0 0 1' factorio/control.lua
check '1 1 0 1 0 0' $'hub/src/start.ts\nmod/src/x.java\ndeploy/Caddyfile\ndocs/ROADMAP.md'
check '1 1 1 1 1 1' .github/workflows/ci.yml
check '1 1 1 1 1 1' $'.github/changes.sh\ndocs/x.md'
check '1 1 1 1 1 1' docs/x.md unknown

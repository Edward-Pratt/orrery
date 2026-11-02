#!/usr/bin/env bash
# Tests changes.sh: which parts CI runs for a ref and a list of changed files.
#   bash .github/test-changes.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)

# run REF_TYPE REF_NAME [unknown] <<< files  →  "hub mod web deploy agent factorio" as 1/0
run() {
  REF_TYPE=$1 REF_NAME=$2 bash "$HERE/changes.sh" ${3:-} |
    sed -nE 's/^(hub|mod|web|deploy|agent|factorio)=//p' | sed 's/true/1/;s/false/0/' | tr '\n' ' ' | sed 's/ $//'
}
check() {
  local got; got=$(run "${@:3}" <<< "$2")
  if [[ $got == "$1" ]]; then echo "ok   $1 ← ${2//$'\n'/, } ${*:3}"
  else echo "FAIL want $1, got $got ← ${2//$'\n'/, } ${*:3}"; exit 1; fi
}

#     hub mod web deploy agent factorio
check '0 0 0 0 0 0' $'README.md\ndocs/protocol.md\nCLAUDE.md' branch main
check '0 0 0 0 0 0' '' branch main
check '1 0 0 0 0 0' hub/src/servers/servers.ts branch main
check '0 1 0 0 0 0' mod/build.gradle branch main
check '0 0 1 0 0 0' web/src/app/app.ts branch main
check '0 0 0 1 0 0' deploy/install-web.sh branch main
check '0 0 0 1 0 0' deploy/test-add-server.sh branch main
check '0 0 0 1 0 0' $'deploy/setup-agent-host.sh\ndeploy/test-setup-agent-host.sh\ndeploy/factorio.container' branch main
check '0 0 0 1 0 0' $'deploy/deploy-agent.sh\ndeploy/test-deploy-agent.sh\ndeploy/orrery-hub.service' branch main
check '1 0 1 0 1 0' hub/src/api.ts branch main
check '1 0 1 0 1 0' hub/src/types.ts branch main
check '1 0 0 0 1 0' hub/src/protocol.ts branch main
check '1 0 0 0 1 0' hub/src/updates/factorio.ts branch main
check '1 0 0 0 1 0' hub/src/agents/agents.ts branch main
check '1 0 0 0 0 0' hub/package.json branch main
check '0 0 0 0 1 0' agent/src/main.ts branch main
check '0 0 0 0 0 1' factorio/control.lua branch main
check '1 1 0 1 0 0' $'hub/src/start.ts\nmod/src/x.java\ndeploy/Caddyfile\ndocs/ROADMAP.md' branch main
check '1 1 1 1 1 1' .github/workflows/ci.yml branch main
check '1 1 1 1 1 1' $'.github/changes.sh\ndocs/x.md' branch main
check '1 1 1 1 1 1' docs/x.md branch main unknown
check '1 0 0 0 0 0' $'mod/x\nweb/y\ndeploy/z' tag hub-v1.2.3
check '0 1 0 0 0 0' .github/workflows/ci.yml tag mod-v1.2.3
check '0 0 1 0 0 0' '' tag web-v0.3.1
check '0 0 0 1 1 0' hub/src/types.ts tag agent-v1.0.0
check '0 0 0 0 0 1' agent/src/main.ts tag factorio-v1.0.0
check '0 0 0 0 0 0' deploy/install-web.sh tag deploy-v1.0.0
check '0 0 1 0 0 0' hub/src/servers/servers.ts tag web-v0.3.1 unknown

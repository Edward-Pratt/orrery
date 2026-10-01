#!/usr/bin/env bash
# Deploys one hub release next to the running one, flips <root>/current to it, and rolls back if it won't stay up.
# Run by orrery-deploy@<tag>.service as the hub's user (never root), not by hand:
#   bash <root>/current/deploy/deploy-hub.sh <root> <hubUnit> <hub-vX.Y.Z>
# It runs from the running release's copy, so a broken new release can't break its own Rollback. Bash reads the file
# it opened, so flipping `current` under it is safe; never re-exec this script through the `current` path.
# Writes <root>/deploy-status.json: {"tag","from","outcome":"ok"|"failed"|"rolled back","finished","log"}.
# GITHUB_TOKEN (optional, from the unit's EnvironmentFile) is sent as an HTTP header, never in the URL or the log.
# ORRERY_REPO, DEPLOY_GATE_SECONDS and DEPLOY_GATE_POLL exist for the tests (deploy/test-deploy.sh).
set -euo pipefail
[[ $# -eq 3 ]] || { echo "usage: $0 <root> <hubUnit> <hub-vX.Y.Z>" >&2; exit 2; }
root=$1 unit=$2 tag=$3
repo=${ORRERY_REPO:-https://github.com/Edward-Pratt/orrery.git}
gate=${DEPLOY_GATE_SECONDS:-30} poll=${DEPLOY_GATE_POLL:-2}

[[ $tag =~ ^hub-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a hub-vX.Y.Z tag: $tag" >&2; exit 2; }
[[ $(id -u) -ne 0 ]] || { echo "refusing to run as root: run as the hub's user" >&2; exit 2; }
exec 9> "$root/deploy.lock"
flock -n 9 || { echo "another deploy holds $root/deploy.lock" >&2; exit 1; }
from=$(readlink "$root/current") || { echo "no $root/current to deploy over" >&2; exit 1; }
from=$(basename "$from")
[[ $from != "$tag" ]] || { echo "$tag is already running" >&2; exit 1; }
rm -f "$root/deploy-status.json" # the restarted hub must not mistake an earlier deploy's outcome for this one's

# Everything from here goes to the log, whose last 40 lines become the status file's excerpt; the journal gets it at exit.
log=$(mktemp)
exec 3>&1 > "$log" 2>&1
trap 'cat "$log" >&3; rm -f "$log"' EXIT

finish() { # <outcome>: writes the status file atomically, prunes releases/, exits
  echo "$(date -Is) $1"
  TAG=$tag FROM=$from OUTCOME=$1 EXCERPT=$(tail -n 40 "$log") node -e '
    const e = process.env;
    const s = { tag: e.TAG, from: e.FROM, outcome: e.OUTCOME, finished: new Date().toISOString(), log: e.EXCERPT };
    process.stdout.write(JSON.stringify(s) + "\n");' > "$root/.deploy-status.json.tmp"
  mv "$root/.deploy-status.json.tmp" "$root/deploy-status.json"
  # The three newest releases, plus whatever current points at.
  local keep i=0 r
  keep=$(basename "$(readlink "$root/current")")
  while IFS= read -r r; do
    if ((i++ >= 3)) && [[ $r != "$keep" ]]; then echo "pruning $r"; rm -rf "${root:?}/releases/$r"; fi
  done < <(ls -1t "$root/releases")
  [[ $1 == ok ]] && exit 0
  exit 1
}

up() { # true if the unit stays active/running with one MainPID for the whole gate
  local end=$((SECONDS + gate)) first='' k v a s p
  while :; do
    a='' s='' p=''
    while IFS='=' read -r k v; do
      case $k in ActiveState) a=$v ;; SubState) s=$v ;; MainPID) p=$v ;; esac
    done < <(systemctl show -p ActiveState -p SubState -p MainPID "$unit")
    first=${first:-$p}
    if [[ $a != active || $s != running || $p == 0 || $p != "$first" ]]; then
      echo "$unit didn't stay up: ActiveState=$a SubState=$s MainPID=$p (was $first)"
      return 1
    fi
    ((SECONDS < end)) || return 0
    sleep "$poll"
  done
}

flip() { # <release>: points current at releases/<release> in one rename
  ln -sfn "releases/$1" "$root/current.new" && mv -T "$root/current.new" "$root/current"
  echo "current -> releases/$1; restarting $unit"
  systemctl restart "$unit" || echo "systemctl restart $unit failed"
}

echo "$(date -Is) deploying $tag over $from"
dir=$root/releases/$tag
rm -rf "$dir" # a leftover from an interrupted deploy, or an older release kept on disk: build it afresh
mkdir -p "$root/releases"
clone() (
  if [[ -n ${GITHUB_TOKEN:-} ]]; then
    # Through git's environment config, so the header is in neither a command line (ps) nor the log.
    export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader
    GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)"
    export GIT_CONFIG_VALUE_0
  fi
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$tag" "$repo" "$dir"
)
if ! clone || ! (cd "$dir/hub" && npm ci --omit=dev); then
  rm -rf "$dir"
  finish failed
fi

flip "$tag"
if up; then finish ok; fi
echo "rolling back to $from"
flip "$from"
if up; then finish 'rolled back'; fi
echo "$from didn't come up either: leaving it in place"
finish failed

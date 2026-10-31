#!/usr/bin/env bash
# Managed by orrery deploy/setup-agent-host.sh. Do not edit: re-run the script.
# Deploys one agent release next to the running one, flips /srv/orrery-agent/current to it, and rolls back if the new
# agent won't connect to the hub. Run by orrery-agent-deploy@<tag>.service as factorio (never root), not by hand:
#   bash /usr/local/lib/orrery/deploy-agent.sh <agent-vX.Y.Z>
# It runs from setup-agent-host.sh's root-owned copy, so neither a release nor the agent can change what rolls it back.
# The release comes from the public GitHub release, with no token: orrery-<tag>.tar.gz (orrery-agent-vX.Y.Z.tar.gz),
# checked against its .sha256, and refused unless it holds only plain files and folders, all inside its own top folder.
# The gate: within DEPLOY_GATE_SECONDS of the restart, the agent writes <root>/connected after the hub's welcome,
#   {"version":"agent-vX.Y.Z","time":<epoch ms>}
# naming this tag with a time from the restart on. Otherwise current flips back, and the old agent must connect.
# Writes <root>/deploy-status.json: {"tag","from","outcome":"ok"|"failed"|"rolled back","finished","log"}.
# It removes that file when it starts and writes it only at the end, after the gate: so the restarted agent (the new
# one, or the old one after a rollback) connects before its outcome exists. The agent reads it only once
# orrery-agent-deploy@<tag>.service has left activating, active, reloading and deactivating (as hub/src/deploys.ts
# watches deploy-hub.sh's unit), then sends deployResult from it.
# DEPLOY_ROOT, DEPLOY_GATE_SECONDS and DEPLOY_GATE_POLL exist for the tests (deploy/test-deploy-agent.sh).
set -euo pipefail
[[ $# -eq 1 ]] || { echo "usage: $0 <agent-vX.Y.Z>" >&2; exit 2; }
tag=$1 root=${DEPLOY_ROOT:-/srv/orrery-agent} unit=orrery-agent.service
gate=${DEPLOY_GATE_SECONDS:-60} poll=${DEPLOY_GATE_POLL:-2}
# -q first: no .curlrc. Never a header: the release is public.
CURL=(curl -q -fsSL --proto =https --proto-redir =https --retry 2)

[[ $tag =~ ^agent-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not an agent-vX.Y.Z tag: $tag" >&2; exit 2; }
[[ $(id -u) -ne 0 ]] || { echo "refusing to run as root: run as factorio" >&2; exit 2; }
exec 9> "$root/deploy.lock"
flock -n 9 || { echo "another deploy holds $root/deploy.lock" >&2; exit 1; }
prev=$(readlink "$root/current") || { echo "no $root/current to deploy over" >&2; exit 1; }
from=$(basename "$prev") # the link itself is what a Rollback restores, wherever it pointed
[[ $from != "$tag" ]] || { echo "$tag is already running" >&2; exit 1; }
rm -f "$root/deploy-status.json" # the restarted agent must not report an earlier deploy's outcome as this one's

# Everything from here goes to the log, whose last 40 lines become the status file's excerpt; the journal gets it at exit.
log=$(mktemp) inc=''
exec 3>&1 > "$log" 2>&1
trap 'cat "$log" >&3; rm -f "$log"; if [[ -n $inc ]]; then rm -rf "$inc"; fi' EXIT

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

fetch() { # downloads the release into $inc, checks it, and unpacks it into $inc/x
  local base=https://github.com/Edward-Pratt/orrery/releases/download/$tag tgz=orrery-$tag.tar.gz sum h list names n
  sum=$("${CURL[@]}" "$base/$tgz.sha256") || { echo "can't download $tgz.sha256"; return 1; }
  sum=${sum%% *}
  [[ $sum =~ ^[0-9a-f]{64}$ ]] || { echo "$tgz.sha256 holds no sha256"; return 1; }
  "${CURL[@]}" -o "$inc/$tgz" "$base/$tgz" || { echo "can't download $tgz"; return 1; }
  read -r h _ < <(sha256sum "$inc/$tgz")
  [[ $h == "$sum" ]] || { echo "the download of $tgz doesn't match its .sha256"; return 1; }
  # GNU tar lists one member per line (it escapes newlines in names), in the same order with and without -v.
  list=$(tar -tvzf "$inc/$tgz") && names=$(tar -tzf "$inc/$tgz") || { echo "$tgz isn't a gzipped tar"; return 1; }
  [[ -n $list ]] && ! grep -qv '^[-d]' <<< "$list" || { echo "$tgz holds a link or a special file: refused"; return 1; }
  [[ $(wc -l <<< "$list") == "$(wc -l <<< "$names")" ]] || { echo "$tgz lists differently with -v: refused"; return 1; }
  while IFS= read -r n; do
    [[ $n != /* && /$n/ != */../* ]] || { echo "$tgz holds a name outside its folder: $n (refused)"; return 1; }
  done <<< "$names"
  mkdir "$inc/x" && tar -xzf "$inc/$tgz" --no-same-owner -C "$inc/x" || { echo "can't unpack $tgz"; return 1; }
  [[ -f $inc/x/src/index.ts && ! -L $inc/x/src/index.ts ]] || { echo "$tgz has no src/index.ts"; return 1; }
  touch "$inc/x" # tar gave it the archive's time; pruning keeps the newest installed
}

connected() { # <version> <since, epoch ms>: true once <root>/connected names <version> with a time from <since> on
  local end=$((SECONDS + gate))
  while :; do
    if node -e '
      const [, file, version, since] = process.argv;
      let c = null;
      try { c = JSON.parse(require("fs").readFileSync(file, "utf8")); } catch {}
      process.exit(c?.version === version && Number.isFinite(c.time) && c.time >= Number(since) ? 0 : 1);' \
      "$root/connected" "$1" "$2"; then
      echo "$1 connected"
      return 0
    fi
    if ((SECONDS >= end)); then echo "$1 didn't connect within ${gate}s"; return 1; fi
    sleep "$poll"
  done
}

flip() { # <target>: points current at it in one rename, then restarts the agent
  ln -sfn "$1" "$root/current.new" && mv -T "$root/current.new" "$root/current"
  echo "current -> $1; restarting $unit"
  systemctl restart "$unit" || echo "systemctl restart $unit failed"
}

echo "$(date -Is) deploying $tag over $from"
mkdir -p "$root/releases" "$root/.incoming"
inc=$(mktemp -d "$root/.incoming/$tag.XXXXXX")
if ! fetch; then finish failed; fi
dir=$root/releases/$tag
rm -rf "$dir" # an older copy kept on disk: the fresh download replaces it
mv -T "$inc/x" "$dir"

since=$(date +%s%3N)
flip "releases/$tag"
if connected "$tag" "$since"; then finish ok; fi
echo "rolling back to $from"
since=$(date +%s%3N)
flip "$prev"
if connected "$from" "$since"; then finish 'rolled back'; fi
echo "$from didn't connect either: leaving it in place"
finish failed

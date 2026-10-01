#!/usr/bin/env bash
# Installs one dashboard release with install-web.sh (next to this script) and records the outcome for the hub.
# Run as root by orrery-deploy-web@<tag>.service, not by hand:
#   bash /usr/local/lib/orrery/deploy-web.sh <root> <webDir> <web-vX.Y.Z>
# GITHUB_TOKEN (from the unit's EnvironmentFile) is handed to gh as GH_TOKEN. Writes <root>/deploy-status.json:
# {"tag","from","outcome":"ok"|"failed","finished","log"}, written as <root>'s owner (the hub's user).
set -euo pipefail
[[ $# -eq 3 ]] || { echo "usage: $0 <root> <webDir> <web-vX.Y.Z>" >&2; exit 2; }
root=$1 web=$2 tag=$3
[[ $tag =~ ^web-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a web-vX.Y.Z tag: $tag" >&2; exit 2; }
from=$(cat "$web.release" 2> /dev/null || true)

log=$(mktemp)
trap 'rm -f "$log" "$log.json"' EXIT
rm -f "$root/deploy-status.json" # rm never follows a symlink
outcome=ok
WEB_DIR=$web GH_TOKEN=${GITHUB_TOKEN:-} bash "$(dirname "$0")/install-web.sh" "$tag" 2>&1 | tee "$log" || outcome=failed

TAG=$tag FROM=$from OUTCOME=$outcome EXCERPT=$(tail -n 40 "$log") node -e '
  const e = process.env;
  const s = { tag: e.TAG, from: e.FROM, outcome: e.OUTCOME, finished: new Date().toISOString(), log: e.EXCERPT };
  process.stdout.write(JSON.stringify(s) + "\n");' > "$log.json"
# <root> belongs to the hub's user, who could plant a symlink there: write as that user, never as root.
write='cat > "$1.tmp" && chmod 644 "$1.tmp" && mv -T "$1.tmp" "$1"'
if [[ $(id -u) -eq 0 ]]; then
  runuser -u "$(stat -c %U "$root")" -- sh -c "$write" _ "$root/deploy-status.json" < "$log.json"
else
  sh -c "$write" _ "$root/deploy-status.json" < "$log.json"
fi
[[ $outcome == ok ]]

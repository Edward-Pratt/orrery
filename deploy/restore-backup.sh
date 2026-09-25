#!/usr/bin/env bash
# Puts a ServerUtilities backup back in place of a stopped GTNH server's world. Run as the server's user, not root.
#   deploy/restore-backup.sh              list backups (newest first) and pre-restore worlds
#   deploy/restore-backup.sh latest       restore the newest backup
#   deploy/restore-backup.sh <name>.zip   restore that backup
# Stop the server first with `sudo systemctl stop gtnh` (an in-game /stop restarts it: Restart=always).
# Settings, from the environment: GTNH_DIR (/home/opc/GTNH), BACKUP_DIR ($GTNH_DIR/backups), GTNH_SERVICE (gtnh).
# The current world is kept as <world>.pre-restore-<time>. Nothing deletes those: remove them by hand.
set -euo pipefail

GTNH_DIR=${GTNH_DIR:-/home/opc/GTNH}
BACKUP_DIR=${BACKUP_DIR:-$GTNH_DIR/backups}
GTNH_SERVICE=${GTNH_SERVICE:-gtnh}
NAME_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{2}.*\.zip$' # as hub/src/backups.ts

die() { echo "restore-backup: $*" >&2; exit 1; }

backups() { # newest first (names are timestamps)
  find "$BACKUP_DIR" -maxdepth 1 -type f -printf '%f\n' 2>/dev/null | grep -E "$NAME_RE" | sort -r || true
}

stopped() {
  local state
  state=$(systemctl show -p ActiveState --value "$GTNH_SERVICE")
  [[ $state == inactive || $state == failed ]]
}

pre_restore() {
  local dirs=("$GTNH_DIR/$WORLD".pre-restore-*)
  [[ -d ${dirs[0]} ]] || return 0
  echo "Pre-restore worlds (delete by hand once you're happy):"
  du -sh "${dirs[@]}" | sed 's/^/  /'
}

[[ $(id -u) -ne 0 ]] || die "don't run as root: root-owned world files would break the server"
WORLD=World
if [[ -f $GTNH_DIR/server.properties ]]; then # guarded: under pipefail a missing file would end the script silently
  WORLD=$(sed -n 's/^level-name=//p' "$GTNH_DIR/server.properties" | tail -1 | tr -d '\r')
  WORLD=${WORLD:-World}
fi

if [[ $# -eq 0 ]]; then
  echo "Backups in $BACKUP_DIR (newest first):"
  backups | while read -r name; do printf '  %s  %s\n' "$name" "$(du -h "$BACKUP_DIR/$name" | cut -f1)"; done
  pre_restore
  exit 0
fi
[[ $# -eq 1 ]] || die "usage: $0 [latest | <backup>.zip]"

if [[ $1 == latest ]]; then
  NAME=$(backups | head -1)
  [[ -n $NAME ]] || die "no backups in $BACKUP_DIR"
else
  NAME=$1
  [[ $NAME != */* && $NAME =~ $NAME_RE ]] || die "not a backup name: $NAME (run with no arguments to list them)"
  [[ -f $BACKUP_DIR/$NAME ]] || die "no such backup: $BACKUP_DIR/$NAME"
fi
ZIP=$BACKUP_DIR/$NAME

stopped || die "$GTNH_SERVICE is running; stop it first: sudo systemctl stop $GTNH_SERVICE"
command -v unzip > /dev/null || die "unzip is not installed (sudo dnf install unzip)"

NEED=$(unzip -Zt "$ZIP" 2> /dev/null | awk '{ print $3 }') || die "can't read $NAME (corrupt?)"
FREE=$(df --output=avail -B1 "$GTNH_DIR" | tail -1)
((FREE > NEED + NEED / 10)) ||
  die "not enough space: $NAME unpacks to $(numfmt --to=iec "$NEED") (+10 %), $(numfmt --to=iec "$FREE") free"

STAMP=$(date +%Y-%m-%d-%H-%M-%S)
PRE_RESTORE=$GTNH_DIR/$WORLD.pre-restore-$STAMP
echo "Restore $NAME (taken $(date -r "$ZIP" '+%Y-%m-%d %H:%M')) into $GTNH_DIR/$WORLD."
if [[ -e $GTNH_DIR/$WORLD ]]; then echo "The current world will be kept as $PRE_RESTORE."; fi
read -r -p "Continue? [y/N] " answer || true
[[ ${answer:-} == [yY] ]] || die "cancelled"

# Unpack next to the world (same filesystem), so the swap below is two renames.
STAGE=$GTNH_DIR/.restore-$STAMP
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE"
unzip -q "$ZIP" -d "$STAGE" || die "unzip failed; the world was not touched"
if [[ -f $STAGE/level.dat ]]; then
  NEW=$STAGE
else
  mapfile -t found < <(find "$STAGE" -mindepth 2 -maxdepth 2 -name level.dat)
  [[ ${#found[@]} -eq 1 ]] || die "$NAME has no level.dat at its root or in exactly one folder; the world was not touched"
  NEW=$(dirname "${found[0]}")
fi

# Unpacking can take minutes: make sure nobody started the server meanwhile.
stopped || die "$GTNH_SERVICE was started while unpacking; the world was not touched"
if [[ -e $GTNH_DIR/$WORLD ]]; then mv "$GTNH_DIR/$WORLD" "$PRE_RESTORE"; fi
if ! mv "$NEW" "$GTNH_DIR/$WORLD"; then
  if [[ -e $PRE_RESTORE ]]; then mv "$PRE_RESTORE" "$GTNH_DIR/$WORLD"; fi
  die "couldn't move the restored world into place; the current world was put back"
fi

echo "Restored $NAME into $GTNH_DIR/$WORLD."
echo "Next: sudo systemctl start $GTNH_SERVICE, then join and check the world."
pre_restore

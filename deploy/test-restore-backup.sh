#!/usr/bin/env bash
# Tests restore-backup.sh against a fake server folder and a systemctl stub. Needs zip and unzip.
#   bash deploy/test-restore-backup.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export GTNH_DIR=$T/server BACKUP_DIR=$T/server/backups GTNH_SERVICE=gtnh STATES=$T/states
export PATH=$T/bin:$PATH
mkdir -p "$T/bin" "$BACKUP_DIR"

# systemctl stub: prints the first line of $STATES, and drops it unless it's the last one.
cat > "$T/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
head -1 "$STATES"
if [[ $(wc -l < "$STATES") -gt 1 ]]; then sed -i 1d "$STATES"; fi
EOF
chmod +x "$T/bin/systemctl"
states() { printf '%s\n' "$@" > "$STATES"; }

# Fixtures: World/ at the zip root; level.dat at the zip root (newest); a corrupt zip (oldest).
mkdir -p "$T/a/World/region" "$T/b/region"
echo a > "$T/a/World/level.dat"
echo b > "$T/b/level.dat"
(cd "$T/a" && zip -qr "$BACKUP_DIR/2026-09-20-06-00-00.zip" World)
(cd "$T/b" && zip -qr "$BACKUP_DIR/2026-09-21-06-00-00.zip" .)
echo junk > "$BACKUP_DIR/2026-09-19-06-00-00.zip"

reset_world() { rm -rf "$GTNH_DIR"/World*; mkdir -p "$GTNH_DIR/World"; echo old > "$GTNH_DIR/World/level.dat"; }
restore() { echo y | bash "$HERE/restore-backup.sh" "$@" > "$T/out" 2>&1; }
untouched() { [[ $(cat "$GTNH_DIR/World/level.dat") == old ]] && ! compgen -G "$GTNH_DIR/.restore-*" > /dev/null; }

fail=0
check() {
  if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; sed 's/^/     /' "$T/out"; fail=1; fi
}

reset_world; states active
check 'refuses while the server is active' '! restore latest && grep -q "stop it first" "$T/out" && untouched'
states activating
check 'refuses while it is starting' '! restore latest && untouched'
states inactive
check 'refuses unknown names' '! restore 2026-01-01-00-00-00.zip && untouched'
check 'refuses paths' '! restore ../backups/2026-09-21-06-00-00.zip && untouched'
check 'refuses a corrupt zip' '! restore 2026-09-19-06-00-00.zip && untouched'
check 'cancels without a yes' '! (echo n | bash "$HERE/restore-backup.sh" latest > "$T/out" 2>&1) && untouched'
states inactive active
check 'refuses if the server was started while unpacking' '! restore latest && grep -q "was started" "$T/out" && untouched'
states inactive
check 'restores the newest backup (level.dat at the zip root)' \
  'restore latest && [[ $(cat "$GTNH_DIR/World/level.dat") == b && -d $GTNH_DIR/World/region ]] &&
   [[ $(cat "$GTNH_DIR"/World.pre-restore-*/level.dat) == old ]] && ! compgen -G "$GTNH_DIR/.restore-*" > /dev/null'
reset_world; states failed
check 'restores a named backup (World/ at the zip root)' \
  'restore 2026-09-20-06-00-00.zip && [[ $(cat "$GTNH_DIR/World/level.dat") == a && -d $GTNH_DIR/World/region ]]'
check 'lists backups and pre-restore worlds with no argument' \
  'bash "$HERE/restore-backup.sh" > "$T/out" 2>&1 && grep -q 2026-09-21-06-00-00.zip "$T/out" && grep -q pre-restore "$T/out"'
# Everything above ran without server.properties (default World); now a non-default level-name (CRLF, like Windows edits).
printf 'motd=x\r\nlevel-name=Saved\r\n' > "$GTNH_DIR/server.properties"
mkdir -p "$GTNH_DIR/Saved"; echo old > "$GTNH_DIR/Saved/level.dat"; states inactive
check 'restores into the level-name from server.properties' \
  'restore latest && [[ $(cat "$GTNH_DIR/Saved/level.dat") == b && $(cat "$GTNH_DIR"/Saved.pre-restore-*/level.dat) == old ]]'
exit $fail

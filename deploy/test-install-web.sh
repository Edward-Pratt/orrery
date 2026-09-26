#!/usr/bin/env bash
# Tests install-web.sh against a temp WEB_DIR with fake release archives.
#   bash deploy/test-install-web.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export WEB_DIR=$T/www/orrery

# Fixtures: two builds (the second drops a file), and an archive that isn't a dashboard.
mkdir -p "$T/v1/assets" "$T/v2" "$T/junk"
echo v1 > "$T/v1/index.html"; echo old > "$T/v1/assets/stale.js"
echo v2 > "$T/v2/index.html"; echo new > "$T/v2/main.js"
echo x > "$T/junk/readme.txt"
for d in v1 v2 junk; do tar -czf "$T/$d.tar.gz" -C "$T/$d" .; done

install() { bash "$HERE/install-web.sh" "$@" > "$T/out" 2>&1; }
fail=0
check() {
  if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; sed 's/^/     /' "$T/out"; fail=1; fi
}

check 'installs into an empty WEB_DIR' 'install "$T/v1.tar.gz" && [[ $(cat "$WEB_DIR/index.html") == v1 ]]'
check 'replaces the previous build, leaving none of its files' \
  'install "$T/v2.tar.gz" && [[ $(cat "$WEB_DIR/index.html") == v2 && -f $WEB_DIR/main.js && ! -e $WEB_DIR/assets ]]'
check 'files are world-readable' '[[ $(stat -c %a "$WEB_DIR/main.js") == 644 && $(stat -c %a "$WEB_DIR") == 755 ]]'
check 'refuses an archive without index.html, keeping the installed build' \
  '! install "$T/junk.tar.gz" && grep -q "not a dashboard build" "$T/out" && [[ $(cat "$WEB_DIR/index.html") == v2 ]]'
check 'refuses something that is neither a file nor a web tag' '! install hub-v2.1.0 && [[ $(cat "$WEB_DIR/index.html") == v2 ]]'
check 'leaves no staging folders behind' '! compgen -G "$T/www/.orrery-web-*" > /dev/null'
exit $fail

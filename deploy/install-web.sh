#!/usr/bin/env bash
# Installs a dashboard release for Caddy to serve, replacing the previous build. Run as root on the server:
#   sudo bash deploy/install-web.sh web-v0.1.0                     # fetched with gh: the repo is private, so root's
#                                                                   # gh needs a login (sudo gh auth login) or GH_TOKEN
#                                                                   # in the environment (deploy-web.sh passes it)
#   sudo bash deploy/install-web.sh /tmp/orrery-web-v0.1.0.tar.gz  # or an archive copied over
# WEB_DIR (default /var/www/orrery) is outside /home: under /var/www new files get httpd_sys_content_t, which
# Caddy may read under SELinux. If Caddy still gets a denial, check `sudo ausearch -m avc -ts recent` rather than
# guessing labels, and note the fix here.
# Writes the tag to <WEB_DIR>.release (e.g. /var/www/orrery.release) after the swap, for the hub to show which release
# runs; installing an archive removes the stamp, as its release is unknown.
set -euo pipefail
# restorecon lives in /usr/sbin, which a systemd unit's PATH may leave out: without it Caddy can't read the new files.
PATH=$PATH:/usr/sbin:/sbin
WEB_DIR=${WEB_DIR:-/var/www/orrery}
REPO=${REPO:-Edward-Pratt/orrery}
[[ $# -eq 1 ]] || { echo "usage: $0 <web-vX.Y.Z | archive.tar.gz>" >&2; exit 2; }

parent=$(dirname "$WEB_DIR")
mkdir -p "$parent"
# Staged next to WEB_DIR (same filesystem, same default labels), so the swap is two renames.
stage=$(mktemp -d "$parent/.orrery-web-XXXXXX")
trap 'rm -rf "$stage"' EXIT

archive=$1
if [[ ! -f $archive ]]; then
  [[ $archive =~ ^web-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "not a file or a web-vX.Y.Z tag: $archive" >&2; exit 2; }
  gh release download "$archive" --repo "$REPO" --pattern "orrery-$archive.tar.gz" --dir "$stage"
  archive=$stage/orrery-$1.tar.gz
fi

mkdir "$stage/new"
tar -xzf "$archive" -C "$stage/new" --no-same-owner
[[ -f $stage/new/index.html ]] || { echo "no index.html in $1: not a dashboard build" >&2; exit 1; }
chmod -R u=rwX,go=rX "$stage/new"
# The policy's default labels, before the swap: a failure here leaves the installed build serving. The staged path
# is under WEB_DIR's parent, so it gets the same labels (a rename keeps them).
if command -v restorecon > /dev/null; then restorecon -R "$stage/new"; fi

if [[ -d $WEB_DIR ]]; then mv "$WEB_DIR" "$stage/old"; fi
mv "$stage/new" "$WEB_DIR"
if [[ $archive == "$1" ]]; then rm -f "$WEB_DIR.release"; else printf '%s\n' "$1" > "$WEB_DIR.release"; fi
echo "Installed $1 into $WEB_DIR."

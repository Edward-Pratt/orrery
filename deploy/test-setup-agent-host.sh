#!/usr/bin/env bash
# Tests setup-agent-host.sh against a temp SETUP_ROOT, with logging fakes on PATH for every system command it runs
# (dnf, rpm, useradd, getent, id, install's owner flags, runuser, systemctl, firewall-cmd, ip, selinuxenabled,
# getenforce, semanage, restorecon, tailscale, uname, ss, df, podman, curl) and a fake Quadlet generator under the
# prefix. curl serves local fixtures, and this folder's factorio.container, units and polkit file as the release's.
# tar, xz, sha256sum and node are real, and the hub is a real local TCP listener. In the script's runs only, mv,
# mktemp, tar, ln, rm and mkdir are logging wrappers around the real ones, noting who runs them, so the test sees
# which writes run as factorio.
#   bash deploy/test-setup-agent-host.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
hub_pid=''
trap '[[ -z $hub_pid ]] || kill "$hub_pid" 2> /dev/null || true; rm -rf "$T"' EXIT
R=$T/root F=$T/fake X=$T/fixtures S=$T/setup-agent-host.sh
REAL_NODE=$(command -v node) REAL_INSTALL=$(command -v install) REAL_ID=$(command -v id) REAL_UNAME=$(command -v uname)
CHECK_ENV=$T/check-env # the agent check's environment, kept out of $F (it holds the token and the RCON password)
export F X R HERE REAL_NODE REAL_INSTALL REAL_ID REAL_UNAME SETUP_ROOT=$R LC_ALL=C CHECK_ENV
mkdir -p "$T/bin" "$X"

# ---- Fakes. Each notes its call in $F/calls; flag files in $F steer them. Commands with their own argv are logged
# whole, so a secret in any argv would show there.
cat > "$T/bin/dnf" << 'EOF'
#!/usr/bin/env bash
echo "dnf $*" >> "$F/calls"
[[ $1 == install && $2 == -y ]] || { echo "fake dnf: only install -y" >&2; exit 1; }
shift 2
for p; do rm -f "$F/missing-$p"; done
EOF
cat > "$T/bin/rpm" << 'EOF'
#!/usr/bin/env bash
echo "rpm $*" >> "$F/calls"
[[ ! -e $F/missing-${!#} ]]
EOF
cat > "$T/bin/useradd" << 'EOF'
#!/usr/bin/env bash
echo "useradd $*" >> "$F/calls"
echo 'factorio:x:986:986::/srv/factorio:/sbin/nologin' >> "$F/passwd"
EOF
cat > "$T/bin/getent" << 'EOF'
#!/usr/bin/env bash
[[ $1 == passwd || $1 == group ]] || exit 2
grep "^$2:" "$F/$1" 2> /dev/null || exit 2
EOF
cat > "$T/bin/id" << 'EOF'
#!/usr/bin/env bash
case "$*" in
  -u) if [[ -e $F/not-root ]]; then echo 1000; else echo 0; fi ;;
  '-u factorio') grep ^factorio: "$F/passwd" | cut -d: -f3 ;;
  '-g factorio') grep ^factorio: "$F/passwd" | cut -d: -f4 ;;
  *) exec "$REAL_ID" "$@" ;;
esac
EOF
cat > "$T/bin/install" << 'EOF'
#!/usr/bin/env bash
# Only root can give a file away: notes the owner asked for, then installs without it.
args=() own=()
while (($#)); do case $1 in -o | -g) own+=("$1" "$2"); shift 2 ;; *) args+=("$1"); shift ;; esac; done
((${#own[@]} == 0)) || echo "install ${own[*]} ${args[*]}" >> "$F/calls"
exec "$REAL_INSTALL" "${args[@]}"
EOF
cat > "$T/bin/runuser" << 'EOF'
#!/usr/bin/env bash
# runuser -u <user> -- <cmd…>: notes it, then runs it as whoever runs the test, with HOME set to the user's home as
# the real one does, and FAKE_AS naming the user for the logging wrappers and curl.
[[ $1 == -u && $3 == -- ]] || { echo "fake runuser: want -u <user> -- <cmd…>" >&2; exit 1; }
echo "runuser $2 ${*:4}" >> "$F/calls"
FAKE_AS=$2 HOME=$(grep "^$2:" "$F/passwd" | cut -d: -f6)
export FAKE_AS HOME
shift 3
exec "$@"
EOF
cat > "$T/bin/systemctl" << 'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$F/calls"
case $1 in
  show) if [[ -f $F/show-${!#} ]]; then cat "$F/show-${!#}"; else echo LoadState=not-found; fi ;;
  is-active) [[ -e $F/active-${!#} ]] ;;
  start) [[ ! -e $F/start-fails ]] ;;
esac
EOF
cat > "$T/bin/firewall-cmd" << 'EOF'
#!/usr/bin/env bash
echo "firewall-cmd $*" >> "$F/calls"
case $* in
  --get-zone-of-interface=enp0s6) echo public ;;
  --get-default-zone) echo public ;;
  *--query-port=*) grep -qxF -- "${*/--query-port=/--add-port=}" "$F/firewall" 2> /dev/null ;;
  *--add-port=*) echo "$*" >> "$F/firewall"; echo success ;;
  *) echo "fake firewall-cmd: what is $*" >&2; exit 1 ;;
esac
EOF
cat > "$T/bin/ip" << 'EOF'
#!/usr/bin/env bash
[[ $* == '-o route show default' ]] || exit 1
echo 'default via 10.0.0.1 dev enp0s6 proto dhcp src 10.0.0.5 metric 100'
EOF
cat > "$T/bin/selinuxenabled" << 'EOF'
#!/usr/bin/env bash
[[ -e $F/selinux ]]
EOF
cat > "$T/bin/getenforce" << 'EOF'
#!/usr/bin/env bash
if [[ -e $F/selinux ]]; then echo Enforcing; else echo Disabled; fi
EOF
cat > "$T/bin/semanage" << 'EOF'
#!/usr/bin/env bash
echo "semanage $*" >> "$F/calls"
case "$1 $2" in
  'fcontext -l') echo 'SELinux fcontext    type    Context'; cat "$F/fcontext" 2> /dev/null || true ;;
  'fcontext -a' | 'fcontext -m') printf '%s    all files    system_u:object_r:%s:s0\n' "${!#}" "$4" >> "$F/fcontext" ;;
  *) exit 1 ;;
esac
EOF
cat > "$T/bin/restorecon" << 'EOF'
#!/usr/bin/env bash
echo "restorecon $*" >> "$F/calls"
EOF
cat > "$T/bin/tailscale" << 'EOF'
#!/usr/bin/env bash
echo "tailscale $*" >> "$F/calls"
[[ $* != 'ip -4' || -e $F/no-tailnet ]] || echo 100.90.80.70
EOF
cat > "$T/bin/uname" << 'EOF'
#!/usr/bin/env bash
if [[ $* == -m ]]; then cat "$F/arch" 2> /dev/null || echo aarch64; else exec "$REAL_UNAME" "$@"; fi
EOF
cat > "$T/bin/ss" << 'EOF'
#!/usr/bin/env bash
# ss -Hln<u|t>e 'sport = :<port>': the lines in $F/ss-<u|t>-<port>, if any.
f=$F/ss-${1:4:1}-${2##*:}
[[ ! -f $f ]] || cat "$f"
EOF
cat > "$T/bin/df" << 'EOF'
#!/usr/bin/env bash
echo 'Filesystem 1024-blocks Used Available Capacity Mounted on'
echo "/dev/sda3 104857600 1048576 $(cat "$F/df" 2> /dev/null || echo 52428800) 2% /"
EOF
cat > "$T/bin/podman" << 'EOF'
#!/usr/bin/env bash
echo "podman $*" >> "$F/calls"
case $1 in
  --version) cat "$F/podman-version" 2> /dev/null || echo 'podman version 5.2.2' ;;
  container) case $2 in exists) [[ -e $F/container ]] ;; inspect) cat "$F/container" ;; *) exit 1 ;; esac ;;
  pull) [[ $2 == */* ]] ;;
  image)
    case $2 in
      inspect)
        case $4 in
          '{{.Digest}}') echo "sha256:$(cat "$F/digest")" ;;
          '{{.Id}}') printf '%s' "$5" | sha256sum | cut -d' ' -f1 ;; # one id per pinned reference
          *) exit 1 ;;
        esac ;;
      exists) [[ ! -e $F/image-gone ]] ;;
      rm) [[ ! -e $F/image-in-use ]] || { echo 'Error: image is in use by a container' >&2; exit 2; } ;;
      *) exit 1 ;;
    esac ;;
  run)
    a=" $* "
    if [[ $a == *' sh -c '* ]]; then
      if [[ $a == *debian* ]]; then echo 2.41-12; else echo 2.39; fi
    elif [[ $a == *' --version '* ]]; then
      # The binary is the word before --version. $F/glibc makes every one need a newer glibc than the image's, or only
      # the release it names (X.Y.Z in it).
      bin=${a% --version *}
      bin=${bin##* }
      if [[ -e $F/glibc && (! -s $F/glibc || $bin == */releases/$(cat "$F/glibc")/*) ]]; then
        echo "$bin: /lib64/libc.so.6: version \`GLIBC_2.38' not found" >&2
        exit 1
      fi
      exec "$SETUP_ROOT$bin" --version
    elif [[ $a == *' --create '* ]]; then
      w=${a##* --create }
      echo world > "$SETUP_ROOT${w%% *}"
    else
      exit 1
    fi ;;
  *) exit 1 ;;
esac
EOF
cat > "$T/bin/curl" << 'EOF'
#!/usr/bin/env bash
# Serves $F/x/<host/path> (one test's override), else $X/<host/path>; 404 when $F/gone/<host/path> exists. The
# release's deploy/ files come from this folder.
[[ $1 == -q ]] || { echo 'fake curl: want -q first (no .curlrc)' >&2; exit 2; }
out='' url=''
while (($#)); do
  case $1 in
    -o) out=$2; shift 2 ;;
    --proto | --proto-redir | --retry) shift 2 ;;
    https://*) url=$1; shift ;;
    -*) shift ;;
    *) echo "fake curl: what is $1" >&2; exit 2 ;;
  esac
done
echo "curl $url" >> "$F/calls"
[[ -z $out ]] || echo "as ${FAKE_AS:-root} curl -o $out" >> "$F/calls"
path=${url#https://}
path=${path%%\?*}
[[ $path != */ ]] || path+=index
src=$X/$path
[[ $path != raw.githubusercontent.com/Edward-Pratt/orrery/*/deploy/* ]] || src=$HERE/${path##*/}
[[ ! -f $F/x/$path ]] || src=$F/x/$path
[[ -f $src && ! -e $F/gone/$path ]] || { echo 'curl: (22) The requested URL returned error: 404' >&2; exit 22; }
if [[ -n $out ]]; then cat "$src" > "$out"; else cat "$src"; fi
EOF
cat > "$T/quadlet" << 'EOF'
#!/usr/bin/env bash
# The Quadlet generator's dry run. Like quadlet, it reports a [Container] key Podman 4.6 lacks; like some 4.x
# releases, only in its output (exit 0). $F/quadlet-fails makes it fail outright.
echo "quadlet $*" >> "$F/calls"
[[ $* == -dryrun && -n ${QUADLET_UNIT_DIRS:-} ]] || exit 1
[[ ! -e $F/quadlet-fails ]] || { echo 'quadlet-generator[1]: converting "factorio.container": fake failure' >&2; exit 1; }
f=$QUADLET_UNIT_DIRS/factorio.container
keys=' ContainerName Label Image Pull Network User Group Environment Volume ReadOnly Tmpfs NoNewPrivileges DropCapability LogDriver PodmanArgs Exec '
group=''
while IFS= read -r line; do
  case $line in
    '['*']') group=$line ;;
    '' | '#'* | ' '*) ;;
    *=*)
      k=${line%%=*}
      [[ $group != '[Container]' || $keys == *" $k "* ]] ||
        echo "quadlet-generator[1]: converting \"factorio.container\": unsupported key '$k' in group 'Container' in $f" >&2 ;;
  esac
done < "$f"
echo '---factorio.service---'
echo 'ExecStart=/usr/bin/podman run --name factorio --replace --rm --cgroups=split --network host --sdnotify=conmon -d …'
EOF
# The logging wrappers, on PATH for the script's runs only (run() below): each notes "as <who> <cmd> <args…>", who
# being factorio under the fake runuser and root otherwise, then runs the real command.
mkdir -p "$T/wrap"
for c in mv mktemp tar ln rm mkdir; do
  printf '#!/usr/bin/env bash\necho "as ${FAKE_AS:-root} %s $*" >> "$F/calls"\nexec %q "$@"\n' "$c" "$(command -v "$c")" > "$T/wrap/$c"
done
chmod +x "$T/bin/"* "$T/wrap/"* "$T/quadlet"
export PATH=$T/bin:$PATH
for c in "$T/bin/"*; do # never the real one: the script must reach only fakes
  [[ $(command -v "${c##*/}") == "$c" ]] || { echo "FAIL the fake ${c##*/} isn't first on PATH"; exit 1; }
done

# ---- Fixtures: Node (a shim for the real one, so the script's JSON work runs), Factorio, the agent, the mod, the
# GitHub release list.
NV=$(sed -n 's/^NODE_VERSION=//p' "$HERE/setup-agent-host.sh")
B=$T/build
mkdir -p "$B/node-v$NV-linux-arm64/bin" "$B/agent/src"
printf '#!/bin/sh\nexec "$REAL_NODE" "$@"\n' > "$B/node-v$NV-linux-arm64/bin/node"
chmod 755 "$B/node-v$NV-linux-arm64/bin/node"
for v in 2.1.24 2.1.25; do # Factorio's headless tarballs: one top folder factorio/
  mkdir -p "$B/factorio-$v/factorio/bin/arm64" "$B/factorio-$v/factorio/data/base"
  printf '#!/usr/bin/env bash\n[[ $1 != --version ]] || echo "Version: %s (build 87808, linux-arm64, headless)"\n' "$v" > "$B/factorio-$v/factorio/bin/arm64/factorio"
  chmod 755 "$B/factorio-$v/factorio/bin/arm64/factorio"
done
cat > "$B/agent/src/index.ts" << 'EOF'
// The agent, for the test: its check notes what it got (whether each secret was set, never a value), and its whole
// environment in $CHECK_ENV, outside $F, to show the game password never reaches it.
const fs = require('fs');
if (process.argv[2] === 'check') {
  const e = process.env;
  const got = { args: process.argv.slice(2), home: e.HOME, rcon: /^[A-Za-z0-9]{32}$/.test(e.RCON_PASSWORD || ''), token: (e.ORRERY_AGENT_TOKEN || '').length >= 32 };
  fs.writeFileSync(e.F + '/check-ran', JSON.stringify(got) + '\n');
  fs.writeFileSync(e.CHECK_ENV, JSON.stringify(e) + '\n');
  console.log('first-boot check (fixture): every check ran');
  process.exitCode = fs.existsSync(e.F + '/check-fails') ? 1 : 0;
}
EOF
mkdir -p "$X/nodejs.org/dist/v$NV" "$X/www.factorio.com/get-download/2.1.24/headless" \
  "$X/www.factorio.com/get-download/2.1.25/headless" "$X/www.factorio.com/download/sha256sums" "$X/factorio.com/api" \
  "$X/api.github.com/repos/Edward-Pratt/orrery"
NODE_TGZ=nodejs.org/dist/v$NV/node-v$NV-linux-arm64.tar.xz
tar -cJf "$X/$NODE_TGZ" -C "$B" "node-v$NV-linux-arm64"
FACTORIO_TGZ=www.factorio.com/get-download/2.1.24/headless/linux-arm64
tar -cJf "$X/$FACTORIO_TGZ" -C "$B/factorio-2.1.24" factorio
tar -cJf "$X/www.factorio.com/get-download/2.1.25/headless/linux-arm64" -C "$B/factorio-2.1.25" factorio
SUMS=www.factorio.com/download/sha256sums/index
sha() { sha256sum < "$1" | cut -c1-64; }
{
  echo "c49b66cff90aceff87b30f2973af0df7f51712cb2ee3153e0169d9bed46a964f  factorio-headless_linux_2.1.24.tar.xz"
  echo "$(sha "$X/$FACTORIO_TGZ")  factorio-headless_linux-arm64_2.1.24.tar.xz"
  echo "$(sha "$X/www.factorio.com/get-download/2.1.25/headless/linux-arm64")  factorio-headless_linux-arm64_2.1.25.tar.xz"
} > "$X/$SUMS"
echo '{"experimental":{"headless":"2.1.25"},"stable":{"headless":"2.1.24"}}' > "$X/factorio.com/api/latest-releases"
DL=github.com/Edward-Pratt/orrery/releases/download
AGENT_TGZ=$DL/agent-v0.10.0/orrery-agent-v0.10.0.tar.gz # release.yml: orrery-$GITHUB_REF_NAME.tar.gz
MOD_ZIP=$DL/factorio-v0.1.0/orrery_0.1.0.zip
mkdir -p "$X/$DL/agent-v0.10.0" "$X/$DL/factorio-v0.1.0"
tar -czf "$X/$AGENT_TGZ" -C "$B/agent" . # as ci.yml packs it
echo "$(sha "$X/$AGENT_TGZ")  orrery-agent-v0.10.0.tar.gz" > "$X/$AGENT_TGZ.sha256"
echo 'the orrery mod' > "$X/$MOD_ZIP"
API=api.github.com/repos/Edward-Pratt/orrery/releases
api() { # <zip digest>: a release list with drafts, other parts, and agent versions that sort wrong as text
  cat << EOF
[
  { "tag_name": "agent-v9.0.0", "draft": true, "assets": [] },
  { "tag_name": "agent-v0.9.0", "draft": false, "assets": [] },
  { "tag_name": "factorio-v0.1.0", "draft": false, "assets": [{ "name": "orrery_0.1.0.zip", "digest": "sha256:$1" }] },
  { "tag_name": "agent-v0.10.0", "draft": false, "assets": [] },
  { "tag_name": "hub-v9.9.9", "draft": false, "assets": [] }
]
EOF
}
api "$(sha "$X/$MOD_ZIP")" > "$X/$API"
RAW=raw.githubusercontent.com/Edward-Pratt/orrery/agent-v0.10.0/deploy
DEPLOY_AGENT=$HERE/deploy-agent.sh

# The setup script under test, with the pinned Node sha256 swapped for the fixture's (the only line that differs).
sed "s/^NODE_SHA256=.*/NODE_SHA256=$(sha "$X/$NODE_TGZ")/" "$HERE/setup-agent-host.sh" > "$S"

# The hub: a real listener on loopback.
node -e 'const s = require("net").createServer((c) => c.end()).listen(0, "127.0.0.1", () => console.log(s.address().port))' > "$T/hub-port" &
hub_pid=$!
for _ in $(seq 100); do [[ ! -s $T/hub-port ]] || break; sleep 0.1; done
HUB=127.0.0.1:$(cat "$T/hub-port")

TOKEN='Tok3n+with/base64=chars.0123456789abcdefXYZ' NEW_TOKEN=fedcba9876543210fedcba9876543210ZZ
DIGEST1=$(printf one | sha256sum | cut -c1-64) DIGEST2=$(printf two | sha256sum | cut -c1-64)
OL=container-registry.oracle.com/os/oraclelinux:10-slim DEBIAN=docker.io/library/debian:trixie-slim
ARGS=(--agent-id factorio-vm --hub "$HUB" --admins Alice,Bob)
MARKER_LINE='Managed by orrery deploy/setup-agent-host.sh. Do not edit: re-run the script.'
Q=$R/etc/containers/systemd/factorio.container
fresh() { # an OL9 aarch64 VM with Podman 5.2, no factorio user, nothing of ours
  rm -rf "$R" "$F"
  mkdir -p "$R/etc" "$R/usr/libexec/podman" "$F"
  printf 'NAME="Oracle Linux Server"\nVERSION="9.6"\nID="ol"\nVERSION_ID="9.6"\n' > "$R/etc/os-release"
  cp "$T/quadlet" "$R/usr/libexec/podman/quadlet"
  echo "$DIGEST1" > "$F/digest"
  : > "$F/calls"
}
override() { mkdir -p "$(dirname "$F/x/$1")"; cat > "$F/x/$1"; } # <host/path>: this test's version of a download
gone() { mkdir -p "$(dirname "$F/gone/$1")"; touch "$F/gone/$1"; } # <host/path>: a 404
run() { # [args…]: the script with $IN (default: the token) on stdin, its output in $T/out; TRACE=1 runs it under bash -x
  local r=0
  : > "$F/calls"
  PATH=$T/wrap:$PATH bash ${TRACE:+-x} "${SCRIPT:-$S}" "$@" < <(printf '%s\n' "${IN-$TOKEN}") > "$T/out" 2>&1 || r=$?
  cat "$F/calls" >> "$T/all-calls"
  return $r
}
says() { grep -qF -- "$1" "$T/out"; }
called() { grep -qE -- "$1" "$F/calls"; }
# The game password in server-settings.json (a regular file only), or nothing.
GP_OF() {
  local f=$R/srv/factorio/config/server-settings.json
  [[ -f $f && ! -L $f ]] || return 0
  node -e 'try { const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).game_password; if (typeof p === "string") process.stdout.write(p); } catch {}' "$f"
}
# Everything the script wrote, for comparing runs: paths, modes, link targets, contents (the env files' keys only; the
# game password, random per VM, as a placeholder: the checks that it is kept compare it on their own).
written() {
  local gp
  gp=$(GP_OF)
  (cd "$R" && find . -path ./usr/libexec -prune -o -path ./etc/os-release -prune -o -print) | sort | while IFS= read -r p; do
    f=$R/${p#./}
    if [[ -L $f ]]; then echo "$p -> $(readlink "$f")"
    elif [[ -d $f ]]; then echo "$p/ $(stat -c %a "$f")"
    elif [[ $p == ./etc/orrery-*.env ]]; then echo "$p $(stat -c %a "$f") $(cut -d= -f1 "$f" | tr '\n' ' ')"
    elif [[ $gp =~ ^[A-Za-z0-9]+$ ]] && grep -qF -- "$gp" "$f"; then
      echo "$p $(stat -c %a "$f") $(sed "s/$gp/<game password>/g" "$f" | sha256sum | cut -c1-64)"
    else echo "$p $(stat -c %a "$f") $(sha "$f")"; fi
  done
}
fail=0
check() {
  if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; sed 's/^/     /' "$T/out"; fail=1; fi
}
settings_ok() {
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const ok = s.visibility.public === false && s.visibility.lan === false && s.require_user_verification === true &&
      s.auto_pause === true && s.autosave_interval === 10 && s.autosave_slots === 5 && s.non_blocking_saving === false &&
      s.allow_commands === "admins-only" && /setup-agent-host\.sh/.test(s._comment) &&
      /^[A-Za-z0-9]{20,}$/.test(s.game_password) && !["username", "password", "token"].some((k) => k in s);
    process.exit(ok ? 0 : 1);' "$1"
}
canon() { node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))))' "$1"; }
polkit_ok() { # the rules file, run against a polkit stand-in
  node -e '
    let rule;
    new Function("polkit", require("fs").readFileSync(process.argv[1], "utf8"))({ Result: { YES: "yes" }, addRule: (f) => (rule = f) });
    const can = (user, verb, unit, id = "org.freedesktop.systemd1.manage-units") =>
      rule({ id, lookup: (k) => ({ unit, verb })[k] }, { user }) === "yes";
    const cases = [
      [true, "factorio", "start", "factorio.service"], [true, "factorio", "stop", "factorio.service"],
      [true, "factorio", "restart", "factorio.service"], [true, "factorio", "restart", "orrery-agent.service"],
      [true, "factorio", "start", "orrery-agent-deploy@agent-v1.2.3.service"],
      [false, "factorio", "stop", "orrery-agent.service"], [false, "factorio", "start", "orrery-agent.service"],
      [false, "factorio", "reload", "factorio.service"], [false, "factorio", "start", "sshd.service"],
      [false, "factorio", "start", "orrery-agent-deploy@x.service"],
      [false, "factorio", "start", "orrery-agent-deploy@hub-v1.2.3.service"],
      [false, "factorio", "start", "orrery-agent-deploy@agent-v1.2.3.service.bak"],
      [false, "factorio", "stop", "orrery-agent-deploy@agent-v1.2.3.service"],
      [false, "opc", "start", "factorio.service"], [false, "root", "restart", "orrery-agent.service"],
      [false, "factorio", "start", "factorio.service", "org.freedesktop.login1.reboot"],
    ];
    const bad = cases.filter(([want, ...a]) => can(...a) !== want);
    if (bad.length) { console.error("wrong:", JSON.stringify(bad)); process.exit(1); }' "$1"
}
RCON_OF() { sed -n 's/^RCON_PASSWORD=//p' "$R/etc/orrery-factorio.env"; }
MUTATING='^(dnf|useradd|install |semanage fcontext -[am]|restorecon|podman (pull|run|image rm)|firewall-cmd .*--add|systemctl (daemon-reload|start|enable|restart|stop)|runuser|curl|as [a-z]+ )'
STARTED='^systemctl (daemon-reload|start|enable|restart)'

check 'the script pins Node by version and sha256; the copy under test differs only in that sha256' '
  grep -qE "^NODE_SHA256=[0-9a-f]{64}$" "$HERE/setup-agent-host.sh" && [[ $NV =~ ^24\.[0-9]+\.[0-9]+$ ]] &&
  [[ $(diff "$HERE/setup-agent-host.sh" "$S" | grep -c "^[<>]") == 2 ]]'

# ---- A first run on a fresh VM: two packages missing, SELinux and firewalld off.
fresh
touch "$F/missing-policycoreutils-python-utils" "$F/missing-xz"
check 'sets up a fresh VM' 'run "${ARGS[@]}" && says "done: send /srv/factorio/first-boot.txt to the owner"'
check 'installs only the missing packages, in one dnf install; asks rpm by capability (curl-minimal provides curl)' '
  [[ $(grep ^dnf "$F/calls") == "dnf install -y policycoreutils-python-utils xz" ]] && called "^rpm -q --whatprovides curl$"'
check 'adds factorio as a system user with no login, home /srv/factorio' '
  [[ $(grep ^useradd "$F/calls") == "useradd --system --user-group --home-dir /srv/factorio --shell /sbin/nologin factorio" ]]'
check 'gives the three roots to factorio' '
  called "^install -o factorio -g factorio -d -m 755 $R/opt/factorio$" &&
  called "^install -o factorio -g factorio -d -m 750 $R/srv/factorio $R/srv/orrery-agent$" &&
  [[ $(stat -c %a "$R/srv/factorio") == 750 && $(stat -c %a "$R/opt/factorio") == 755 ]]'
check 'installs the private Node and points node at it, on no PATH' '
  [[ $(readlink "$R/usr/local/lib/orrery/node") == node-v$NV && -x $R/usr/local/lib/orrery/node-v$NV/bin/node ]] &&
  [[ ! -e $R/usr/local/bin/node && $(stat -c %a "$R/usr/local/lib/orrery") == 755 ]]'
check 'installs the newest stable Factorio, checked against sha256sums/, and points current at it' '
  called "^curl https://www.factorio.com/download/sha256sums/$" && called "^curl https://www.factorio.com/get-download/2.1.24/headless/linux-arm64$" &&
  [[ $(readlink "$R/opt/factorio/current") == releases/2.1.24 && -x $R/opt/factorio/releases/2.1.24/bin/arm64/factorio ]] &&
  [[ -z $(ls -A "$R/opt/factorio/.incoming") ]]'
check 'runs the release'\''s Factorio --version in the pinned image, as factorio, read-only' '
  called "^podman run --rm --network=none --user 986:986 --cap-drop=all --security-opt=no-new-privileges --read-only -v $R/opt/factorio:/opt/factorio:ro,z $OL@sha256:$DIGEST1 /opt/factorio/releases/2.1.24/bin/arm64/factorio --version$"'
check 'pulls the image by its full name and records the pin and its glibc in image.json' '
  called "^podman pull $OL$" &&
  [[ $(canon "$R/etc/orrery-agent/image.json") == "{\"image\":\"$OL@sha256:$DIGEST1\",\"glibc\":\"2.39\"}" ]] &&
  [[ $(stat -c %a "$R/etc/orrery-agent/image.json") == 644 ]]'
check 'writes config.ini with the read-only data and the writable /srv/factorio' '
  grep -qx "read-data=/opt/factorio/current/data" "$R/srv/factorio/config/config.ini" &&
  grep -qx "write-data=/srv/factorio" "$R/srv/factorio/config/config.ini"'
check 'writes server-settings.json: private, verified users, auto-pause, a game password, no factorio.com credentials, the _comment' 'settings_ok "$R/srv/factorio/config/server-settings.json"'
check 'writes the admin list and the mod list' '
  [[ $(canon "$R/srv/factorio/config/server-adminlist.json") == "[\"Alice\",\"Bob\"]" ]] &&
  [[ $(node -e "console.log(JSON.parse(require(\"fs\").readFileSync(process.argv[1])).mods.map((m) => m.name + (m.enabled ? \"\" : \"-off\")).join(\" \"))" "$R/srv/factorio/mods/mod-list.json") == "base space-age quality elevated-rails recycler orrery" ]]'
check 'installs the newest orrery mod, checked against the sha256 GitHub lists' '[[ $(cat "$R/srv/factorio/mods/orrery_0.1.0.zip") == "the orrery mod" ]]'
check 'creates a world in a one-off container, as factorio, with its mods' '
  [[ -f $R/srv/factorio/saves/world.zip ]] &&
  called "^podman run --rm --network=none --user 986:986 .* -e HOME=/srv/factorio -v $R/opt/factorio:/opt/factorio:ro,z -v $R/srv/factorio:/srv/factorio:z .* --config /srv/factorio/config/config.ini --mod-directory /srv/factorio/mods --create /srv/factorio/saves/world.zip$"'
check 'installs the newest agent release by version (not a draft, not by text), checked against its .sha256' '
  [[ $(readlink "$R/srv/orrery-agent/current") == releases/agent-v0.10.0 && -f $R/srv/orrery-agent/releases/agent-v0.10.0/src/index.ts ]] &&
  called "^curl https://github.com/Edward-Pratt/orrery/releases/download/agent-v0.10.0/orrery-agent-v0.10.0.tar.gz.sha256$"'
check 'takes the units, the polkit file and deploy-agent.sh from the same agent tag' '
  [[ $(grep -c "^curl https://$RAW/" "$F/calls") == 5 ]] && ! grep "^curl https://raw" "$F/calls" | grep -vq "/agent-v0.10.0/"'
WANT_AGENT=$(printf '{"id":"factorio-vm","hub":{"host":"127.0.0.1","port":%s},"server":{"id":"factorio","unit":"factorio.service","install":"/opt/factorio","data":"/srv/factorio","rconPort":27015,"factorioUdpPort":34198,"agentUdpPort":34199},"mounts":["/"]}' "${HUB##*:}")
check 'writes the agent config, root-owned and readable, no secrets' '
  [[ $(canon "$R/etc/orrery-agent/config.json") == "$WANT_AGENT" && $(stat -c %a "$R/etc/orrery-agent/config.json") == 644 ]]'
RCON=$(RCON_OF) || RCON=''
check 'writes both secret files mode 600: the token, and a random 32-character RCON password' '
  [[ $(stat -c %a "$R/etc/orrery-agent.env") == 600 && $(stat -c %a "$R/etc/orrery-factorio.env") == 600 ]] &&
  [[ $(cat "$R/etc/orrery-agent.env") == "ORRERY_AGENT_TOKEN=$TOKEN" && $RCON =~ ^[A-Za-z0-9]{32}$ ]]'
check 'the token and the RCON password are in no log, no argv and no other file' '
  ! grep -rqF -e "$TOKEN" -e "$RCON" "$F" "$T/out" &&
  [[ $(grep -rlF -e "$TOKEN" "$R") == "$R/etc/orrery-agent.env" && $(grep -rlF -e "$RCON" "$R") == "$R/etc/orrery-factorio.env" ]]'
cat > "$T/want-q" << EOF
> Image=$OL@sha256:$DIGEST1
> User=986
> Group=986
> Exec=/opt/factorio/current/bin/arm64/factorio \\
EOF
check 'the Quadlet file is the template with only the image pin, User, Group and the arch filled' '
  { diff "$HERE/factorio.container" "$Q" || true; } | grep "^>" | cmp -s - "$T/want-q" && [[ $(stat -c %a "$Q") == 644 ]]'
check 'the Quadlet file: numeric User and Group, the label, the pinned digest' '
  grep -qx "User=986" "$Q" && grep -qx "Group=986" "$Q" && grep -qx "Label=orrery.managed=true" "$Q" &&
  grep -qx "Image=$OL@sha256:$DIGEST1" "$Q" && grep -qx "Pull=never" "$Q"'
check 'the Quadlet file: :z, never :Z; the stop options in PodmanArgs, no StopSignal or StopTimeout keys' '
  grep -qx "Volume=/opt/factorio:/opt/factorio:ro,z" "$Q" && grep -qx "Volume=/srv/factorio:/srv/factorio:z" "$Q" && ! grep -q ":Z" "$Q" &&
  grep -qx "PodmanArgs=--stop-signal=SIGINT --stop-timeout=170" "$Q" && ! grep -qE "^(StopSignal|StopTimeout)=" "$Q"'
check 'the Quadlet file: the password only as ${RCON_PASSWORD}, from the env file; no MemoryMax without --memory-max' '
  grep -qF -- "--rcon-password \${RCON_PASSWORD}" "$Q" && ! grep -qF "$RCON" "$Q" && grep -qx "EnvironmentFile=/etc/orrery-factorio.env" "$Q" &&
  ! grep -q "^MemoryMax=" "$Q" && [[ $(sed -n 2p "$Q") == "# Managed by orrery deploy/setup-agent-host.sh. Do not edit: re-run the script." ]]'
check 'dry-runs the Quadlet file before writing it' 'called "^quadlet -dryrun$"'
check 'writes the agent unit, the deploy unit and the polkit file as they are in deploy/' '
  cmp -s "$R/etc/systemd/system/orrery-agent.service" "$HERE/orrery-agent.service" &&
  cmp -s "$R/etc/systemd/system/orrery-agent-deploy@.service" "$HERE/orrery-agent-deploy@.service" &&
  cmp -s "$R/etc/polkit-1/rules.d/60-orrery-agent.rules" "$HERE/60-orrery-agent.rules" &&
  [[ $(stat -c %a "$R/etc/polkit-1/rules.d/60-orrery-agent.rules") == 644 ]]'
check 'the agent unit: factorio, the private Node, both env files, ordered after the tailnet' '
  U=$R/etc/systemd/system/orrery-agent.service
  grep -qx "User=factorio" "$U" && grep -qx "ExecStart=/usr/local/lib/orrery/node/bin/node /srv/orrery-agent/current/src/index.ts" "$U" &&
  grep -qx "EnvironmentFile=/etc/orrery-agent.env" "$U" && grep -qx "EnvironmentFile=/etc/orrery-factorio.env" "$U" &&
  grep -qx "After=network-online.target tailscaled.service" "$U" && grep -qx "Restart=always" "$U" && grep -qx "RestartSec=5" "$U" &&
  grep -qx "Environment=HOME=/srv/orrery-agent" "$U" &&
  ! grep -qE "^(ProcSubset|ProtectProc)=" "$U" && ! grep -qxE "ProtectHome=(yes|true)" "$U"'
check 'the deploy unit: a oneshot running the root-owned deploy-agent.sh as factorio' '
  U=$R/etc/systemd/system/orrery-agent-deploy@.service
  grep -qx "Type=oneshot" "$U" && grep -qx "User=factorio" "$U" && grep -qx "ExecStart=/bin/bash /usr/local/lib/orrery/deploy-agent.sh %i" "$U"'
check 'polkit: factorio may run factorio.service, restart its own unit and start well-formed deploys, nothing else' 'polkit_ok "$R/etc/polkit-1/rules.d/60-orrery-agent.rules"'
check 'keeps root-owned copies of itself and deploy-agent.sh' '
  cmp -s "$R/usr/local/lib/orrery/setup-agent-host.sh" "$S" && cmp -s "$R/usr/local/lib/orrery/deploy-agent.sh" "$DEPLOY_AGENT" &&
  [[ $(stat -c %a "$R/usr/local/lib/orrery/setup-agent-host.sh") == 755 && $(stat -c %a "$R/usr/local/lib/orrery/deploy-agent.sh") == 755 ]]'
check 'starts factorio.service, then enables and restarts the agent; never enables factorio.service (Quadlet does)' '
  [[ $(grep -E "^systemctl " "$F/calls" | grep -vE "^systemctl (show|is-active) ") == "systemctl daemon-reload
systemctl start factorio.service
systemctl enable orrery-agent.service
systemctl restart orrery-agent.service" ]]'
check 'runs the agent check as factorio with its units'\'' HOME (not factorio'\''s, the container'\''s to write), the secrets in its environment only, and saves the report' '
  called "^runuser factorio env HOME=/srv/orrery-agent $R/usr/local/lib/orrery/node/bin/node $R/srv/orrery-agent/current/src/index.ts check$" &&
  [[ $(cat "$F/check-ran") == "{\"args\":[\"check\"],\"home\":\"/srv/orrery-agent\",\"rcon\":true,\"token\":true}" ]] &&
  grep -q "^setup-agent-host: agent factorio-vm (agent-v0.10.0), Factorio 2.1.24, image $OL@sha256:$DIGEST1 (glibc 2.39)" "$R/srv/factorio/first-boot.txt" &&
  grep -qx "first-boot check (fixture): every check ran" "$R/srv/factorio/first-boot.txt" && says "every check ran"'
GP=$(GP_OF)
SET=$R/srv/factorio/config/server-settings.json BOOT=$R/srv/factorio/first-boot.txt
check 'the game password: 20 random letters and digits, in server-settings.json, mode 600, written as factorio' '
  [[ $GP =~ ^[A-Za-z0-9]{20,}$ && $(stat -c %a "$SET") == 600 ]] &&
  grep -qE "^as factorio mv -T $R/srv/factorio/config/\.server-settings\.json\.[A-Za-z0-9]{6} $SET$" "$F/calls"'
check 'first-boot.txt shows the game password, says to share it only with the players; mode 600, written as factorio' '
  grep -qx "game password: $GP" "$BOOT" && grep -qx "share the game password only with the players: anyone who has it and the VM'\''s address can join" "$BOOT" &&
  [[ $(stat -c %a "$BOOT") == 600 && $(stat -c %a "$R/srv/factorio") == 750 ]] &&
  grep -qE "^as factorio mv -T $R/srv/factorio/\.first-boot\.txt\.[A-Za-z0-9]{6} $BOOT$" "$F/calls" &&
  says "the game password is in /srv/factorio/first-boot.txt (not shown here)"'
check 'the game password is printed nowhere else: not the output, no argv, not the agent check'\''s environment; on disk only in its three root- or factorio-only files' '
  [[ -s $CHECK_ENV ]] && ! grep -rqF -e "$GP" "$F" "$T/out" "$CHECK_ENV" &&
  [[ $(grep -rlF -e "$GP" "$R" | sort) == "$SET
$BOOT
$R/usr/local/lib/orrery/defaults/server-settings.json" ]] &&
  [[ $(stat -c %a "$R/usr/local/lib/orrery/defaults/server-settings.json") == 600 ]]'
check 'with firewalld and SELinux off: no firewall-cmd, no SELinux tools; the OCI ingress reminder' '
  ! called "^(firewall-cmd|semanage|restorecon)" && says "reminder: players reach the server only if" && says "firewalld isn'\''t running"'
check 'leaves no temp file behind' '[[ -z $(find "$R" -name ".*" ! -name .incoming) ]]'
written > "$T/first"
cp "$R/etc/orrery-agent.env" "$R/etc/orrery-factorio.env" "$T/"

# ---- A second run changes nothing, asks for no token, downloads only the release list and the deploy/ files, and
# keeps the installed Factorio although a newer one is out.
echo '{"stable":{"headless":"2.1.30"}}' | override factorio.com/api/latest-releases
check 'a second run succeeds without a token on stdin (it keeps the one it has)' 'IN= run "${ARGS[@]}"'
check 'a second run changes nothing' 'written | cmp -s - "$T/first" && cmp -s "$T/orrery-agent.env" "$R/etc/orrery-agent.env" && cmp -s "$T/orrery-factorio.env" "$R/etc/orrery-factorio.env"'
check 'a second run downloads only the release list and the deploy/ files, pulls nothing, installs nothing' '
  [[ -z $(grep ^curl "$F/calls" | grep -vxE "curl https://($API\?per_page=100|$RAW/.*)") ]] &&
  ! called "^(dnf|useradd|podman pull)" && ! says wrote'
check 'a second run keeps the game password' '[[ $(GP_OF) == "$GP" ]] && grep -qx "game password: $GP" "$BOOT"'
check 'a second run keeps the installed Factorio rather than the newest' '! called latest-releases && [[ $(readlink "$R/opt/factorio/current") == releases/2.1.24 ]]'
check 'a second run still restarts the agent (its new release or unit applies)' 'called "^systemctl restart orrery-agent.service$"'

# ---- Hand edits are kept; a file still at the old default takes the new one.
node -e 'const f = process.argv[1], s = JSON.parse(require("fs").readFileSync(f)); s.auto_pause = false; require("fs").writeFileSync(f, JSON.stringify(s))' "$R/srv/factorio/config/server-settings.json"
node -e 'const f = process.argv[1], c = JSON.parse(require("fs").readFileSync(f)); c.mounts.push("/srv"); require("fs").writeFileSync(f, JSON.stringify(c, null, 2))' "$R/etc/orrery-agent/config.json"
cp "$R/srv/factorio/config/server-settings.json" "$R/etc/orrery-agent/config.json" "$T/"
check 'keeps a hand-edited server-settings.json and agent config, and says so' '
  IN= run --agent-id factorio-vm --hub 127.0.0.2:1 --no-hub --admins Alice,Bob,Carol &&
  cmp -s "$T/server-settings.json" "$R/srv/factorio/config/server-settings.json" && cmp -s "$T/config.json" "$R/etc/orrery-agent/config.json" &&
  says "kept /srv/factorio/config/server-settings.json: edited by hand" && says "kept /etc/orrery-agent/config.json: edited by hand"'
check 'keeps the game password of a hand-edited server-settings.json, and still shows it' '
  [[ $(GP_OF) == "$GP" ]] && grep -qx "game password: $GP" "$BOOT" && ! says "warning: no game_password"'
check 'rewrites a config still at its previous default: the new admins' '[[ $(canon "$R/srv/factorio/config/server-adminlist.json") == "[\"Alice\",\"Bob\",\"Carol\"]" ]]'

# ---- A config write that fails is finished by the next run: its saved default changes only after the file does.
# (The test runs as a normal user, as CI does, so the read-only folder stops factorio's write.)
chmod 555 "$R/srv/factorio/config"
check 'a run whose admin-list write fails stops there' '! IN= run "${ARGS[@]}" && says "Permission denied" && [[ $(canon "$R/srv/factorio/config/server-adminlist.json") == "[\"Alice\",\"Bob\",\"Carol\"]" ]]'
chmod 755 "$R/srv/factorio/config"
check 'the next run writes the new admin list, rather than keeping the old one as edited by hand' '
  IN= run "${ARGS[@]}" && [[ $(canon "$R/srv/factorio/config/server-adminlist.json") == "[\"Alice\",\"Bob\"]" ]] && ! says "kept /srv/factorio/config/server-adminlist.json"'

# ---- --new-token replaces the token only; other lines of the file stay.
echo 'FACTORIO_USERNAME=someone' >> "$R/etc/orrery-agent.env"
check '--new-token asks again and replaces only the token line' '
  IN=$NEW_TOKEN run "${ARGS[@]}" --new-token &&
  [[ $(cat "$R/etc/orrery-agent.env") == "ORRERY_AGENT_TOKEN=$NEW_TOKEN
FACTORIO_USERNAME=someone" && $(stat -c %a "$R/etc/orrery-agent.env") == 600 ]] && [[ $(RCON_OF) == "$RCON" ]]'

# ---- --refresh-image pins the new digest and removes the old image by its exact id, never forced.
echo "$DIGEST2" > "$F/digest"
OLD_ID=$(printf '%s' "$OL@sha256:$DIGEST1" | sha256sum | cut -c1-64)
check '--refresh-image pulls again, pins the new digest in image.json and the Quadlet file' '
  IN= run "${ARGS[@]}" --refresh-image && called "^podman pull $OL$" &&
  grep -qx "Image=$OL@sha256:$DIGEST2" "$Q" && grep -qF "$OL@sha256:$DIGEST2" "$R/etc/orrery-agent/image.json"'
check '--refresh-image keeps the game password' '[[ $(GP_OF) == "$GP" ]]'
check '--refresh-image removes the old image by its id only' '[[ $(grep "^podman image rm" "$F/calls") == "podman image rm $OLD_ID" ]]'
touch "$F/active-factorio.service"
echo "$DIGEST1" > "$F/digest"
touch "$F/image-in-use"
check 'an old image still in use is kept; a running server is told it uses the new unit from its next restart' '
  IN= run "${ARGS[@]}" --refresh-image && says "kept the old image" && says "factorio.service was running" &&
  ! called "^systemctl (stop|restart) factorio"'
rm -f "$F/image-in-use" "$F/active-factorio.service"
touch "$F/image-gone"
check 'pulls the pinned image again when it is gone' 'IN= run "${ARGS[@]}" && called "^podman pull $OL@sha256:$DIGEST1$"'
rm -f "$F/image-gone"
for p in u-34197 u-34198 u-34199 t-27015; do
  echo "UNCONN 0 0 127.0.0.1:${p#*-} 0.0.0.0:* uid:986 ino:1 sk:1 cgroup:/system.slice/factorio.service <->" > "$F/ss-$p"
done
check 'ports held by factorio (its own container or agent) are no reason to refuse' 'IN= run "${ARGS[@]}"'

# ---- A Factorio release the image can't run never becomes current: the server keeps its own, so a plain re-run works.
echo 2.1.25 > "$F/glibc"
check 'a --factorio release the image can'\''t run is refused before current points at it' '
  ! IN= run "${ARGS[@]}" --factorio 2.1.25 && says "Factorio 2.1.25 can'\''t run in $OL, whose glibc is too old" &&
  called "^podman run .* /opt/factorio/releases/2.1.25/bin/arm64/factorio --version$" &&
  [[ $(readlink "$R/opt/factorio/current") == releases/2.1.24 && -d $R/opt/factorio/releases/2.1.25 ]]'
check 'a plain re-run then keeps the Factorio the server runs' '
  IN= run "${ARGS[@]}" && [[ $(readlink "$R/opt/factorio/current") == releases/2.1.24 ]]'
rm -f "$F/glibc"
touch "$F/active-factorio.service"
check 'a --factorio release it can run becomes current; a running server is told it runs it from its next restart' '
  IN= run "${ARGS[@]}" --factorio 2.1.25 && [[ $(readlink "$R/opt/factorio/current") == releases/2.1.25 ]] &&
  says "factorio.service was running: it runs Factorio 2.1.25 from its next restart" && ! called "^systemctl (stop|restart) factorio"'
rm -f "$F/active-factorio.service"

# ---- The game password on a VM set up before it existed, and in a file edited by hand without one.
fresh
run "${ARGS[@]}" || true
mkdir -p "$T/old"
printf '{\n  "_comment": "an older default of setup-agent-host.sh",\n  "auto_pause": true\n}\n' > "$T/old/server-settings.json"
cp "$T/old/server-settings.json" "$SET"
cp "$T/old/server-settings.json" "$R/usr/local/lib/orrery/defaults/server-settings.json"
check 'a server-settings.json still at the previous default, without a game password, gets the new default with one' '
  IN= run "${ARGS[@]}" && settings_ok "$SET" && GP2=$(GP_OF) && [[ $GP2 != "$GP" ]] && grep -qx "game password: $GP2" "$BOOT" &&
  cmp -s "$SET" "$R/usr/local/lib/orrery/defaults/server-settings.json" && [[ $(stat -c %a "$R/usr/local/lib/orrery/defaults/server-settings.json") == 600 ]]'
node -e 'const f = process.argv[1], s = JSON.parse(require("fs").readFileSync(f)); delete s.game_password; require("fs").writeFileSync(f, JSON.stringify(s))' "$SET"
cp "$SET" "$T/old/edited.json"
check 'a hand-edited server-settings.json without a game password is kept, and the report warns, without failing the run' '
  IN= run "${ARGS[@]}" && cmp -s "$T/old/edited.json" "$SET" && says "kept /srv/factorio/config/server-settings.json: edited by hand" &&
  says "warning: no game_password found in /srv/factorio/config/server-settings.json" &&
  grep -q "^warning: no game_password found" "$BOOT" && ! grep -q "^game password:" "$BOOT"'

# ---- SELinux and firewalld on.
fresh
touch "$F/selinux" "$F/active-firewalld"
check 'with SELinux enforcing and firewalld running: sets up' 'run "${ARGS[@]}" && called "^rpm -q container-selinux$"'
check 'adds the file contexts: container_file_t on both trees, bin_t on Node'\''s bin/; relabels its four trees' '
  [[ $(grep "^semanage fcontext -a" "$F/calls") == "semanage fcontext -a -t container_file_t $R/opt/factorio(/.*)?
semanage fcontext -a -t container_file_t $R/srv/factorio(/.*)?
semanage fcontext -a -t bin_t $R/usr/local/lib/orrery/node-v[^/]+/bin(/.*)?" ]] &&
  called "^restorecon -R $R/opt/factorio $R/srv/factorio $R/srv/orrery-agent $R/usr/local/lib/orrery$"'
check 'opens 34197/udp in the default-route interface'\''s zone, permanently and at runtime, without a reload' '
  called "^firewall-cmd --permanent --zone=public --add-port=34197/udp$" && called "^firewall-cmd --zone=public --add-port=34197/udp$" &&
  ! called "^firewall-cmd .*reload"'
check 'a second run adds no file context and no port again' '
  IN= run "${ARGS[@]}" && ! called "^semanage fcontext -[am]" && ! called "^firewall-cmd .*--add-port" && called "^restorecon -R"'

# ---- Options: --memory-max, --world, --image, --no-hub; a missing Podman.
fresh
echo 'a world from elsewhere' > "$T/old-world.zip"
check '--memory-max adds MemoryMax= to [Service]; --world copies the world in, with no --create' '
  run "${ARGS[@]}" --memory-max 6G --world "$T/old-world.zip" &&
  [[ $(grep -A1 "^TimeoutStopSec=200$" "$Q" | tail -n 1) == MemoryMax=6G ]] &&
  cmp -s "$T/old-world.zip" "$R/srv/factorio/saves/world.zip" && ! called " --create "'
check 'a re-run with saves in place ignores --world' 'IN= run "${ARGS[@]}" --world "$T/old-world.zip" && says "--world ignored"'
check 'a re-run without --memory-max keeps the cap the Quadlet file has' '
  IN= run "${ARGS[@]}" && [[ $(grep -c "^MemoryMax=" "$Q") == 1 && $(grep -A1 "^TimeoutStopSec=200$" "$Q" | tail -n 1) == MemoryMax=6G ]]'
check 'another --memory-max replaces the cap' 'IN= run "${ARGS[@]}" --memory-max 50% && [[ $(grep "^MemoryMax=" "$Q") == MemoryMax=50% ]]'
check '--memory-max none drops the cap, and a re-run without it adds none back' '
  IN= run "${ARGS[@]}" --memory-max none && ! grep -q "^MemoryMax=" "$Q" && IN= run "${ARGS[@]}" && ! grep -q "^MemoryMax=" "$Q"'
fresh
check '--image pins another image, with its own glibc' '
  run "${ARGS[@]}" --image "$DEBIAN" && grep -qx "Image=$DEBIAN@sha256:$DIGEST1" "$Q" &&
  [[ $(canon "$R/etc/orrery-agent/image.json") == "{\"image\":\"$DEBIAN@sha256:$DIGEST1\",\"glibc\":\"2.41\"}" ]]'
fresh
check '--no-hub only warns when the hub is unreachable' 'run --agent-id factorio-vm --hub 127.0.0.1:1 --admins Alice --no-hub && says "warning: can'\''t reach the hub"'
fresh
check 'under bash -x, no secret reaches the trace: the script turns xtrace off' '
  TRACE=1 run "${ARGS[@]}" && head -n 3 "$T/out" | grep -q "^+ " && GP3=$(GP_OF) && [[ -n $GP3 ]] &&
  ! grep -qF -e "$GP3" -e "$TOKEN" -e "$(RCON_OF)" "$T/out"'
fresh
touch "$F/missing-podman"
check 'installs a missing Podman, then checks it' '
  run "${ARGS[@]}" && [[ $(grep ^dnf "$F/calls") == "dnf install -y podman" ]] && called "^podman --version$"'
fresh
touch "$F/check-fails"
check 'a failing first-boot check fails the run, with the report saved' '
  ! run "${ARGS[@]}" && says "the first-boot check found a problem" && grep -q "every check ran" "$R/srv/factorio/first-boot.txt"'
fresh
touch "$F/start-fails"
check 'a unit that will not start still gets the report, and fails the run' '
  ! run "${ARGS[@]}" && says "warning: factorio.service didn'\''t start" && grep -q "every check ran" "$R/srv/factorio/first-boot.txt"'

# ---- A half-failed run (the agent's download fails) is finished by the next.
fresh
gone "$AGENT_TGZ"
check 'a run whose agent download fails stops there, before secrets, units and any start' '
  ! run "${ARGS[@]}" && says "can'\''t download https://$AGENT_TGZ" && ! called "$STARTED" &&
  [[ ! -e $R/etc/orrery-agent.env && ! -e $Q && -d $R/opt/factorio/releases/2.1.24 ]]'
rm -rf "$F/gone"
check 'the next run finishes it: the same files as a clean run' 'run "${ARGS[@]}" && written | cmp -s - "$T/first"'

# ---- Links in factorio's trees, or at a unit, can't steer a write.
fresh
run "${ARGS[@]}" || true
for n in 1 2 3; do echo precious > "$T/elsewhere-$n"; done
printf '# %s\n' "Managed by orrery deploy/setup-agent-host.sh" > "$T/elsewhere-4"
ln -sfn "$T/elsewhere-1" "$R/srv/factorio/config/server-settings.json"
ln -sfn "$T/elsewhere-2" "$R/srv/factorio/first-boot.txt"
rm "$R/srv/factorio/mods/mod-list.json"
ln -s "$T/elsewhere-3" "$R/srv/factorio/mods/mod-list.json"
ln -sfn "$T/elsewhere-4" "$R/etc/systemd/system/orrery-agent.service"
check 'links at its files are kept (configs) or replaced (the report, units), never written through' '
  IN= run "${ARGS[@]}" && [[ $(cat "$T/elsewhere-1" "$T/elsewhere-2" "$T/elsewhere-3") == "precious
precious
precious" && $(cat "$T/elsewhere-4") == "# Managed by orrery deploy/setup-agent-host.sh" ]] &&
  [[ -L $R/srv/factorio/config/server-settings.json && -L $R/srv/factorio/mods/mod-list.json ]] &&
  [[ ! -L $R/srv/factorio/first-boot.txt && ! -L $R/etc/systemd/system/orrery-agent.service ]] &&
  cmp -s "$R/etc/systemd/system/orrery-agent.service" "$HERE/orrery-agent.service" && says "warning: no game_password found"'

# ---- Refusals in preflight: nothing written, nothing run that changes anything.
refuses() { # <what> <why it says> <setup> [args…]
  local what=$1 why=$2 setup=$3
  shift 3
  ARGV=("$@") WHY=$why
  fresh
  eval "$setup"
  written > "$T/before"
  check "refuses $what" '! run "${ARGV[@]}" && says "$WHY" && written | cmp -s - "$T/before" && ! called "$MUTATING"'
}
refuses 'without root' 'run it as root' 'touch "$F/not-root"' "${ARGS[@]}"
refuses 'another OS' 'Oracle Linux 9 or 10' 'sed -i "s/^ID=.*/ID=\"rhel\"/" "$R/etc/os-release"' "${ARGS[@]}"
refuses 'Oracle Linux 8' 'Oracle Linux 9 or 10' 'sed -i "s/^VERSION_ID=.*/VERSION_ID=\"8.10\"/" "$R/etc/os-release"' "${ARGS[@]}"
refuses 'x86_64' 'this is for aarch64' 'echo x86_64 > "$F/arch"' "${ARGS[@]}"
refuses 'Podman 4.5' 'Podman 4.5.1 is too old: this needs 4.6 or newer' 'echo "podman version 4.5.1" > "$F/podman-version"' "${ARGS[@]}"
refuses 'no Quadlet generator' 'no Quadlet generator' 'rm "$R/usr/libexec/podman/quadlet"' "${ARGS[@]}"
refuses 'no tailnet IP' 'join the tailnet first' 'touch "$F/no-tailnet"' "${ARGS[@]}"
refuses 'an unreachable hub (without --no-hub)' "can't reach the hub" '' --agent-id factorio-vm --hub 127.0.0.1:1 --admins Alice
for p in u-34197 u-34198 u-34199 t-27015; do
  refuses "port ${p#*-} busy" "port ${p#*-}/" "echo 'UNCONN 0 0 0.0.0.0:${p#*-} 0.0.0.0:* uid:1000 ino:1 sk:1 <->' > \"\$F/ss-$p\"" "${ARGS[@]}"
done
refuses 'a port held by root' 'port 27015/tcp is in use' "echo 'LISTEN 0 4096 127.0.0.1:27015 0.0.0.0:* ino:1 sk:1 <->' > \"\$F/ss-t-27015\"" "${ARGS[@]}"
refuses 'a port held by another user while factorio exists' 'port 34197/udp is in use' \
  "echo 'factorio:x:986:986::/srv/factorio:/sbin/nologin' > \"\$F/passwd\"; echo 'UNCONN 0 0 0.0.0.0:34197 0.0.0.0:* uid:1000 <->' > \"\$F/ss-u-34197\"" "${ARGS[@]}"
refuses 'a factorio user it did not make' 'a user factorio exists' "echo 'factorio:x:1001:1001::/home/factorio:/bin/bash' > \"\$F/passwd\"" "${ARGS[@]}"
refuses 'a factorio group without the user' 'a group factorio exists without the user' "echo 'factorio:x:1001:' > \"\$F/group\"" "${ARGS[@]}"
refuses 'a foreign factorio.service' 'factorio.service exists' 'printf "LoadState=loaded\nSourcePath=\n" > "$F/show-factorio.service"' "${ARGS[@]}"
refuses 'a masked factorio.service' 'factorio.service exists (masked' 'printf "LoadState=masked\n" > "$F/show-factorio.service"' "${ARGS[@]}"
refuses 'a foreign orrery-agent.service' 'orrery-agent.service exists' \
  'printf "LoadState=loaded\nFragmentPath=/usr/lib/systemd/system/orrery-agent.service\n" > "$F/show-orrery-agent.service"' "${ARGS[@]}"
refuses 'a factorio.container it did not write' 'factorio.container exists without the line' \
  'mkdir -p "$R/etc/containers/systemd"; echo "[Container]" > "$R/etc/containers/systemd/factorio.container"' "${ARGS[@]}"
refuses 'a polkit file it did not write' '60-orrery-agent.rules exists without the line' \
  'mkdir -p "$R/etc/polkit-1/rules.d"; echo "// mine" > "$R/etc/polkit-1/rules.d/60-orrery-agent.rules"' "${ARGS[@]}"
refuses 'a container named factorio without the label' 'without the label orrery.managed=true' 'echo "<no value>" > "$F/container"' "${ARGS[@]}"
refuses 'a symlinked folder in its tree' 'is a symlink' 'mkdir -p "$R/srv/factorio" "$T/elsewhere-dir"; ln -s "$T/elsewhere-dir" "$R/srv/factorio/config"' "${ARGS[@]}"
refuses 'under 10 GB free' 'this needs 10 GB' 'echo 1048576 > "$F/df"' "${ARGS[@]}"
refuses 'a short token' 'the agent token must be 32 or more' 'IN=short' "${ARGS[@]}"
refuses 'a token with a quote' 'the agent token must be 32 or more' 'IN="0123456789abcdef0123456789abcdef\"x"' "${ARGS[@]}"
refuses 'no token at all' 'the agent token must be 32 or more' 'IN=' "${ARGS[@]}"
IN=$TOKEN
for id in Factorio-VM -vm 'a;b' '' "$(printf 'a%.0s' {1..33})"; do
  refuses "the agent id '$id'" '' '' --agent-id "$id" --hub "$HUB" --admins Alice
done
for h in hub.example:25584 100.64.0.1 100.64.0.256:25584 100.64.0.1:0 100.64.0.1:65536 100.64.0.01:25584 '100.64.0.1:25584;x' '[::1]:25584'; do
  refuses "the hub address '$h'" 'bad hub address' '' --agent-id factorio-vm --hub "$h" --admins Alice
done
for a in 'Alice,,Bob' 'Al ice' '"Bob"' 'Alice,'; do
  refuses "the admins '$a'" 'bad admin names' '' --agent-id factorio-vm --hub "$HUB" --admins "$a"
done
refuses 'a bad --factorio' 'bad Factorio version' '' "${ARGS[@]}" --factorio ../2.1
refuses 'a short image name' 'bad image' '' "${ARGS[@]}" --image oraclelinux:10-slim
refuses 'an image with no tag' 'bad image' '' "${ARGS[@]}" --image docker.io/library/debian
refuses 'an image with a digest' 'bad image' '' "${ARGS[@]}" --image "$OL@sha256:$DIGEST1"
refuses 'a bad --memory-max' 'bad --memory-max' '' "${ARGS[@]}" --memory-max '6 G'
refuses 'a MemoryMax= in the Quadlet file it does not write, without --memory-max' 'has MemoryMax=infinity, which this script doesn' \
  'mkdir -p "$R/etc/containers/systemd"; printf "# x\n# %s\nMemoryMax=infinity\n" "$MARKER_LINE" > "$Q"' "${ARGS[@]}"
refuses 'a relative --world' 'absolute plain path' '' "${ARGS[@]}" --world world.zip
refuses 'a missing --world' 'no world file' '' "${ARGS[@]}" --world /nonexistent/world.zip
refuses 'an unknown flag' 'usage:' '' "${ARGS[@]}" --force
refuses 'missing --admins' 'usage:' '' --agent-id factorio-vm --hub "$HUB"

# ---- Refusals after preflight: the bad thing is not installed and nothing is started.
refuses_late() { # <what> <why it says> <setup> <a path that must not exist> [args…]
  local what=$1 why=$2 setup=$3
  ABSENT=$4 WHY=$why
  shift 4
  ARGV=("$@")
  fresh
  eval "$setup"
  check "refuses $what" '! run "${ARGV[@]}" && says "$WHY" && [[ ! -e $ABSENT && ! -L $ABSENT ]] && ! called "$STARTED"'
}
refuses_late "Node's download not matching its pin" "doesn't match its pinned sha256" 'SCRIPT=$HERE/setup-agent-host.sh' \
  "$R/usr/local/lib/orrery/node" "${ARGS[@]}"
SCRIPT=
refuses_late 'a Factorio download not matching sha256sums/' "doesn't match factorio.com's sha256" \
  'sed "s/^[0-9a-f]*  factorio-headless_linux-arm64/$DIGEST2  factorio-headless_linux-arm64/" "$X/$SUMS" | override "$SUMS"' \
  "$R/opt/factorio/current" "${ARGS[@]}"
check 'and leaves no download behind' '[[ -z $(ls -A "$R/opt/factorio/.incoming") && ! -e $R/opt/factorio/releases/2.1.24 ]]'
refuses_late 'a sha256sums/ without the arm64 file' 'lists no factorio-headless_linux-arm64_2.1.24.tar.xz' \
  'grep -v arm64 "$X/$SUMS" | override "$SUMS"' "$R/opt/factorio/current" "${ARGS[@]}"
refuses_late 'an agent download not matching its .sha256' "doesn't match its .sha256" \
  'echo "$DIGEST2  orrery-agent-v0.10.0.tar.gz" | override "$AGENT_TGZ.sha256"' "$R/srv/orrery-agent/current" "${ARGS[@]}"
refuses_late 'a mod download not matching its listed sha256' "doesn't match the sha256 GitHub lists" \
  'api "$DIGEST2" | override "$API"' "$R/srv/factorio/mods/orrery_0.1.0.zip" "${ARGS[@]}"
refuses_late 'no agent release' 'GitHub has no agent-v release yet' 'grep -v "\"agent-v0" "$X/$API" | override "$API"' \
  "$R/srv/orrery-agent/current" "${ARGS[@]}"
refuses_late 'the Quadlet dry run failing' 'fake failure' 'touch "$F/quadlet-fails"' "$Q" "${ARGS[@]}"
refuses_late 'a Quadlet key Podman 4.6 lacks, even when the dry run exits 0' "unsupported key 'StopTimeout'" \
  'sed "s/^PodmanArgs=.*/StopTimeout=170/" "$HERE/factorio.container" | override "$RAW/factorio.container"' "$Q" "${ARGS[@]}"
refuses_late 'a template value it does not fill' "doesn't fill: <hostname>" \
  'sed "s/^ContainerName=.*/HostName=<hostname>/" "$HERE/factorio.container" | override "$RAW/factorio.container"' "$Q" "${ARGS[@]}"
refuses_late 'a release unit without the marker' "deploy/orrery-agent.service at agent-v0.10.0 has no line" \
  'grep -v "Managed by" "$HERE/orrery-agent.service" | override "$RAW/orrery-agent.service"' \
  "$R/etc/systemd/system/orrery-agent.service" "${ARGS[@]}"
refuses_late "Factorio needing a newer glibc than the image's, naming the fallback" "--image $DEBIAN" 'touch "$F/glibc"' \
  "$R/etc/orrery-agent/image.json" "${ARGS[@]}"
refuses_late 'a dnf-installed Podman older than 4.6' 'this needs 4.6 or newer' \
  'touch "$F/missing-podman"; echo "podman version 4.4.1" > "$F/podman-version"' "$R/usr/local/lib/orrery" "${ARGS[@]}"

# ---- Over every run above.
check 'podman never prunes, resets, touches the system or --all, or removes a container; images only by id' '
  ! grep -qE "^podman .*( prune| system | reset|--all| -a( |$))" "$T/all-calls" && ! grep -qE "^podman (rm|container rm|kill|stop)" "$T/all-calls" &&
  [[ -z $(grep "^podman image rm" "$T/all-calls" | grep -vE "^podman image rm [0-9a-f]{64}$") ]]'
check 'dnf never updates, upgrades or touches a module; only installs' '[[ -z $(grep ^dnf "$T/all-calls" | grep -v "^dnf install -y ") ]] && ! grep -qE "^dnf .*(update|upgrade|module)" "$T/all-calls"'
check 'never enables factorio.service, nor starts, enables or reloads firewalld' '
  ! grep -qE "^systemctl .*enable.*factorio\.service|^systemctl (start|enable|restart|reload|stop).*firewalld|^firewall-cmd .*(reload|--set-|--new-zone|--change|--remove)" "$T/all-calls"'
check 'runs things only as factorio' '[[ -z $(grep ^runuser "$T/all-calls" | grep -v "^runuser factorio ") ]]'
check 'root never writes inside factorio'\''s trees: every download, unpack, temp file, rename, link, mkdir and rm there runs as factorio' '
  [[ -z $(grep "^as root " "$T/all-calls" | grep -F -e " $R/opt" -e " $R/srv") ]] &&
  grep -qF "as factorio curl -o $R/opt/factorio/.incoming/.factorio-headless_linux-arm64_2.1.24.tar.xz." "$T/all-calls" &&
  grep -qF "as factorio tar -xJf $R/opt/factorio/.incoming/" "$T/all-calls" &&
  grep -qF "as factorio curl -o $R/srv/factorio/mods/.orrery_0.1.0.zip." "$T/all-calls" &&
  grep -qF "as factorio curl -o $R/srv/orrery-agent/.incoming/.orrery-agent-v0.10.0.tar.gz." "$T/all-calls" &&
  grep -qE "^as factorio mv -T $R/srv/factorio/config/\.server-adminlist\.json\.[A-Za-z0-9]{6} $R/srv/factorio/config/server-adminlist\.json$" "$T/all-calls" &&
  grep -qF "as factorio ln -sfn releases/2.1.24 $R/opt/factorio/.current.new" "$T/all-calls" &&
  grep -qE "^as root mv -T $R/usr/local/lib/orrery/" "$T/all-calls"'

exit $fail

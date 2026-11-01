#!/usr/bin/env bash
# Managed by orrery deploy/setup-agent-host.sh: this script, kept as /usr/local/lib/orrery/setup-agent-host.sh.
# Sets up a remote Host for the orrery Agent: Factorio in a rootful Podman container (Quadlet's factorio.service),
# the Agent natively as orrery-agent.service with a private Node, and polkit for the agent's user. The friend runs it
# as root on his Oracle Linux 9 (or 10) aarch64 VM, from a release tag:
#   curl -fsSLO https://raw.githubusercontent.com/Edward-Pratt/orrery/agent-vX.Y.Z/deploy/setup-agent-host.sh
#   sudo bash setup-agent-host.sh --agent-id factorio-vm --hub 100.101.102.103:25584 --admins Alice,Bob
# --hub is the hub's tailnet IPv4 and Agent port; --admins the in-game admins' Factorio names. Optional:
#   --factorio <version>   that Factorio version (else the newest stable headless; a re-run keeps the installed one)
#   --image <name:tag>     the image (default container-registry.oracle.com/os/oraclelinux:10-slim; fallback
#                          docker.io/library/debian:trixie-slim)
#   --refresh-image        pull the image again and pin its new digest (best while the server is stopped)
#   --memory-max <size>    MemoryMax= for the container (e.g. 6G or 50%); a re-run without it keeps the cap the
#                          installed factorio.container has, and --memory-max none drops it (no cap by default)
#   --world <path.zip>     the first world, when saves/ is empty (else a new one is created)
#   --no-hub               the hub check only warns: for the run before the hub listens (the agent then only logs)
#   --new-token            ask for the agent token again (a re-run keeps the one it has)
# The agent token is asked for on the terminal, never taken from argv.
#
# It installs the newest agent-v* release (orrery-agent-vX.Y.Z.tar.gz, as release.yml names it, checked against its
# .sha256, and this folder's factorio.container, orrery-agent.service, orrery-agent-deploy@.service,
# 60-orrery-agent.rules and deploy-agent.sh at that same tag) and, when mods/ has none, the newest factorio-v*
# release's orrery_<ver>.zip (checked against the sha256 GitHub lists for it). All public on GitHub, no token.
#
# It touches only: the user and group factorio; /opt/factorio, /srv/factorio, /srv/orrery-agent, /usr/local/lib/orrery,
# /etc/orrery-agent/, /etc/orrery-agent.env, /etc/orrery-factorio.env; /etc/containers/systemd/factorio.container,
# /etc/systemd/system/orrery-agent.service and orrery-agent-deploy@.service, /etc/polkit-1/rules.d/60-orrery-agent.rules;
# SELinux file contexts for its own folders; one image and the container factorio; 34197/udp in the default-route
# interface's firewalld zone, if firewalld runs.
# It never: runs dnf update or a dnf module, or upgrades Podman; installs a system-wide Node; edits registries.conf,
# storage.conf or containers.conf; prunes, resets or touches other containers, images, networks or volumes; enables,
# starts, reloads or reconfigures firewalld; changes SELinux booleans or modes; adds factorio to any group.
#
# Safe to run again. Unit, polkit, .container and shell files it writes carry the "Managed by" line above, and it
# refuses to overwrite one without it. Config files are written only when missing or still its own previous default
# (kept root-only in /usr/local/lib/orrery/defaults/), so hand edits stay. server-settings.json gets a random
# game_password (20 letters and digits), kept on a re-run; it is shown only in /srv/factorio/first-boot.txt (mode 600,
# factorio's), never on the terminal, in an argv or in a trace. Everything else is written only when it differs, so a
# second run finishes a half-failed one. Root never writes inside factorio's trees: those writes run as factorio,
# and every write goes to a new temp file in the target's folder, then a rename, so a link left there steers nothing.
# SETUP_ROOT exists for deploy/test-setup-agent-host.sh only: it prefixes every path the script reads or writes (/etc,
# /opt, /srv, /usr/local, and /usr/libexec for the Quadlet generator). The files it writes still name the real paths.
set -euo pipefail
{ set +x; } 2> /dev/null # the token and the passwords pass through variables: never in a trace (bash -x)
die() { echo "setup-agent-host: $*" >&2; exit 1; }
usage() {
  echo "usage: $0 --agent-id <id> --hub <ipv4>:<port> --admins <name>[,<name>...] [--factorio <version>]" \
    "[--image <name:tag>] [--refresh-image] [--memory-max <size>|none] [--world <path.zip>] [--no-hub] [--new-token]" >&2
  exit 2
}
umask 077

R=${SETUP_ROOT:-}
MARKER='Managed by orrery deploy/setup-agent-host.sh'
REPO=Edward-Pratt/orrery
# The current Node 24 LTS (Krypton) in https://nodejs.org/dist/index.json; the sha256 is the
# node-v24.22.2-linux-arm64.tar.xz line of https://nodejs.org/dist/v24.22.2/SHASUMS256.txt (both read 2026-10-31).
NODE_VERSION=24.22.2
NODE_SHA256=eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8
DEFAULT_IMAGE=container-registry.oracle.com/os/oraclelinux:10-slim
FALLBACK_IMAGE=docker.io/library/debian:trixie-slim
etc=$R/etc lib=$R/usr/local/lib/orrery opt=$R/opt/factorio srv=$R/srv/factorio agent=$R/srv/orrery-agent
quadlet_gen=$R/usr/libexec/podman/quadlet
# -q first: no .curlrc. Downloads as factorio run with HOME=/srv/factorio, which the container can write.
CURL=(curl -q -fsSL --proto =https --proto-redir =https --retry 2)

# ---- Arguments, each checked against a plain charset before it goes anywhere.
agent_id='' hub='' admins='' factorio='' image='' refresh=0 memory_max='' world='' no_hub=0 new_token=0
while (($#)); do
  case $1 in
    --agent-id | --hub | --admins | --factorio | --image | --memory-max | --world)
      (($# >= 2)) || usage
      case $1 in
        --agent-id) agent_id=$2 ;; --hub) hub=$2 ;; --admins) admins=$2 ;; --factorio) factorio=$2 ;;
        --image) image=$2 ;; --memory-max) memory_max=$2 ;; --world) world=$2 ;;
      esac
      shift 2 ;;
    --refresh-image) refresh=1; shift ;;
    --no-hub) no_hub=1; shift ;;
    --new-token) new_token=1; shift ;;
    *) usage ;;
  esac
done
[[ -n $agent_id && -n $hub && -n $admins ]] || usage
[[ $agent_id =~ ^[a-z][a-z0-9-]{0,31}$ ]] || die "bad agent id: $agent_id (want ^[a-z][a-z0-9-]{0,31}$, its id in the hub's config)"
octet='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
if [[ $hub =~ ^($octet\.$octet\.$octet\.$octet):([1-9][0-9]{0,4})$ ]] && ((BASH_REMATCH[6] <= 65535)); then
  hub_host=${BASH_REMATCH[1]} hub_port=${BASH_REMATCH[6]}
else
  die "bad hub address: $hub (want the hub's tailnet IPv4 and Agent port, like 100.101.102.103:25584)"
fi
[[ $admins =~ ^[A-Za-z0-9._-]{1,64}(,[A-Za-z0-9._-]{1,64})*$ ]] || die "bad admin names: $admins (Factorio names, comma-separated)"
[[ -z $factorio || $factorio =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "bad Factorio version: $factorio (want X.Y.Z)"
[[ -z $image || ($image =~ ^[a-z0-9.-]+\.[a-z]+(:[0-9]+)?/[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$ && $image != *..*) ]] ||
  die "bad image: $image (want a full name with its registry and a tag, like $FALLBACK_IMAGE)"
memory_ok() { [[ $1 =~ ^[1-9][0-9]*[KMGT]?$ || $1 =~ ^[1-9][0-9]?%$ ]]; } # systemd's MemoryMax=, of the kinds this writes
[[ -z $memory_max || $memory_max == none ]] || memory_ok "$memory_max" ||
  die "bad --memory-max: $memory_max (want systemd's MemoryMax=, like 6G or 50%, or none)"
if [[ -n $world ]]; then
  [[ $world =~ ^/[A-Za-z0-9._/-]+\.zip$ && $world != *..* ]] || die "the world must be an absolute plain path to a .zip: $world"
  [[ -f $world ]] || die "no world file $world"
fi

# managed <file>: missing, or carrying the marker line in its first lines.
managed() { [[ ! -e $1 ]] || grep -qF "$MARKER" < <(head -n 3 -- "$1"); }
# env_value <file> <key>: a value from a root-only env file, read by builtins only (no secret in any argv).
env_value() {
  local line
  [[ -f $1 ]] || return 0
  while IFS= read -r line; do
    if [[ $line == "$2="* ]]; then printf '%s' "${line#"$2="}"; return 0; fi
  done < "$1"
}
installed() { rpm -q --whatprovides "$1" > /dev/null 2>&1; }
podman_ok() { # Podman 4.6 or newer (the Quadlet keys factorio.container uses), and its Quadlet generator
  local v
  v=$(podman --version) || die "podman --version failed"
  [[ $v =~ ([0-9]+)\.([0-9]+)\.[0-9]+ ]] || die "can't read the Podman version: $v"
  ((BASH_REMATCH[1] > 4 || (BASH_REMATCH[1] == 4 && BASH_REMATCH[2] >= 6))) ||
    die "Podman ${BASH_REMATCH[0]} is too old: this needs 4.6 or newer. Update Podman yourself (this script never does), then run it again"
  [[ -x $quadlet_gen ]] || die "no Quadlet generator at /usr/libexec/podman/quadlet: Podman 4.6 or newer has it"
}

# ---- 1. Preflight: every refusal before any change.
[[ $(id -u) == 0 ]] || die "run it as root: sudo bash $0 ..."
[[ -f ${BASH_SOURCE[0]} ]] || die "run it from its file (it keeps a copy of itself), not from a pipe"
[[ -f $etc/os-release ]] || die "no /etc/os-release"
os_id='' os_ver=''
while IFS='=' read -r k v; do
  v=${v//\"/}
  case $k in ID) os_id=$v ;; VERSION_ID) os_ver=$v ;; esac
done < "$etc/os-release"
[[ $os_id == ol && $os_ver =~ ^(9|10)(\.[0-9]+)?$ ]] || die "this is for Oracle Linux 9 or 10 (/etc/os-release says $os_id $os_ver)"
arch=$(uname -m)
[[ $arch == aarch64 ]] || die "this is for aarch64, the arch of Factorio's arm64 headless build (uname -m says $arch)"
if installed podman; then
  podman_ok
  if podman container exists factorio; then
    [[ $(podman container inspect --format '{{index .Config.Labels "orrery.managed"}}' factorio) == true ]] ||
      die "a container named factorio exists without the label orrery.managed=true: it isn't this script's, so rename or remove it yourself"
  fi
fi
command -v tailscale > /dev/null || die "no tailscale: join the tailnet first"
ts_ip=$(tailscale ip -4 2> /dev/null | head -n 1) || ts_ip=''
[[ -n $ts_ip ]] || die "tailscale ip -4 is empty: join the tailnet first"
if ! timeout 5 bash -c 'exec 3<> "/dev/tcp/$0/$1"' "$hub_host" "$hub_port" 2> /dev/null; then
  ((no_hub)) || die "can't reach the hub at $hub: check the tailnet policy and that the hub runs (or use --no-hub before it listens)"
  echo "warning: can't reach the hub at $hub (--no-hub: going on; the agent only logs until the hub listens)" >&2
fi
fuid=''
if pw=$(getent passwd factorio); then
  IFS=: read -r _ _ fuid _ _ fhome fshell <<< "$pw"
  [[ $fuid =~ ^[0-9]+$ ]] && ((fuid > 0 && fuid < 1000)) && [[ $fhome == /srv/factorio && $fshell == */nologin ]] ||
    die "a user factorio exists that this script didn't make (uid $fuid, home $fhome, shell $fshell): it needs a system user with home /srv/factorio and shell nologin"
elif getent group factorio > /dev/null; then # useradd --user-group would refuse it, after the packages and Node went in
  die "a group factorio exists without the user factorio: this script makes both, so remove or rename the group first"
fi
# A port is ours only when the socket is factorio's (the agent, or Factorio in its container: no user namespace).
for p in udp:34197 udp:34198 udp:34199 tcp:27015; do
  proto=${p%:*} port=${p#*:}
  while IFS= read -r line; do
    [[ -n $line ]] || continue
    [[ -n $fuid && " $line " == *" uid:$fuid "* ]] || die "port $port/$proto is in use by another program: $line"
  done < <(ss -Hln"${proto:0:1}"e "sport = :$port")
done
for f in "$etc/containers/systemd/factorio.container" "$etc/systemd/system/orrery-agent.service" \
  "$etc/systemd/system/orrery-agent-deploy@.service" "$etc/polkit-1/rules.d/60-orrery-agent.rules" \
  "$lib/setup-agent-host.sh" "$lib/deploy-agent.sh"; do
  managed "$f" || die "${f#"$R"} exists without the line \"$MARKER\": it isn't this script's, so move it away first"
done
# Without --memory-max, the cap stays what the installed factorio.container has (this script's file, checked above).
quadlet=$etc/containers/systemd/factorio.container
if [[ -z $memory_max && -f $quadlet ]]; then
  while IFS= read -r line; do [[ $line != MemoryMax=* ]] || memory_max=${line#MemoryMax=}; done < "$quadlet"
  [[ -z $memory_max ]] || memory_ok "$memory_max" ||
    die "factorio.container has MemoryMax=$memory_max, which this script doesn't write: give --memory-max <size> or --memory-max none"
fi
[[ $memory_max != none ]] || memory_max=''
# unit_from <unit> <property> <path>: the unit is unknown, or systemd loads it from this script's file.
unit_from() {
  local k v load='' from=''
  while IFS='=' read -r k v; do
    case $k in LoadState) load=$v ;; "$2") from=$v ;; esac
  done < <(systemctl show -p LoadState -p "$2" "$1")
  [[ $load == not-found || $from == "$3" ]] || die "$1 exists ($load, from ${from:-somewhere else}) and isn't this script's: move it away first"
}
unit_from factorio.service SourcePath /etc/containers/systemd/factorio.container
unit_from orrery-agent.service FragmentPath /etc/systemd/system/orrery-agent.service
for d in "$opt" "$srv" "$agent" "$lib" "$opt/releases" "$opt/.incoming" "$srv/config" "$srv/saves" "$srv/mods" \
  "$srv/script-output" "$srv/.incoming" "$agent/releases" "$agent/state" "$agent/.incoming"; do
  [[ ! -L $d ]] || die "${d#"$R"} is a symlink: this script writes there only through real folders"
done
avail=$(df -Pk "$R/" | awk 'NR == 2 { print $4 }')
((avail >= 10 * 1024 * 1024)) || die "the root filesystem has $((avail / 1024 / 1024)) GB free: this needs 10 GB"

# The token: kept from the env file unless --new-token, else asked for (never echoed, never in argv).
token=''
((new_token)) || token=$(env_value "$etc/orrery-agent.env" ORRERY_AGENT_TOKEN)
token_re='^[A-Za-z0-9+/=._~-]{32,512}$'
if ! [[ $token =~ $token_re ]]; then
  read -rsp 'Agent token (from the owner; not shown): ' token || true
  echo >&2
  [[ $token =~ $token_re ]] || die "the agent token must be 32 or more plain characters (letters, digits and + / = . _ ~ -)"
  token_new=1
else
  token_new=0
fi

# put <file> <mode>: stdin into <file> (root's own folders only), only when it differs, through a new temp file in
# its folder and a rename (mktemp creates it, so a link left at the temp name steers nothing).
put() {
  local new tmp
  new=$(cat)
  if [[ -f $1 && ! -L $1 && $(< "$1") == "$new" ]]; then return 0; fi
  tmp=$(mktemp "$(dirname -- "$1")/.${1##*/}.XXXXXX")
  printf '%s\n' "$new" > "$tmp"
  chmod "$2" "$tmp"
  mv -T "$tmp" "$1"
  changed=1
  echo "wrote ${1#"$R"}"
}
# put_managed <file> <mode>: put, for the unit, polkit, .container and shell files: never over one without the marker.
put_managed() {
  managed "$1" || die "${1#"$R"} exists without the line \"$MARKER\": not overwriting it"
  put "$@"
}
as_factorio() { runuser -u factorio -- "$@"; }
# fwrite <file>: stdin (any bytes) into <file> as factorio, through a new temp file in its folder and a rename.
fwrite() { as_factorio bash -c 't=$(mktemp "$(dirname -- "$1")/.${1##*/}.XXXXXX") && cat > "$t" && mv -T "$t" "$1"' fwrite "$1"; }
# fput <file>: stdin into <file> in factorio's trees, only when it differs.
fput() {
  local new
  new=$(cat)
  if [[ ! -L $1 && $(as_factorio cat -- "$1" 2> /dev/null) == "$new" ]]; then return 0; fi
  printf '%s\n' "$new" | fwrite "$1"
  echo "wrote ${1#"$R"}"
}
# config <root|factorio> <file>: stdin is this script's default for <file>. Written when <file> is missing or still the
# previous default (kept in defaults/, root-only: server-settings.json's holds the game password), so a file edited by
# hand (or a link put there) is kept as it is.
config() {
  local saved=$lib/defaults/${2##*/} new cur=''
  new=$(cat)
  if [[ -L $2 || -e $2 ]]; then
    if [[ ! -L $2 ]]; then
      if [[ $1 == factorio ]]; then cur=$(as_factorio cat -- "$2") || cur=''; else cur=$(< "$2"); fi
    fi
    if [[ -L $2 ]] || [[ $cur != "$new" && ! (-f $saved && $cur == "$(< "$saved")") ]]; then
      echo "kept ${2#"$R"}: edited by hand"
      return 0
    fi
  fi
  # The target first: a run stopped between the two finds it equal to the new default, so the next run saves it.
  if [[ $1 == factorio ]]; then fput "$2" <<< "$new"; else put "$2" 644 <<< "$new"; fi
  put "$saved" 600 <<< "$new"
}
fsha() { local h; h=$(as_factorio sha256sum -- "$1"); printf '%s' "${h%% *}"; }
fetch() { "${CURL[@]}" -o "$2" "$1" || die "can't download ${1%%\?*}"; }
fetch_text() { "${CURL[@]}" "$1" || die "can't download ${1%%\?*}"; }
# ffetch <url> <folder> <name>: a download into a new temp file in factorio's <folder>; prints its path.
ffetch() {
  local t
  t=$(as_factorio mktemp "$2/.$3.XXXXXX")
  as_factorio "${CURL[@]}" -o "$t" "$1" || { as_factorio rm -f -- "$t"; die "can't download ${1%%\?*}"; }
  printf '%s' "$t"
}
# flip <folder> <target>: points <folder>/current at <target> in one rename, as factorio, when it doesn't already.
flip() {
  [[ $(readlink "$1/current" 2> /dev/null) != "$2" ]] || return 0
  as_factorio ln -sfn "$2" "$1/.current.new"
  as_factorio mv -T "$1/.current.new" "$1/current"
  echo "${1#"$R"}/current -> $2"
}
changed=0

# ---- 2. Packages. This is the one dnf section: an explicit exception to the "no dnf" rule, because this script
# targets one known OS. It installs only what is missing; never an update, an upgrade or a module.
missing=()
for p in podman container-selinux policycoreutils-python-utils tar xz curl; do
  installed "$p" || missing+=("$p")
done
if ((${#missing[@]})); then dnf install -y "${missing[@]}"; fi
# ---- end of the dnf section.
podman_ok
if command -v getenforce > /dev/null && [[ $(getenforce) == Enforcing ]]; then
  rpm -q container-selinux > /dev/null 2>&1 || die "SELinux is enforcing but container-selinux is missing"
fi

# ---- 3. Node, private: in /usr/local/lib/orrery/node, on no PATH.
install -d -m 755 "$lib" "$lib/defaults"
install -d -m 700 "$lib/.incoming"
node_dir=$lib/node-v$NODE_VERSION
if [[ ! -x $node_dir/bin/node ]]; then
  tarball=$lib/.incoming/node-v$NODE_VERSION-linux-arm64.tar.xz
  fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz" "$tarball"
  read -r h _ < <(sha256sum < "$tarball")
  [[ $h == "$NODE_SHA256" ]] || { rm -f "$tarball"; die "Node $NODE_VERSION's download doesn't match its pinned sha256"; }
  rm -rf "$lib/.incoming/node" "$node_dir"
  install -d -m 755 "$lib/.incoming/node"
  tar -xJf "$tarball" --no-same-owner --strip-components=1 -C "$lib/.incoming/node"
  rm -f "$tarball"
  mv -T "$lib/.incoming/node" "$node_dir"
  echo "installed Node $NODE_VERSION in ${node_dir#"$R"}"
fi
if [[ $(readlink "$lib/node" 2> /dev/null) != "node-v$NODE_VERSION" ]]; then
  ln -sfn "node-v$NODE_VERSION" "$lib/.node.new"
  mv -T "$lib/.node.new" "$lib/node"
fi
node=$lib/node/bin/node

# ---- 4. The user: a system user with no login and no groups but its own.
getent passwd factorio > /dev/null || useradd --system --user-group --home-dir /srv/factorio --shell /sbin/nologin factorio
uid=$(id -u factorio) gid=$(id -g factorio)
[[ $uid =~ ^[0-9]+$ && $gid =~ ^[0-9]+$ ]] || die "can't read factorio's uid and gid"

# ---- 5. The layout, all factorio's. Below the three roots, only factorio writes.
install -d -m 755 -o factorio -g factorio "$opt"
install -d -m 750 -o factorio -g factorio "$srv" "$agent"
as_factorio mkdir -p "$opt/releases" "$opt/.incoming" "$srv/config" "$srv/saves" "$srv/mods" "$srv/script-output" \
  "$srv/.incoming" "$agent/releases" "$agent/state" "$agent/.incoming"

# ---- 6. SELinux, only when it's on: the container's shared label on its two trees, bin_t on Node's bin/.
# fcontext <type> <spec>: a local file-context rule, added (or changed) only when it isn't there yet.
fcontext() {
  local s rest have=''
  while read -r s rest; do [[ $s != "$2" ]] || have=$rest; done < <(semanage fcontext -l -C)
  if [[ -z $have ]]; then semanage fcontext -a -t "$1" "$2"
  elif [[ $have != *":$1:"* ]]; then semanage fcontext -m -t "$1" "$2"; fi
}
if command -v selinuxenabled > /dev/null && selinuxenabled; then
  fcontext container_file_t "$R/opt/factorio(/.*)?"
  fcontext container_file_t "$R/srv/factorio(/.*)?"
  fcontext bin_t "$R/usr/local/lib/orrery/node-v[^/]+/bin(/.*)?"
  restorecon -R "$opt" "$srv" "$agent" "$lib"
fi

# ---- 7. The image: pulled by its full name, pinned by digest. Pulled again only for --refresh-image or a new --image.
img_file=$etc/orrery-agent/image.json
ref_re='^[a-z0-9.-]+\.[a-z]+(:[0-9]+)?/[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*@sha256:[0-9a-f]{64}$'
old_ref='' old_glibc=''
if [[ -f $img_file ]]; then
  { read -r old_ref; read -r old_glibc; } < <("$node" -e '
    const j = JSON.parse(require("fs").readFileSync(0, "utf8"));
    console.log(`${j.image}\n${j.glibc}`);' < "$img_file") || true
  [[ $old_ref =~ $ref_re && $old_glibc =~ ^[0-9]+\.[0-9]+$ ]] || old_ref='' old_glibc=''
fi
want=${image:-${old_ref%@*}}
want=${want:-$DEFAULT_IMAGE}
if [[ -z $old_ref || $refresh == 1 || $want != "${old_ref%@*}" ]]; then
  podman pull "$want" || die "can't pull $want"
  digest=$(podman image inspect --format '{{.Digest}}' "$want")
  [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || die "can't read the digest of $want: $digest"
  ref=$want@$digest
  out=$(podman run --rm --network=none "$ref" sh -c 'rpm -q --qf "%{VERSION}" glibc 2>/dev/null || dpkg-query -W -f="\${Version}" libc6') ||
    die "can't read the glibc version in $want: $out"
  [[ $out =~ ^([0-9]+\.[0-9]+) ]] || die "can't read the glibc version in $want: $out"
  glibc=${BASH_REMATCH[1]}
else
  ref=$old_ref glibc=$old_glibc
  podman image exists "$ref" || podman pull "$ref" || die "the pinned image $ref is gone and can't be pulled again"
fi

# ---- 8. Factorio: the installed release is kept unless --factorio names another; else the newest stable headless.
cur_ver=''
if [[ $(readlink "$opt/current" 2> /dev/null) =~ ^releases/([0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  [[ ! -d $opt/releases/${BASH_REMATCH[1]} ]] || cur_ver=${BASH_REMATCH[1]}
fi
ver=${factorio:-$cur_ver}
if [[ -z $ver ]]; then
  ver=$(fetch_text https://factorio.com/api/latest-releases | "$node" -e '
    process.stdout.write(String(JSON.parse(require("fs").readFileSync(0, "utf8")).stable?.headless ?? ""));')
  [[ $ver =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "factorio.com/api/latest-releases names no stable headless version: $ver"
fi
if [[ ! -d $opt/releases/$ver ]]; then
  name=factorio-headless_linux-arm64_$ver.tar.xz
  sums=$(fetch_text https://www.factorio.com/download/sha256sums/)
  want_sha=''
  while read -r h f; do [[ $f != "$name" ]] || want_sha=$h; done <<< "$sums"
  [[ $want_sha =~ ^[0-9a-f]{64}$ ]] || die "factorio.com/download/sha256sums/ lists no $name"
  t=$(ffetch "https://www.factorio.com/get-download/$ver/headless/linux-arm64" "$opt/.incoming" "$name")
  [[ $(fsha "$t") == "$want_sha" ]] || { as_factorio rm -f -- "$t"; die "the download of $name doesn't match factorio.com's sha256"; }
  x=$opt/.incoming/$ver
  as_factorio rm -rf -- "$x"
  as_factorio mkdir -- "$x"
  as_factorio tar -xJf "$t" --strip-components=1 -C "$x"
  as_factorio rm -f -- "$t"
  as_factorio mv -T -- "$x" "$opt/releases/$ver"
  echo "installed Factorio $ver in ${opt#"$R"}/releases/$ver"
fi
# The image must run this Factorio: its glibc is the reason for the container. Checked on the release itself, before
# current points at it, so a release that can't run never becomes the one the server starts.
hardened=(--rm --network=none --user "$uid:$gid" --cap-drop=all --security-opt=no-new-privileges --read-only)
out=$(podman run "${hardened[@]}" -v "$opt:/opt/factorio:ro,z" "$ref" "/opt/factorio/releases/$ver/bin/arm64/factorio" --version 2>&1) || {
  [[ $out != *GLIBC_* ]] || die "Factorio $ver can't run in ${ref%@*}, whose glibc is too old: $out
Run this again with --image $FALLBACK_IMAGE"
  die "Factorio $ver --version failed in ${ref%@*}: $out"
}
[[ $out == *"Version: $ver "* ]] || die "Factorio --version in ${ref%@*} didn't say $ver: $out"
old_factorio=$(readlink "$opt/current" 2> /dev/null) || old_factorio=''
flip "$opt" "releases/$ver"
[[ -d $etc/orrery-agent ]] || install -d -m 755 "$etc/orrery-agent"
put "$img_file" 644 <<< "{ \"image\": \"$ref\", \"glibc\": \"$glibc\" }"

# ---- 9. Configuration, kept on a re-run unless still this script's default.
config factorio "$srv/config/config.ini" << 'EOF'
; Written by orrery deploy/setup-agent-host.sh, and kept on a re-run once edited.
[path]
read-data=/opt/factorio/current/data
write-data=/srv/factorio
EOF
# game_password <file>: the game_password in factorio's server-settings.json (read as factorio, never through a link,
# and only through stdin), or nothing.
game_password() {
  [[ ! -L $1 ]] || return 0
  as_factorio cat -- "$1" 2> /dev/null | "$node" -e '
    try {
      const p = JSON.parse(require("fs").readFileSync(0, "utf8")).game_password;
      if (typeof p === "string") process.stdout.write(p);
    } catch {}' || true
}
# The game password: the one the file holds, when it is of this script's kind (so a re-run never changes it), else a new
# random one, which reaches the file only when the file is missing or still the previous default.
settings=$srv/config/server-settings.json
game_pw=$(game_password "$settings")
if ! [[ $game_pw =~ ^[A-Za-z0-9]{20,}$ ]]; then
  game_pw=$(LC_ALL=C tr -dc A-Za-z0-9 < <(head -c 4096 /dev/urandom))
  game_pw=${game_pw:0:20}
  ((${#game_pw} == 20)) || die "can't make a game password"
fi
config factorio "$settings" << EOF
{
  "_comment": "Written by orrery deploy/setup-agent-host.sh, and kept on a re-run once edited. A private server: not listed, joined with its game_password (random, kept on a re-run); no factorio.com username, password or token.",
  "game_password": "$game_pw",
  "visibility": { "public": false, "lan": false },
  "require_user_verification": true,
  "auto_pause": true,
  "autosave_interval": 10,
  "autosave_slots": 5,
  "non_blocking_saving": false,
  "allow_commands": "admins-only"
}
EOF
game_pw=$(game_password "$settings") # the one the server uses: a file edited by hand may hold another, or none
list=''
IFS=, read -ra names <<< "$admins"
for n in "${names[@]}"; do list+="${list:+, }\"$n\""; done
config factorio "$srv/config/server-adminlist.json" <<< "[$list]"
config factorio "$srv/mods/mod-list.json" << 'EOF'
{
  "mods": [
    { "name": "base", "enabled": true },
    { "name": "space-age", "enabled": true },
    { "name": "quality", "enabled": true },
    { "name": "elevated-rails", "enabled": true },
    { "name": "recycler", "enabled": true },
    { "name": "orrery", "enabled": true }
  ]
}
EOF

# ---- 10. The orrery mod, when mods/ has none; later versions go in by hand until Game updates exist (release 2).
# GitHub's release list, all parts together, newest first and 100 a page: read page by page until it holds a release of
# each part this run needs (the agent's, and the mod's when mods/ has none) or ends; at most 20 pages, inside GitHub's 60
# requests an hour without a token. Each part's newest is then among them: release.sh tags only above a part's latest.
need=(agent)
compgen -G "$srv/mods/orrery_*.zip" > /dev/null || need+=(factorio)
releases='[]'
for ((page = 1; page <= 20; page++)); do
  more=$(fetch_text "https://api.github.com/repos/$REPO/releases?per_page=100&page=$page")
  # Kept of each release: its tag, draft flag and assets' names and digests. Through stdin only: a page outgrows an argv.
  out=$(printf '%s\x1e%s' "$releases" "$more" | "$node" -e '
    const [had, page] = require("fs").readFileSync(0, "utf8").split("\x1e").map((s) => JSON.parse(s));
    const all = had.concat(page.map((r) => ({
      tag_name: r.tag_name, draft: r.draft, assets: (r.assets ?? []).map((a) => ({ name: a.name, digest: a.digest })),
    })));
    const has = (part) => all.some((r) => !r.draft && new RegExp(`^${part}-v\\d+\\.\\d+\\.\\d+$`).test(r.tag_name));
    console.log(page.length < 100 || process.argv.slice(1).every(has) ? "done" : "more");
    console.log(JSON.stringify(all));' "${need[@]}") || die "GitHub's release list (page $page) isn't a JSON list of releases"
  releases=${out#*$'\n'}
  [[ ${out%%$'\n'*} != done ]] || break
done
newest() { # <part>: the newest <part>-vX.Y.Z release on GitHub (by version, drafts left out)
  "$node" -e '
    const re = new RegExp(`^${process.argv[1]}-v(\\d+)\\.(\\d+)\\.(\\d+)$`);
    const newer = (a, b) => (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) > 0;
    let best;
    for (const r of JSON.parse(require("fs").readFileSync(0, "utf8"))) {
      const m = !r.draft && re.exec(r.tag_name);
      if (!m) continue;
      const v = m.slice(1).map(Number);
      if (!best || newer(v, best.v)) best = { tag: r.tag_name, v };
    }
    if (!best) process.exit(1);
    process.stdout.write(best.tag);' "$1" <<< "$releases"
}
asset_sha() { # <tag> <name>: the sha256 GitHub lists for that release asset
  "$node" -e '
    const [, tag, name] = process.argv;
    const r = JSON.parse(require("fs").readFileSync(0, "utf8")).find((r) => r.tag_name === tag);
    const d = r?.assets?.find((a) => a.name === name)?.digest ?? "";
    if (!/^sha256:[0-9a-f]{64}$/.test(d)) process.exit(1);
    process.stdout.write(d.slice(7));' "$1" "$2" <<< "$releases"
}
if compgen -G "$srv/mods/orrery_*.zip" > /dev/null; then
  echo "kept the orrery mod in /srv/factorio/mods (update it by hand until Game updates exist)"
else
  ftag=$(newest factorio) || die "GitHub has no factorio-v release of the orrery mod yet"
  [[ $ftag =~ ^factorio-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not a factorio-vX.Y.Z tag: $ftag"
  zip=orrery_${ftag#factorio-v}.zip
  zsha=$(asset_sha "$ftag" "$zip") || die "the $ftag release has no $zip with a sha256"
  t=$(ffetch "https://github.com/$REPO/releases/download/$ftag/$zip" "$srv/mods" "$zip")
  [[ $(fsha "$t") == "$zsha" ]] || { as_factorio rm -f -- "$t"; die "the download of $zip doesn't match the sha256 GitHub lists"; }
  as_factorio mv -T -- "$t" "$srv/mods/$zip"
  echo "installed the orrery mod $zip"
fi

# ---- 11. The world, when saves/ has none: --world, or a new one made in a one-off container.
if compgen -G "$srv/saves/*.zip" > /dev/null; then
  [[ -z $world ]] || echo "saves/ has a world already: --world ignored"
elif [[ -n $world ]]; then
  fwrite "$srv/saves/world.zip" < "$world"
  echo "copied $world to /srv/factorio/saves/world.zip"
else
  podman run "${hardened[@]}" -e HOME=/srv/factorio -v "$opt:/opt/factorio:ro,z" -v "$srv:/srv/factorio:z" "$ref" \
    /opt/factorio/current/bin/arm64/factorio --config /srv/factorio/config/config.ini \
    --mod-directory /srv/factorio/mods --create /srv/factorio/saves/world.zip || die "Factorio couldn't create a world"
  echo "created /srv/factorio/saves/world.zip"
fi

# ---- 12. The agent: the newest agent-v release, and this folder's files at the same tag, all downloaded and checked
# (the Quadlet file dry-run too) before anything switches to them. The agent's current flips last, after its units.
atag=$(newest agent) || die "GitHub has no agent-v release yet"
[[ $atag =~ ^agent-v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not an agent-vX.Y.Z tag: $atag"
rel=$agent/releases/$atag
if [[ ! -f $rel/src/index.ts ]]; then
  tgz=orrery-$atag.tar.gz base=https://github.com/$REPO/releases/download/$atag
  sum=$(fetch_text "$base/$tgz.sha256")
  sum=${sum%% *}
  [[ $sum =~ ^[0-9a-f]{64}$ ]] || die "$tgz.sha256 holds no sha256"
  t=$(ffetch "$base/$tgz" "$agent/.incoming" "$tgz")
  [[ $(fsha "$t") == "$sum" ]] || { as_factorio rm -f -- "$t"; die "the download of $tgz doesn't match its .sha256"; }
  x=$agent/.incoming/$atag
  as_factorio rm -rf -- "$x"
  as_factorio mkdir -- "$x"
  as_factorio tar -xzf "$t" -C "$x"
  as_factorio rm -f -- "$t"
  [[ -f $x/src/index.ts ]] || die "$tgz has no src/index.ts"
  as_factorio rm -rf -- "$rel"
  as_factorio mv -T -- "$x" "$rel"
  echo "installed the agent $atag"
fi
dl=$lib/.incoming/deploy
rm -rf "$dl"
install -d -m 700 "$dl"
for f in factorio.container orrery-agent.service orrery-agent-deploy@.service 60-orrery-agent.rules deploy-agent.sh; do
  fetch "https://raw.githubusercontent.com/$REPO/$atag/deploy/$f" "$dl/$f"
  [[ -s $dl/$f ]] && managed "$dl/$f" || die "deploy/$f at $atag has no line \"$MARKER\""
done
# The Quadlet file from its template, dry-run: refused on any error or key this Podman lacks.
filled=$(sed -e "s|^Image=.*|Image=$ref|" -e "s|<uid>|$uid|" -e "s|<gid>|$gid|" -e "s|<arch>|arm64|" "$dl/factorio.container")
[[ -z $memory_max ]] || filled=$(sed "/^TimeoutStopSec=/a MemoryMax=$memory_max" <<< "$filled")
placeholder='<[a-z]+>'
[[ ! $filled =~ $placeholder ]] || die "factorio.container at $atag has a value this script doesn't fill: ${BASH_REMATCH[0]}"
qd=$(mktemp -d "$lib/.incoming/quadlet.XXXXXX")
printf '%s\n' "$filled" > "$qd/factorio.container"
if ! out=$(QUADLET_UNIT_DIRS=$qd "$quadlet_gen" -dryrun 2>&1) || grep -qiE 'unsupported|error' <<< "$out" ||
  ! grep -q '^ExecStart=' <<< "$out"; then
  rm -rf "$qd"
  die "Podman's Quadlet refuses factorio.container: no unit, agent config or secret was written, and the agent's current release is as it was. Its dry run said:
$out"
fi
rm -rf "$qd"

# ---- 13. The agent's config, and the secrets, root-only (mode 600 from the start: umask 077). Both secrets are kept on
# a re-run.
config root "$etc/orrery-agent/config.json" << EOF
{
  "id": "$agent_id",
  "hub": { "host": "$hub_host", "port": $hub_port },
  "server": {
    "id": "factorio", "unit": "factorio.service",
    "install": "/opt/factorio", "data": "/srv/factorio",
    "rconPort": 27015, "factorioUdpPort": 34198, "agentUdpPort": 34199
  },
  "mounts": ["/"]
}
EOF
if ((token_new)); then
  put "$etc/orrery-agent.env" 600 < <(
    echo "ORRERY_AGENT_TOKEN=$token"
    if [[ -f $etc/orrery-agent.env ]]; then grep -v '^ORRERY_AGENT_TOKEN=' "$etc/orrery-agent.env" || true; fi
  )
fi
rcon=$(env_value "$etc/orrery-factorio.env" RCON_PASSWORD)
if ! [[ $rcon =~ ^[A-Za-z0-9]{32}$ ]]; then
  rcon=$(LC_ALL=C tr -dc A-Za-z0-9 < <(head -c 4096 /dev/urandom))
  rcon=${rcon:0:32}
  ((${#rcon} == 32)) || die "can't make an RCON password"
  put "$etc/orrery-factorio.env" 600 <<< "RCON_PASSWORD=$rcon"
fi

# ---- 14. Units: the Quadlet file checked above, and this tag's units.
for d in "$etc/containers/systemd" "$etc/systemd/system" "$etc/polkit-1/rules.d"; do [[ -d $d ]] || install -d -m 755 "$d"; done
active=0
systemctl is-active --quiet factorio.service && active=1
changed=0
put_managed "$quadlet" 644 <<< "$filled"
quadlet_changed=$changed
put_managed "$etc/systemd/system/orrery-agent.service" 644 < "$dl/orrery-agent.service"
put_managed "$etc/systemd/system/orrery-agent-deploy@.service" 644 < "$dl/orrery-agent-deploy@.service"
put_managed "$lib/deploy-agent.sh" 755 < "$dl/deploy-agent.sh"
put_managed "$lib/setup-agent-host.sh" 755 < "${BASH_SOURCE[0]}"

# ---- 15. polkit: factorio may run its own two units and its deploys, nothing else. Then the agent's current release,
# once its config and units are in place: a run stopped in the checks above leaves the agent as it was.
put_managed "$etc/polkit-1/rules.d/60-orrery-agent.rules" 644 < "$dl/60-orrery-agent.rules"
rm -rf "$dl"
flip "$agent" "releases/$atag"
# The image the last run pinned, once nothing uses it: by its exact id, never forced (Podman refuses while a container
# uses it, the server's own included, or while it has other names).
if [[ -n $old_ref && $old_ref != "$ref" ]]; then
  old_id=$(podman image inspect --format '{{.Id}}' "$old_ref" 2> /dev/null) || old_id=''
  new_id=$(podman image inspect --format '{{.Id}}' "$ref")
  if [[ $old_id =~ ^[0-9a-f]{64}$ && $old_id != "$new_id" ]]; then
    podman image rm "$old_id" || echo "kept the old image $old_id: something still uses it"
  fi
fi

# ---- 16. firewalld, only if it runs: 34197/udp in the default-route interface's zone, permanent and at runtime.
# No reload: it would drop the runtime rules of the friend's other software.
if systemctl is-active --quiet firewalld; then
  iface=''
  read -ra words < <(ip -o route show default) || true
  for i in "${!words[@]}"; do [[ ${words[i]} != dev ]] || iface=${words[i + 1]:-}; done
  [[ $iface =~ ^[A-Za-z0-9_.@-]+$ ]] || die "can't find the default route's interface"
  zone=$(firewall-cmd --get-zone-of-interface="$iface" 2> /dev/null) || zone=$(firewall-cmd --get-default-zone)
  [[ $zone =~ ^[A-Za-z0-9_-]+$ ]] || die "can't find the firewalld zone of $iface"
  firewall-cmd --permanent --zone="$zone" --query-port=34197/udp > /dev/null ||
    firewall-cmd --permanent --zone="$zone" --add-port=34197/udp
  firewall-cmd --zone="$zone" --query-port=34197/udp > /dev/null || firewall-cmd --zone="$zone" --add-port=34197/udp
  echo "firewalld: 34197/udp is open in the zone $zone ($iface)"
else
  echo "firewalld isn't running: nothing to open on the VM itself"
fi
echo "reminder: players reach the server only if the VM's OCI security list (or NSG) has an ingress rule for UDP 34197"

# ---- 17. Start. Quadlet makes factorio.service at daemon-reload, and its [Install] section the boot link.
# A unit that won't start still gets its report: the check below says why.
started=1
systemctl daemon-reload
systemctl start factorio.service || { started=0; echo "warning: factorio.service didn't start (journalctl -u factorio.service)" >&2; }
systemctl enable orrery-agent.service
# restart, not start: a re-run's new agent release or unit applies now.
systemctl restart orrery-agent.service || { started=0; echo "warning: orrery-agent.service didn't start (journalctl -u orrery-agent.service)" >&2; }
if ((active && quadlet_changed)); then
  echo "factorio.service was running: it uses the new factorio.container from its next restart (from the dashboard)"
fi
if ((active)) && [[ $old_factorio != "releases/$ver" ]]; then
  echo "factorio.service was running: it runs Factorio $ver from its next restart (from the dashboard)"
fi

# ---- 18. The first-boot report, by the agent's own check (run as factorio; the secrets go in its environment only).
# HOME as its units set it: runuser sets factorio's own, /srv/factorio, which the container can write, and nothing
# native may read a dotfile from there.
report=$(
  echo "setup-agent-host: agent $agent_id ($atag), Factorio $ver, image $ref (glibc $glibc), $(podman --version)"
  RCON_PASSWORD=$rcon ORRERY_AGENT_TOKEN=$token runuser -u factorio -- env HOME=/srv/orrery-agent "$node" "$agent/current/src/index.ts" check 2>&1
) && ok=1 || ok=0
printf '%s\n' "$report"
# The game password goes in the saved report only: first-boot.txt is factorio's, mode 600 (mktemp's) in its 750 home.
if [[ -n $game_pw ]]; then
  pw_note="game password: $game_pw
share the game password only with the players: anyone who has it and the VM's address can join"
  echo "the game password is in /srv/factorio/first-boot.txt (not shown here): share it only with the players"
else
  pw_note="warning: no game_password found in /srv/factorio/config/server-settings.json (edited by hand): without one, anyone who finds the server can join"
  echo "$pw_note" >&2
fi
fput "$srv/first-boot.txt" <<< "$report
$pw_note"
((ok && started)) || die "the first-boot check found a problem: send /srv/factorio/first-boot.txt to the owner"
echo "done: send /srv/factorio/first-boot.txt to the owner"

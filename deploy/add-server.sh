#!/usr/bin/env bash
# Finishes a Pending server: run as root, from a root-owned copy, the command its dashboard page shows.
#   sudo /usr/local/lib/orrery/add-server.sh <id> <root> --hub-unit <unit>
# Install (again whenever a release changes it): sudo install -D -m 755 -o root -g root -t /usr/local/lib/orrery deploy/add-server.sh
#
# <root> is the Environment's root (the folder holding hub.db and config.json); its owner is the hub's user. The rest
# (name, start script, Mod token) comes from <root>/servers/<id>/.orrery-pending.json, written by the hub, so the token
# stays out of shell history and `ps`. That file is untrusted: only its start script reaches a unit, and only as a plain
# file name in the server's folder. Everything under <root> (reading the pending file, the config merge and its check,
# config.json.bak) runs as the hub user, so root never writes where the hub user could have left a link. In order:
#   1. config.json's merge: the server ({id, name, dir, service}), its token and its systemd link, into
#      .config.json.new, checked with check-config. A failed check stops everything here.
#   2. <id>.service and <id>.socket, like gtnh.service/gtnh.socket (keep them alike), on the server's Java link.
#   3. 60-orrery-<id>.rules: polkit lets the hub user start, stop and restart <id>.service, nothing else.
#   4. With SELinux on: restorecon on the folder and the Java links, and a warning without the gtnh-fifo module.
#   Then config.json is replaced (the old one kept as config.json.bak): last, since the hub takes over a server, and
#   removes its pending file, once config.json has it.
#   5. Enables the socket and service without starting them, and restarts the hub, which takes the server over.
# Safe to run again: it rewrites only what differs (re-enabling and restarting the hub every time), so a second run
# finishes a half-failed first one; after the hub took the server over, a run only enables and restarts.
# SYSTEMD_DIR and POLKIT_DIR exist for the test (deploy/test-add-server.sh).
set -euo pipefail
die() { echo "add-server: $*" >&2; exit 1; }
[[ $# -eq 4 && $3 == --hub-unit ]] || { echo "usage: $0 <id> <root> --hub-unit <unit>" >&2; exit 2; }
id=$1 root=${2%/} hub_unit=$4
systemd_dir=${SYSTEMD_DIR:-/etc/systemd/system} polkit_dir=${POLKIT_DIR:-/etc/polkit-1/rules.d}
umask 077

# Everything that goes into a unit or a rule is checked against a plain charset first.
[[ $id =~ ^[a-z][a-z0-9-]{0,31}$ ]] || die "bad server id: $id"
[[ $root =~ ^/[A-Za-z0-9._/-]+$ && $root != *..* ]] || die "the root must be an absolute plain path: $root"
[[ $hub_unit =~ ^[A-Za-z0-9][A-Za-z0-9:._@-]*\.service$ ]] || die "bad hub unit: $hub_unit"
[[ -d $root && -f $root/config.json ]] || die "no config.json in $root"
user=$(stat -c %U "$root")
[[ $user =~ ^[a-z_][a-z0-9_-]*$ && $user != root ]] || die "the hub user ($user, the owner of $root) must be a plain non-root user"
command -v node > /dev/null || die "no node on PATH"
dir=$root/servers/$id
config=$root/config.json
pending=$dir/.orrery-pending.json
[[ -d $dir && ! -L $dir ]] || die "no folder $dir"

# As the hub user: <root> and everything in it are theirs, so root never writes there (a link they left would point
# root's writes anywhere). Only the start script's name comes back to root, and is checked before it reaches a unit.
as_hub() { runuser -u "$user" -- "$@"; }
new=$root/.config.json.new
if [[ ! -e $pending ]]; then
  # The hub takes a server over (and removes its pending file) once config.json has it, which this script writes only
  # after the units: so the units are there, and only enabling and the hub's restart may be left.
  as_hub node -e '
    const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.exit(c.servers?.some((s) => s.id === process.argv[2] && s.dir === process.argv[3]) ? 0 : 1);' "$config" "$id" "$dir" ||
    die "no $pending: create the server from the dashboard first"
  [[ -f $systemd_dir/$id.service ]] || die "config.json has $id but there is no $id.service, and no pending file to write it from"
  echo "$id is already added (the hub took it over): enabling and restarting only"
else
  # 1. The merged config, beside config.json with its mode; node prints the start script. Paths only on its command line.
  script=$(as_hub node -e '
    const fs = require("fs");
    const [, configPath, pendingPath, out, id, dir] = process.argv;
    const fail = (why) => { console.error(why); process.exit(1); };
    const c = JSON.parse(fs.readFileSync(configPath, "utf8"));
    let p;
    try { p = JSON.parse(fs.readFileSync(pendingPath, "utf8")); } catch { fail("the pending file is not JSON"); }
    for (const k of ["name", "startScript", "token"]) if (typeof p?.[k] !== "string" || !p[k]) fail(`the pending file has no ${k}`);
    if (!c.integrations?.minecraft) fail("config.json has no integrations.minecraft: add it first (the Mod port and its tokens)");
    c.servers ??= [];
    const s = c.servers.find((s) => s.id === id);
    if (s && s.dir !== dir) fail(`config.json has a server "${id}" already, in ${s.dir}`);
    if (s) Object.assign(s, { name: p.name, dir, service: id });
    else c.servers.push({ id, name: p.name, dir, service: id });
    (c.integrations.minecraft.tokens ??= {})[id] = p.token;
    const units = (c.integrations.systemd ??= []);
    const u = units.find((u) => u.id === id);
    if (u) u.unit = `${id}.service`;
    else units.push({ id, unit: `${id}.service` });
    fs.rmSync(out, { force: true });
    fs.writeFileSync(out, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(out, fs.statSync(configPath).mode & 0o777);
    process.stdout.write(p.startScript);' "$config" "$pending" "$new" "$id" "$dir") || die "refused: nothing changed"
  as_hub node "$root/current/hub/src/check-config.ts" "$new" || { as_hub rm -f "$new"; die "the merged config failed its check: nothing changed"; }
  [[ $script =~ ^[A-Za-z0-9._-]+\.sh$ && -f $dir/$script && ! -L $dir/$script ]] ||
    { as_hub rm -f "$new"; die "the start script must be a plain .sh file in $dir: $script"; }
fi

# put <file> <mode>: stdin into <file>, only when it differs.
put() {
  local new
  new=$(cat)
  if [[ -f $1 && $(< "$1") == "$new" ]]; then return; fi
  printf '%s\n' "$new" > "$1.new"
  chmod "$2" "$1.new"
  mv -T "$1.new" "$1"
  echo "wrote $1"
}

if [[ -n ${script:-} ]]; then
# 2. The units, as gtnh.service and gtnh.socket (their comments explain each line).
put "$systemd_dir/$id.service" 644 << EOF
# orrery server $id: written by deploy/add-server.sh, like deploy/gtnh.service (see its comments). Console:
# echo "<command>" > /run/$id.stdin (as $user); journalctl -u $id -f. Java: the link $root/java/$id.
[Unit]
Description=orrery server $id
After=network-online.target $hub_unit $id.socket
Wants=network-online.target
Requires=$id.socket

[Service]
User=$user
WorkingDirectory=$dir
Environment=PATH=$root/java/$id/bin:/usr/local/bin:/usr/bin:/bin
Environment=JAVA_HOME=$root/java/$id
ExecStart=/bin/bash ./$script
StandardInput=socket
StandardOutput=journal
StandardError=journal
ExecStop=/bin/sh -c '[ -n "\$MAINPID" ] && kill -0 "\$MAINPID" 2>/dev/null || exit 0; echo stop > /run/$id.stdin; while kill -0 \$MAINPID 2>/dev/null; do sleep 2; done'
TimeoutStopSec=600
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
put "$systemd_dir/$id.socket" 644 << EOF
# Console input for orrery server $id: written by deploy/add-server.sh, like deploy/gtnh.socket (see its comments).
[Unit]
Description=orrery server $id console input

[Socket]
ListenFIFO=/run/$id.stdin
SocketUser=$user
SocketMode=0600
RemoveOnStop=true

[Install]
WantedBy=sockets.target
EOF

# 3. polkit: this unit only, for the hub user only. Separate from orrery-hub.rules' UNITS.
put "$polkit_dir/60-orrery-$id.rules" 644 << EOF
// Written by deploy/add-server.sh: the orrery hub's user ($user) may start, stop and restart $id.service, nothing else.
polkit.addRule(function (action, subject) {
  if (
    action.id === 'org.freedesktop.systemd1.manage-units' &&
    subject.user === '$user' &&
    action.lookup('unit') === '$id.service' &&
    ['start', 'stop', 'restart'].indexOf(action.lookup('verb')) >= 0
  ) {
    return polkit.Result.YES;
  }
});
EOF

# 4. SELinux, only when it's on.
if command -v selinuxenabled > /dev/null && selinuxenabled; then
  restorecon -R "$dir" "$root/java"
  semodule -l | grep -q '^gtnh-fifo\b' || echo "warning: no gtnh-fifo SELinux module: $id.socket may fail (see deploy/gtnh-fifo.te)" >&2
fi

# The config last: once it has the server, the hub's next start takes it over and removes the pending file.
if as_hub cmp -s "$new" "$config"; then
  as_hub rm -f "$new"
  echo "config.json has $id already"
else
  as_hub cp -p --remove-destination "$config" "$config.bak"
  as_hub mv -T "$new" "$config"
  echo "config.json: added $id (the old one is config.json.bak)"
fi
fi

# 5. Enabled, not started; the restarted hub takes the server over.
systemctl daemon-reload
systemctl enable "$id.socket" "$id.service"
systemctl restart "$hub_unit"
echo "added $id: start it from the dashboard"

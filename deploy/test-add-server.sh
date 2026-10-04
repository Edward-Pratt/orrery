#!/usr/bin/env bash
# Tests add-server.sh against a temp root, with fake systemctl, runuser, selinuxenabled, restorecon and semodule.
# The config check is real: runuser runs this repo's check-config (through <root>/current) as whoever runs the test.
#   bash deploy/test-add-server.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
R=$T/root F=$T/fake
export F PATH=$T/bin:$PATH SYSTEMD_DIR=$T/systemd POLKIT_DIR=$T/polkit LC_ALL=C
mkdir -p "$T/bin" "$F" "$SYSTEMD_DIR" "$POLKIT_DIR"
ME=$(id -un)

# Each fake notes its call in $F/calls. runuser -u <user> -- <cmd…>: runs it, unless $F/check-fails exists.
cat > "$T/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$F/calls"
EOF
cat > "$T/bin/runuser" <<'EOF'
#!/usr/bin/env bash
echo "runuser $1 $2" >> "$F/calls"
[[ ! -e $F/check-fails ]] || { echo "fake: the config is bad" >&2; exit 1; }
shift 3
exec "$@"
EOF
cat > "$T/bin/selinuxenabled" <<'EOF'
#!/usr/bin/env bash
[[ -e $F/selinux ]]
EOF
cat > "$T/bin/restorecon" <<'EOF'
#!/usr/bin/env bash
echo "restorecon $*" >> "$F/calls"
EOF
cat > "$T/bin/semodule" <<'EOF'
#!/usr/bin/env bash
echo "semodule $*" >> "$F/calls"
echo "gtnh-fifo"
EOF
chmod +x "$T/bin/"*

TOKEN=0123456789abcdef0123456789abcdef NEW_TOKEN=fedcba9876543210fedcba9876543210
# A root like production's: config.json, current -> this repo, one server (gtnh) and a Pending one (new-1).
fresh() {
  rm -rf "$R" "${SYSTEMD_DIR:?}"/* "${POLKIT_DIR:?}"/* "$F/calls" "$F/check-fails" "$F/selinux"
  mkdir -p "$R/servers/gtnh" "$R/servers/new-1" "$R/java"
  ln -s "$(dirname "$HERE")" "$R/current"
  cat > "$R/config.json" <<EOF
{
  "dbPath": "$R/hub.db",
  "servers": [{ "id": "gtnh", "name": "GTNH", "dir": "$R/servers/gtnh", "service": "gtnh" }],
  "integrations": {
    "minecraft": { "listenPort": 25580, "tokens": { "gtnh": "$TOKEN" } },
    "systemd": [{ "id": "gtnh", "unit": "gtnh.service" }]
  }
}
EOF
  chmod 640 "$R/config.json"
  pending '{ "name": "New One", "startScript": "startserver-java9.sh", "token": "'$NEW_TOKEN'" }'
  touch "$R/servers/new-1/startserver-java9.sh"
}
pending() { printf '%s\n' "$1" > "$R/servers/new-1/.orrery-pending.json"; }
add() { local r=0; bash "$HERE/add-server.sh" "$@" > "$T/out" 2>&1 || r=$?; return $r; }
# Everything the script writes, for comparing two runs.
written() { cat "$R/config.json" "$SYSTEMD_DIR"/* "$POLKIT_DIR"/*; stat -c '%a %U %n' "$R/config.json"; }
fail=0
check() {
  if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; sed 's/^/     /' "$T/out"; fail=1; fi
}

fresh
cp "$R/config.json" "$T/before.json"
check 'adds a Pending server' 'add new-1 "$R" --hub-unit orrery-hub.service'
check 'merges the server, its token and its service link into config.json, keeping the rest' 'node -e "
  const c = JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\")), [, , root, token, newToken] = process.argv;
  const want = { servers: [{ id: \"gtnh\", name: \"GTNH\", dir: root + \"/servers/gtnh\", service: \"gtnh\" }, { id: \"new-1\", name: \"New One\", dir: root + \"/servers/new-1\", service: \"new-1\" }],
    tokens: { gtnh: token, \"new-1\": newToken }, systemd: [{ id: \"gtnh\", unit: \"gtnh.service\" }, { id: \"new-1\", unit: \"new-1.service\" }] };
  const got = { servers: c.servers, tokens: c.integrations.minecraft.tokens, systemd: c.integrations.systemd };
  process.exit(JSON.stringify(got) === JSON.stringify(want) && c.integrations.minecraft.listenPort === 25580 ? 0 : 1);" "$R/config.json" "$R" "$TOKEN" "$NEW_TOKEN"'
check 'keeps config.json.bak, and config.json its owner and mode' 'cmp -s "$R/config.json.bak" "$T/before.json" && [[ $(stat -c "%a %U" "$R/config.json") == "640 $ME" ]]'
check 'checks the config as the hub user' 'grep -qx "runuser -u $ME" "$F/calls"'
check 'writes the unit: FIFO console, the hub user, the Java link on PATH' '
  grep -qx "User=$ME" "$SYSTEMD_DIR/new-1.service" &&
  grep -qx "WorkingDirectory=$R/servers/new-1" "$SYSTEMD_DIR/new-1.service" &&
  grep -qx "Environment=PATH=$R/java/new-1/bin:/usr/local/bin:/usr/bin:/bin" "$SYSTEMD_DIR/new-1.service" &&
  grep -qx "Environment=JAVA_HOME=$R/java/new-1" "$SYSTEMD_DIR/new-1.service" &&
  grep -qx "ExecStart=/bin/bash ./startserver-java9.sh" "$SYSTEMD_DIR/new-1.service" &&
  grep -qx "StandardInput=socket" "$SYSTEMD_DIR/new-1.service" &&
  grep -qx "Requires=new-1.socket" "$SYSTEMD_DIR/new-1.service" &&
  grep -qx "After=network-online.target orrery-hub.service new-1.socket" "$SYSTEMD_DIR/new-1.service" &&
  grep -qF "echo stop > /run/new-1.stdin; while kill -0 \$MAINPID" "$SYSTEMD_DIR/new-1.service" &&
  ! grep -q "New One" "$SYSTEMD_DIR/new-1.service"'
check 'writes the socket' 'grep -qx "ListenFIFO=/run/new-1.stdin" "$SYSTEMD_DIR/new-1.socket" && grep -qx "SocketUser=$ME" "$SYSTEMD_DIR/new-1.socket" &&
  grep -qx "SocketMode=0600" "$SYSTEMD_DIR/new-1.socket"'
check 'writes one polkit file allowing the hub user start, stop and restart of that unit only' '
  ls "$POLKIT_DIR" | grep -qx 60-orrery-new-1.rules &&
  grep -qF "subject.user === '\''$ME'\''" "$POLKIT_DIR/60-orrery-new-1.rules" &&
  grep -qF "action.lookup('\''unit'\'') === '\''new-1.service'\''" "$POLKIT_DIR/60-orrery-new-1.rules" &&
  grep -qF "['\''start'\'', '\''stop'\'', '\''restart'\'']" "$POLKIT_DIR/60-orrery-new-1.rules"'
check 'enables the units without starting them, then restarts the hub; no SELinux steps with it off' '[[ $(cat "$F/calls") == "runuser -u $ME
systemctl daemon-reload
systemctl enable new-1.socket new-1.service
systemctl restart orrery-hub.service" ]]'
written > "$T/first"
: > "$F/calls"
check 'a second run changes nothing' 'add new-1 "$R" --hub-unit orrery-hub.service && written | cmp -s - "$T/first"'
check 'a second run finishes the job: enables and restarts again' 'grep -qx "systemctl restart orrery-hub.service" "$F/calls"'
# The hub, restarted, takes the server over and removes the pending file.
rm "$R/servers/new-1/.orrery-pending.json"
check 'a run after the hub took the server over says so and changes nothing' 'add new-1 "$R" --hub-unit orrery-hub.service && grep -q "already" "$T/out" && written | cmp -s - "$T/first"'

# A half-failed first run (the units' folder unwritable) is finished by the second.
fresh
chmod 555 "$SYSTEMD_DIR"
check 'a run that fails writing the units stops there' '! add new-1 "$R" --hub-unit orrery-hub.service && ! grep -q restart "$F/calls"'
chmod 755 "$SYSTEMD_DIR"
check 'the next run finishes it' 'add new-1 "$R" --hub-unit orrery-hub.service && written | cmp -s - "$T/first"'

fresh
touch "$F/selinux"
check 'with SELinux on, relabels the folder and the Java links, and checks the FIFO module' 'add new-1 "$R" --hub-unit orrery-hub.service &&
  grep -qx "restorecon -R $R/servers/new-1 $R/java" "$F/calls" && grep -qx "semodule -l" "$F/calls"'

# Refusals: nothing written, nothing restarted.
untouched() { cmp -s "$R/config.json" "$T/before.json" && [[ ! -e $R/config.json.bak && -z $(find "$SYSTEMD_DIR" "$POLKIT_DIR" -mindepth 1) ]] && ! grep -qs systemctl "$F/calls"; }
refuses() { # <what> <setup> [args…]: refused with nothing changed
  local what=$1 setup=$2; shift 2
  ARGS=("$@")
  fresh; cp "$R/config.json" "$T/before.json"; eval "$setup"
  check "refuses $what" '! add "${ARGS[@]}" && untouched'
}
refuses 'a bad id' '' 'New-1' "$R" --hub-unit orrery-hub.service
refuses 'an id with a slash' '' '../gtnh' "$R" --hub-unit orrery-hub.service
refuses 'a bad hub unit' '' new-1 "$R" --hub-unit 'orrery-hub.service;x'
refuses 'missing arguments' '' new-1 "$R"
refuses 'a relative root' 'cd "$T"' new-1 root --hub-unit orrery-hub.service
refuses 'a start script with a path' 'pending "{ \"name\": \"x\", \"startScript\": \"../gtnh/start.sh\", \"token\": \"$NEW_TOKEN\" }"' new-1 "$R" --hub-unit orrery-hub.service
refuses 'a start script with a newline' 'pending "{ \"name\": \"x\", \"startScript\": \"a.sh\\nExecStartPre=/bin/evil\", \"token\": \"$NEW_TOKEN\" }"' new-1 "$R" --hub-unit orrery-hub.service
refuses 'a start script that is not in the folder' 'pending "{ \"name\": \"x\", \"startScript\": \"other.sh\", \"token\": \"$NEW_TOKEN\" }"' new-1 "$R" --hub-unit orrery-hub.service
refuses 'a start script that is a symlink' 'rm "$R/servers/new-1/startserver-java9.sh"; ln -s /bin/sh "$R/servers/new-1/startserver-java9.sh"' new-1 "$R" --hub-unit orrery-hub.service
refuses 'a pending file that is not JSON' 'pending "not json"' new-1 "$R" --hub-unit orrery-hub.service
refuses 'a pending file with no token' 'pending "{ \"name\": \"x\", \"startScript\": \"startserver-java9.sh\" }"' new-1 "$R" --hub-unit orrery-hub.service
refuses 'a server with no pending file' 'rm "$R/servers/new-1/.orrery-pending.json"' new-1 "$R" --hub-unit orrery-hub.service
refuses 'an id config has with another dir' 'node -e "const f = process.argv[1], c = JSON.parse(require(\"fs\").readFileSync(f));
  c.servers.push({ id: \"new-1\", name: \"x\", dir: process.argv[2] }); require(\"fs\").writeFileSync(f, JSON.stringify(c))" "$R/config.json" "$R/servers/gtnh";
  cp "$R/config.json" "$T/before.json"' new-1 "$R" --hub-unit orrery-hub.service
refuses 'a config with no integrations.minecraft' 'node -e "const f = process.argv[1], c = JSON.parse(require(\"fs\").readFileSync(f)); delete c.integrations.minecraft;
  require(\"fs\").writeFileSync(f, JSON.stringify(c))" "$R/config.json"; cp "$R/config.json" "$T/before.json"' new-1 "$R" --hub-unit orrery-hub.service
refuses 'a config that fails the check' 'touch "$F/check-fails"' new-1 "$R" --hub-unit orrery-hub.service
check 'leaves no temp file behind after a failed check' '[[ -z $(find "$R" -maxdepth 1 -name ".config.json.*") ]]'
refuses 'a real failed check (a token too short)' 'pending "{ \"name\": \"x\", \"startScript\": \"startserver-java9.sh\", \"token\": \"short\" }"' new-1 "$R" --hub-unit orrery-hub.service
check 'shows why the check failed' 'grep -q "token" "$T/out"'

exit $fail

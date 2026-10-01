#!/usr/bin/env bash
# Tests deploy-hub.sh and deploy-web.sh against a throwaway git repo as the remote, with fake systemctl, npm, id and gh.
#   bash deploy/test-deploy.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
R=$T/root F=$T/fake
export F R PATH=$T/bin:$PATH ORRERY_REPO=file://$T/remote DEPLOY_GATE_SECONDS=1 DEPLOY_GATE_POLL=0.2
export GITHUB_TOKEN=s3cret-t0ken LC_ALL=C
mkdir -p "$T/bin" "$F" "$R/releases"

# systemctl: `restart` records which release current points at, and an earlier deploy's status file still there for
# the restarted hub to misread; `show` prints the first line of $F/pids as the hub's
# MainPID (active/running), or a dead hub for `dead`, and drops that line unless it's the last.
cat > "$T/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
case $1 in
  restart) echo "restart $2 $(readlink "$R/current")$([[ -e $R/deploy-status.json ]] && echo ' with an old status')" >> "$F/calls" ;;
  show)
    p=$(head -1 "$F/pids")
    if [[ $(wc -l < "$F/pids") -gt 1 ]]; then sed -i 1d "$F/pids"; fi
    if [[ $p == dead ]]; then printf 'ActiveState=failed\nSubState=failed\nMainPID=0\n'
    else printf 'ActiveState=active\nSubState=running\nMainPID=%s\n' "$p"; fi ;;
esac
EOF
cat > "$T/bin/npm" <<'EOF'
#!/usr/bin/env bash
[[ $* == 'ci --omit=dev' && ! -e $F/npm-fails ]] || { echo "npm ERR! fake failure"; exit 1; }
mkdir node_modules
EOF
cat > "$T/bin/id" <<'EOF'
#!/usr/bin/env bash
echo "${FAKE_UID:-1000}"
EOF
# gh release download <tag> --repo <r> --pattern <p> --dir <d>: copies the fixture build, noting the token it got.
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$GH_TOKEN" > "$F/gh-token"
if [[ -e $R/deploy-status.json ]]; then touch "$F/gh-saw-old-status"; fi
cp "$F/web.tar.gz" "$9/$7"
EOF
chmod +x "$T/bin/"*

# The remote: hub-v1.0.0 to hub-v1.0.4, each a commit with hub/package.json and deploy/.
git init -q "$T/remote"
for v in 0 1 2 3 4; do
  mkdir -p "$T/remote/hub" "$T/remote/deploy"
  echo "{\"version\":\"1.0.$v\"}" > "$T/remote/hub/package.json"; echo x > "$T/remote/deploy/readme"
  git -C "$T/remote" add -A
  git -C "$T/remote" -c user.name=t -c user.email=t@t commit -qm "v$v"
  git -C "$T/remote" tag "hub-v1.0.$v"
done
# The running release, older than anything a deploy clones.
git clone -q --depth 1 --branch hub-v1.0.0 "$ORRERY_REPO" "$R/releases/hub-v1.0.0" 2> /dev/null
touch -d 2020-01-01 "$R/releases/hub-v1.0.0"
ln -s releases/hub-v1.0.0 "$R/current"

# Every run's output is also kept in $T/all, for the token check at the end.
deploy() { local r=0; bash "$HERE/deploy-hub.sh" "$R" orrery-hub.service "$@" > "$T/out" 2>&1 || r=$?; cat "$T/out" >> "$T/all"; return $r; }
pids() { printf '%s\n' "$@" > "$F/pids"; : > "$F/calls"; }
current() { [[ $(readlink "$R/current") == "releases/$1" ]]; }
releases() { [[ $(ls "$R/releases" | tr '\n' ' ') == "$* " ]]; }
status() { # <tag> <from> <outcome>: the status file has exactly these, an ISO finish time and a log string
  node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const [, , t, f, o] = process.argv;
    const keys = "tag,from,outcome,finished,log";
    process.exit(Object.keys(s).join() === keys && s.tag === t && s.from === f && s.outcome === o &&
      new Date(s.finished).toISOString() === s.finished && typeof s.log === "string" ? 0 : 1);' \
    "$R/deploy-status.json" "$@"
}
fail=0
check() {
  if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; sed 's/^/     /' "$T/out"; fail=1; fi
}

pids 100
check 'refuses a bad tag' '! deploy hub-v1.0 && ! deploy "hub-v1.0.1;x" && ! deploy web-v1.0.1 && current hub-v1.0.0 &&
  [[ ! -e $R/deploy-status.json && ! -s $F/calls ]]'
check 'refuses to run as root' '! FAKE_UID=0 deploy hub-v1.0.1 && grep -q root "$T/out" && current hub-v1.0.0 &&
  [[ ! -e $R/releases/hub-v1.0.1 && ! -e $R/deploy-status.json ]]'
check 'refuses while another deploy holds the lock' '! flock "$R/deploy.lock" bash "$HERE/deploy-hub.sh" "$R" orrery-hub.service hub-v1.0.1 > "$T/out" 2>&1 &&
  grep -q deploy.lock "$T/out" && current hub-v1.0.0 && [[ ! -e $R/releases/hub-v1.0.1 && ! -e $R/deploy-status.json ]]'
touch "$F/npm-fails"
check 'a failed npm ci leaves current and no release directory' '! deploy hub-v1.0.1 && current hub-v1.0.0 &&
  [[ ! -e $R/releases/hub-v1.0.1 && ! -s $F/calls ]] && status hub-v1.0.1 hub-v1.0.0 failed'
rm "$F/npm-fails"
check 'refuses a tag the remote does not have' '! deploy hub-v9.9.9 && current hub-v1.0.0 && [[ ! -e $R/releases/hub-v9.9.9 ]]'

pids 100 101 200
check 'a changing MainPID flips back, restarts the old release and writes rolled back' '! deploy hub-v1.0.1 &&
  current hub-v1.0.0 && status hub-v1.0.1 hub-v1.0.0 "rolled back" &&
  [[ $(cat "$F/calls") == "$(printf "restart orrery-hub.service releases/%s\n" hub-v1.0.1 hub-v1.0.0)" ]]'
pids 100 101 dead
check 'an old release that does not come up either writes failed and stays' '! deploy hub-v1.0.2 &&
  current hub-v1.0.0 && status hub-v1.0.2 hub-v1.0.0 failed && grep -q "leaving it in place" "$T/out"'
pids dead 200
check 'a new hub that never starts rolls back' '! deploy hub-v1.0.3 && current hub-v1.0.0 && status hub-v1.0.3 hub-v1.0.0 "rolled back"'
check 'pruning keeps whatever current points at besides the three newest' 'releases hub-v1.0.0 hub-v1.0.1 hub-v1.0.2 hub-v1.0.3'
pids 300
check 'a hub that stays up flips current and writes ok' 'deploy hub-v1.0.4 && current hub-v1.0.4 && status hub-v1.0.4 hub-v1.0.0 ok &&
  [[ -d $R/releases/hub-v1.0.4/hub/node_modules && $(cat "$F/calls") == "restart orrery-hub.service releases/hub-v1.0.4" ]]'
check 'prunes releases to the three newest' 'releases hub-v1.0.2 hub-v1.0.3 hub-v1.0.4'
check 'leaves no temporary links or files in the root' '[[ $(ls -A "$R" | tr "\n" " ") == "current deploy-status.json deploy.lock releases " ]]'
pids 400
check 'redeploys a release still on disk from a fresh clone' 'echo junk > "$R/releases/hub-v1.0.2/junk" && deploy hub-v1.0.2 &&
  current hub-v1.0.2 && status hub-v1.0.2 hub-v1.0.4 ok && [[ ! -e $R/releases/hub-v1.0.2/junk ]]'
check 'refuses the release already running' '! deploy hub-v1.0.2 && current hub-v1.0.2'
check 'the status log is the excerpt of what happened' 'node -e "process.exit(JSON.parse(require(\"fs\").readFileSync(\"$R/deploy-status.json\")).log.includes(\"current -> releases/hub-v1.0.2\") ? 0 : 1)"'

# The dashboard: deploy-web.sh runs install-web.sh from its own directory, fetching through the fake gh.
W=$T/www/orrery
mkdir -p "$T/build" "$T/www"
echo v1 > "$T/build/index.html"
tar -czf "$F/web.tar.gz" -C "$T/build" .
web() { local r=0; bash "$HERE/deploy-web.sh" "$R" "$W" "$@" > "$T/out" 2>&1 || r=$?; cat "$T/out" >> "$T/all"; return $r; }
rm -f "$R/deploy-status.json"
check 'the web wrapper refuses a bad tag' '! web hub-v1.0.0 && ! web "web-v1.0.0 x" && [[ ! -e $W && ! -e $R/deploy-status.json ]]'
check 'the web wrapper installs into the given directory and writes the stamp and status' 'web web-v1.0.0 &&
  [[ $(cat "$W/index.html") == v1 && $(cat "$W.release") == web-v1.0.0 && $(cat "$F/gh-token") == "$GITHUB_TOKEN" ]] &&
  status web-v1.0.0 "" ok && [[ $(stat -c %a "$R/deploy-status.json") == 644 ]]'
check 'the web status names the release it replaced, the old status gone while it ran' 'web web-v1.0.1 &&
  status web-v1.0.1 web-v1.0.0 ok && [[ ! -e $F/gh-saw-old-status ]]'
echo junk > "$T/build/readme"; rm "$T/build/index.html"; tar -czf "$F/web.tar.gz" -C "$T/build" .
check 'a failed web install writes failed and keeps the build' '! web web-v1.0.2 && status web-v1.0.2 web-v1.0.1 failed &&
  [[ $(cat "$W.release") == web-v1.0.1 && $(cat "$W/index.html") == v1 ]]'

check 'the token never appears in a log or a status file' '[[ -s $T/all ]] && ! grep -qF "$GITHUB_TOKEN" "$R/deploy-status.json" "$T/all" &&
  ! grep -qF "$(printf "x-access-token:%s" "$GITHUB_TOKEN" | base64 -w0)" "$R/deploy-status.json" "$T/all"'
exit $fail

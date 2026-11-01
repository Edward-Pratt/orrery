#!/usr/bin/env bash
# Tests deploy-agent.sh with a fake curl serving release fixtures, a fake systemctl whose restart plays the agent
# (writing the connected file, or not), and a fake id.
#   bash deploy/test-deploy-agent.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
R=$T/root F=$T/fake X=$T/releases B=$T/build
export F R X PATH=$T/bin:$PATH DEPLOY_ROOT=$T/root DEPLOY_GATE_SECONDS=2 DEPLOY_GATE_POLL=0.1
export GITHUB_TOKEN=s3cret-t0ken LC_ALL=C
mkdir -p "$T/bin" "$F" "$R/releases" "$X" "$B" "$T/outside"

# curl: serves $X/<tag>/<file> for https://github.com/Edward-Pratt/orrery/releases/download/<tag>/<file>, else a 404.
# It wants -q first and https only, and refuses anything that would send a credential.
cat > "$T/bin/curl" << 'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$F/curl"
[[ $1 == -q && " $* " == *' --proto =https '* ]] || { echo 'fake curl: want -q first and --proto =https' >&2; exit 2; }
out='' url=''
while (($#)); do
  case $1 in
    -o) out=$2; shift 2 ;;
    --proto | --proto-redir | --retry | --connect-timeout | --speed-limit | --speed-time | --max-filesize) shift 2 ;;
    -H | --header | -u | --user | -K | --config | --oauth2-bearer) echo "fake curl: sends a credential: $1" >&2; exit 2 ;;
    https://*) url=$1; shift ;;
    -*) shift ;;
    *) echo "fake curl: what is $1" >&2; exit 2 ;;
  esac
done
prefix=https://github.com/Edward-Pratt/orrery/releases/download/
src=$X/${url#"$prefix"}
[[ $url == "$prefix"* && -f $src ]] || { echo 'curl: (22) The requested URL returned error: 404' >&2; exit 22; }
if [[ -n $out ]]; then cat "$src" > "$out"; else cat "$src"; fi
EOF
# systemctl restart orrery-agent.service: records the release current points at (and an earlier deploy's status file
# still there, for the restarted agent to misreport), then plays the agent as the first line of $F/agent says, dropping
# that line unless it's the last: ok (connected names that release, now), late (the same 0.5 s later), stale (a time
# from before the restart), wrong (another version), none (writes nothing). Anything else fails: polkit lets factorio
# only restart orrery-agent.service.
cat > "$T/bin/systemctl" << 'EOF'
#!/usr/bin/env bash
[[ $# -eq 2 && $1 == restart && $2 == orrery-agent.service ]] || { echo "refused $*" >> "$F/calls"; exit 1; }
v=$(basename "$(readlink "$R/current")")
echo "restart $2 $v$([[ -e $R/deploy-status.json ]] && echo ' with an old status')" >> "$F/calls"
how=$(head -1 "$F/agent")
if [[ $(wc -l < "$F/agent") -gt 1 ]]; then sed -i 1d "$F/agent"; fi
write() { printf '{"version":"%s","time":%s}\n' "$1" "$2" > "$R/.connected.tmp" && mv "$R/.connected.tmp" "$R/connected"; }
case $how in
  ok) write "$v" "$(date +%s%3N)" ;;
  late) (sleep 0.5 && write "$v" "$(date +%s%3N)") > /dev/null 2>&1 & ;;
  stale) write "$v" $(($(date +%s%3N) - 60000)) ;;
  wrong) write agent-v0.0.9 "$(date +%s%3N)" ;;
esac
EOF
cat > "$T/bin/id" << 'EOF'
#!/usr/bin/env bash
echo "${FAKE_UID:-1000}"
EOF
chmod +x "$T/bin/"*

# Releases as release.yml makes them: agent/ tarred from inside, the .sha256 naming the bare file.
publish() { # <tag> [tar options...]: tars $B/<tag> into $X/<tag> with its .sha256
  local t=$1
  shift
  mkdir -p "$X/$t"
  tar -czf "$X/$t/orrery-$t.tar.gz" -C "$B/$t" "$@" .
  (cd "$X/$t" && sha256sum "orrery-$t.tar.gz" > "orrery-$t.tar.gz.sha256")
}
tree() { mkdir -p "$B/$1/src"; echo "// $1" > "$B/$1/src/index.ts"; echo '{"name":"orrery-agent"}' > "$B/$1/package.json"; }
for v in 1 2 3 4 5 6 7; do tree "agent-v1.0.$v"; publish "agent-v1.0.$v"; done
tree agent-v2.0.1; publish agent-v2.0.1; echo '0000000000000000000000000000000000000000000000000000000000000000  orrery-agent-v2.0.1.tar.gz' > "$X/agent-v2.0.1/orrery-agent-v2.0.1.tar.gz.sha256"
tree agent-v2.0.2; publish agent-v2.0.2; echo 'not a sum' > "$X/agent-v2.0.2/orrery-agent-v2.0.2.tar.gz.sha256"
tree agent-v2.0.3; ln -s "$T/outside" "$B/agent-v2.0.3/src/out"; echo pwned > "$B/agent-v2.0.3/pwn"
publish agent-v2.0.3 --transform 's,^\./pwn$,./src/out/pwned,' # a link out, then a file written through it
tree agent-v2.0.4; ln "$B/agent-v2.0.4/src/index.ts" "$B/agent-v2.0.4/src/again.ts"; publish agent-v2.0.4
tree agent-v2.0.5; echo pwned > "$B/agent-v2.0.5/pwn"; publish agent-v2.0.5 --transform 's,^\./pwn$,../../../escaped,'
tree agent-v2.0.6; echo pwned > "$B/agent-v2.0.6/pwn"; publish agent-v2.0.6 -P --transform "s,^\./pwn\$,$T/outside/abs,"
mkdir -p "$B/agent-v2.0.7"; echo '{}' > "$B/agent-v2.0.7/package.json"; publish agent-v2.0.7
mkdir -p "$X/agent-v2.0.8"; echo 'not a tarball' > "$X/agent-v2.0.8/orrery-agent-v2.0.8.tar.gz"
(cd "$X/agent-v2.0.8" && sha256sum orrery-agent-v2.0.8.tar.gz > orrery-agent-v2.0.8.tar.gz.sha256)
mkdir -p "$X/agent-v2.0.9"; cp "$X/agent-v1.0.1/orrery-agent-v1.0.1.tar.gz.sha256" "$X/agent-v2.0.9/orrery-agent-v2.0.9.tar.gz.sha256"
# The running release, as setup installed it, older than anything a deploy unpacks.
tree agent-v1.0.0; cp -R "$B/agent-v1.0.0" "$R/releases/"
touch -d 2020-01-01 "$R/releases/agent-v1.0.0"
ln -s releases/agent-v1.0.0 "$R/current"

# Every run's output is also kept in $T/all, for the token check at the end.
deploy() { local r=0; bash "$HERE/deploy-agent.sh" "$@" > "$T/out" 2>&1 || r=$?; cat "$T/out" >> "$T/all"; return $r; }
agent() { printf '%s\n' "$@" > "$F/agent"; : > "$F/calls"; }
current() { [[ $(readlink "$R/current") == "releases/$1" ]]; }
releases() { [[ $(ls "$R/releases" | tr '\n' ' ') == "$* " ]]; }
restarts() { [[ $(cat "$F/calls") == "$(printf 'restart orrery-agent.service %s\n' "$@")" ]]; }
says() { grep -qF -- "$1" "$T/out"; }
status() { # <tag> <from> <outcome>: the status file has exactly these, an ISO finish time and a log string
  node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const [, , t, f, o] = process.argv;
    const keys = "tag,from,outcome,finished,log";
    process.exit(Object.keys(s).join() === keys && s.tag === t && s.from === f && s.outcome === o &&
      new Date(s.finished).toISOString() === s.finished && typeof s.log === "string" ? 0 : 1);' \
    "$R/deploy-status.json" "$@"
}
# A deploy that failed before any restart: the status says so, and nothing moved or was left behind.
untouched() { # <tag>
  status "$1" agent-v1.0.0 failed && current agent-v1.0.0 && [[ ! -e $R/releases/$1 && ! -s $F/calls ]] &&
    [[ -z $(ls -A "$R/.incoming") ]] && releases agent-v1.0.0
}
fail=0
check() {
  if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; sed 's/^/     /' "$T/out"; fail=1; fi
}

agent ok
check 'refuses a missing or extra argument' '! deploy && ! deploy agent-v1.0.1 x && says usage && current agent-v1.0.0'
check 'refuses a bad tag' '! deploy agent-v1.0 && ! deploy "agent-v1.0.1;x" && ! deploy hub-v1.0.1 &&
  ! deploy agent-v1.0.1/../../x && ! deploy " agent-v1.0.1" && ! deploy "agent-v1.0.1
" && current agent-v1.0.0 && [[ ! -e $R/deploy-status.json && ! -s $F/calls && ! -e $F/curl ]]'
check 'refuses to run as root' '! FAKE_UID=0 deploy agent-v1.0.1 && says root && current agent-v1.0.0 &&
  [[ ! -e $R/releases/agent-v1.0.1 && ! -e $R/deploy-status.json && ! -e $F/curl ]]'
check 'refuses while another deploy holds the lock' '! flock "$R/deploy.lock" bash "$HERE/deploy-agent.sh" agent-v1.0.1 > "$T/out" 2>&1 &&
  says deploy.lock && current agent-v1.0.0 && [[ ! -e $R/releases/agent-v1.0.1 && ! -e $R/deploy-status.json ]]'
check 'refuses the release already running' '! deploy agent-v1.0.0 && says "already running" && current agent-v1.0.0 &&
  [[ ! -e $R/deploy-status.json ]]'
mv "$R/current" "$R/current.away"
check 'refuses with no current to deploy over' '! deploy agent-v1.0.1 && says "no $R/current" && [[ ! -e $R/deploy-status.json ]]'
mv "$R/current.away" "$R/current"

check 'a release GitHub does not have fails before any restart' '! deploy agent-v9.9.9 && says "can'\''t download" && untouched agent-v9.9.9'
check 'a sha mismatch is refused' '! deploy agent-v2.0.1 && says "doesn'\''t match its .sha256" && untouched agent-v2.0.1'
check 'a .sha256 with no sum is refused' '! deploy agent-v2.0.2 && says "holds no sha256" && untouched agent-v2.0.2'
check 'a symlink in the archive is refused, nothing written through it' '! deploy agent-v2.0.3 && says "a link" &&
  untouched agent-v2.0.3 && [[ -z $(ls -A "$T/outside") ]]'
check 'a hard link in the archive is refused' '! deploy agent-v2.0.4 && says "a link" && untouched agent-v2.0.4'
check 'a .. name in the archive is refused' '! deploy agent-v2.0.5 && says "outside its folder: ../../../escaped" &&
  untouched agent-v2.0.5 && [[ ! -e $R/escaped && ! -e $T/escaped ]]'
check 'an absolute name in the archive is refused' '! deploy agent-v2.0.6 && says "outside its folder: $T/outside/abs" &&
  untouched agent-v2.0.6 && [[ -z $(ls -A "$T/outside") ]]'
check 'an archive without src/index.ts is refused' '! deploy agent-v2.0.7 && says "no src/index.ts" && untouched agent-v2.0.7'
check 'a file that is not a tarball is refused' '! deploy agent-v2.0.8 && says "isn'\''t a gzipped tar" && untouched agent-v2.0.8'
check 'a missing tarball is refused after its .sha256' '! deploy agent-v2.0.9 && says "can'\''t download orrery-agent-v2.0.9.tar.gz" &&
  untouched agent-v2.0.9'

agent ok
check 'an agent that connects flips current and writes ok' 'deploy agent-v1.0.1 && current agent-v1.0.1 &&
  status agent-v1.0.1 agent-v1.0.0 ok && restarts agent-v1.0.1 &&
  [[ $(cat "$R/releases/agent-v1.0.1/src/index.ts") == "// agent-v1.0.1" ]]'
agent late
check 'a connect a moment after the restart is waited for' 'deploy agent-v1.0.2 && current agent-v1.0.2 &&
  status agent-v1.0.2 agent-v1.0.1 ok && restarts agent-v1.0.2'
agent none ok
check 'an agent that never connects flips back, restarts the old one and writes rolled back' '! deploy agent-v1.0.3 &&
  current agent-v1.0.2 && status agent-v1.0.3 agent-v1.0.2 "rolled back" && restarts agent-v1.0.3 agent-v1.0.2 &&
  says "rolling back to agent-v1.0.2"'
agent stale ok
check 'a connected file from before the restart does not count' '! deploy agent-v1.0.4 && current agent-v1.0.2 &&
  status agent-v1.0.4 agent-v1.0.2 "rolled back" && restarts agent-v1.0.4 agent-v1.0.2'
agent wrong ok
check 'a connected file naming another version does not count' '! deploy agent-v1.0.5 && current agent-v1.0.2 &&
  status agent-v1.0.5 agent-v1.0.2 "rolled back" && restarts agent-v1.0.5 agent-v1.0.2'
agent none none
check 'an old agent that does not connect either writes failed and stays' '! deploy agent-v1.0.6 &&
  current agent-v1.0.2 && status agent-v1.0.6 agent-v1.0.2 failed && says "leaving it in place" &&
  restarts agent-v1.0.6 agent-v1.0.2'
check 'pruning keeps whatever current points at besides the three newest' 'releases agent-v1.0.2 agent-v1.0.4 agent-v1.0.5 agent-v1.0.6'
agent ok
check 'prunes releases to the three newest' 'deploy agent-v1.0.7 && current agent-v1.0.7 && releases agent-v1.0.5 agent-v1.0.6 agent-v1.0.7'
check 'redeploys a release still on disk from a fresh download' 'echo junk > "$R/releases/agent-v1.0.5/junk" &&
  deploy agent-v1.0.5 && current agent-v1.0.5 && status agent-v1.0.5 agent-v1.0.7 ok && [[ ! -e $R/releases/agent-v1.0.5/junk ]]'
check 'the status log is the excerpt of what happened' 'node -e "process.exit(JSON.parse(require(\"fs\").readFileSync(\"$R/deploy-status.json\")).log.includes(\"current -> releases/agent-v1.0.5\") ? 0 : 1)"'
check 'leaves no temporary links or files in the root' '[[ $(ls -A "$R" | tr "\n" " ") == ".incoming connected current deploy-status.json deploy.lock releases " &&
  -z $(ls -A "$R/.incoming") ]]'
check 'the old status file is gone before every restart' '! grep -rq "old status" "$F/calls" "$T/all"'
check 'only restarts orrery-agent.service' '! grep -q refused "$F/calls"'
check 'downloads only from the public release, with no token or header, stopping a stalled or oversized transfer' '[[ -s $F/curl && -s $T/all ]] &&
  ! grep -qvE "^curl -q -fsSL --proto =https --proto-redir =https --retry 2 --connect-timeout 30 --speed-limit 1 --speed-time 60 --max-filesize 67108864 (-o [^ ]+ )?https://github.com/Edward-Pratt/orrery/releases/download/agent-v[0-9.]+/orrery-agent-v[0-9.]+\.tar\.gz(\.sha256)?$" "$F/curl" &&
  ! grep -qF "$GITHUB_TOKEN" "$F/curl" "$T/all" "$R/deploy-status.json"'
exit $fail

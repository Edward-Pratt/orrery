#!/usr/bin/env bash
# Tests check-file-length in a throwaway repo: a changed source file over 300 lines fails (new, grown, or shrunk but
# still over), unless its first 10 lines carry `modular-exempt:`; one at or under the cap, an unchanged long file and a
# file of another type pass; an untracked file counts as new.
#   bash .github/test-check-file-length.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

mkdir -p "$T/.github" "$T/src"
cp "$HERE/check-file-length" "$T/.github/"
cd "$T"
git init -q -b main && git config user.email t@t && git config user.name t
lines() { seq "$1" | sed 's/^/x/'; }
lines 400 > src/long.ts        # over the cap from the start, never touched below until its own case
lines 350 > src/shrinks.ts
lines 100 > src/short.ts
git add -A && git commit -qm base

# check <want: pass|fail> <what>: runs the check against main's commit with the working tree as it is now.
check() {
  local out code=0
  out=$(bash .github/check-file-length main 2>&1) || code=$?
  if { [[ $1 == pass && $code -eq 0 ]] || [[ $1 == fail && $code -ne 0 ]]; }; then echo "ok   $1: $2"
  else echo "FAIL want $1, got exit $code: $2"; echo "$out"; exit 1; fi
}

check pass 'nothing changed (a long file untouched is never checked)'
lines 299 > src/short.ts && check pass 'a changed file at or under the cap'
git checkout -q -- src/short.ts
lines 320 > src/shrinks.ts && check fail 'a long file cut but still over the cap'
{ echo '// modular-exempt: a table of data'; lines 320; } > src/shrinks.ts && check pass 'the same with the marker in line 1'
{ lines 9; echo '// modular-exempt: a parser'; lines 320; } > src/shrinks.ts && check pass 'the marker in line 10'
{ lines 10; echo '// modular-exempt: too late'; lines 320; } > src/shrinks.ts && check fail 'the marker in line 11'
git checkout -q -- src/shrinks.ts
lines 450 > src/long.ts && check fail 'a long file that grew'
git checkout -q -- src/long.ts
lines 301 > src/new.ts && check fail 'an untracked file over the cap'
rm src/new.ts
lines 301 > src/new.lua && git add src/new.lua && check fail 'a new Lua file over the cap'
git rm -qf src/new.lua
lines 900 > src/notes.md && check pass 'a long file of another type'
rm src/notes.md
git mv src/long.ts src/moved.ts && check fail 'a long file moved'

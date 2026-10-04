#!/usr/bin/env bash
# Tests release.sh against a throwaway bare "origin" and a clone of it.
#   bash .github/test-release.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# Origin: hub-v1.2.3 and hub-v1.10.0 (sort -V, not lexical), mod-v0.4.0 on HEAD, then a hub commit and a web commit.
git init -q --bare -b main "$T/origin.git"
git clone -q "$T/origin.git" "$T/c" 2> /dev/null # empty repository warning
cd "$T/c"
commit() { mkdir -p "$(dirname "$1")"; echo "$2" >> "$1"; git add -A; git commit -qm "$2"; }
commit hub/a 'feat: hub one'; git tag hub-v1.2.3
commit hub/a 'fix: hub two'; git tag hub-v1.10.0
commit mod/a 'feat: mod one'; git tag mod-v0.4.0
commit hub/a 'feat: hub three'
commit web/a 'feat: web one'
git push -q origin main --tags
git branch local-only
remote() { git ls-remote "$T/origin.git" | sort; }
before=$(remote)

release() { "$HERE/release.sh" "$@" > "$T/out" 2>&1; }
says() { grep -qF -- "$1" "$T/out"; }
nothing_pushed() { [[ $(remote) == "$before" ]] && [[ -z $(git tag -l hub-v2.0.0 hub-v1.11.0 hub-v1.10.1) ]]; }

fail=0
check() {
  if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; sed 's/^/     /' "$T/out"; fail=1; fi
}

check 'refuses a bad part, level or flag' '! release db patch && ! release hub huge && ! release hub patch -y && says usage'
check 'major bumps from the latest tag' '! release hub major <<< n && says "hub-v1.10.0 → hub-v2.0.0"'
check 'minor bumps from the latest tag' '! release hub minor <<< n && says "hub-v1.10.0 → hub-v1.11.0"'
check 'patch bumps from the latest tag' '! release hub patch <<< n && says "hub-v1.10.0 → hub-v1.10.1"'
check 'notes are only the part'\''s commits since its tag' \
  '! release hub patch <<< n && says "feat: hub three" && ! says "web one" && ! says "hub two"'
check 'any answer but y pushes nothing' \
  '! release hub patch <<< yes && ! release hub patch < /dev/null && says "Nothing pushed" && nothing_pushed'
check 'first release of a part bumps from 0.0.0' '! release web minor <<< n && says "(none) → web-v0.1.0" && says "feat: web one"'
check 'refuses with nothing new for the part' '! release mod patch && says "nothing to release" && nothing_pushed'

git checkout -q -b side
check 'refuses off main' '! release hub patch --yes && says "not on main" && nothing_pushed'
git checkout -q main
echo dirty >> hub/a
check 'refuses a dirty tree' '! release hub patch --yes && says uncommitted && nothing_pushed'
git checkout -q hub/a
echo untracked > scratch
check 'ignores untracked files' '! release hub patch <<< n && says "hub-v1.10.1"'
rm scratch

git clone -q "$T/origin.git" "$T/other"
(cd "$T/other" && commit hub/b 'feat: elsewhere' && git push -q origin main)
before=$(remote)
check 'refuses behind origin/main' '! release hub patch --yes && says "behind origin/main" && nothing_pushed'
git pull -q --ff-only origin main

head=$(git rev-parse HEAD)
check 'y pushes only the tag' \
  'release hub minor <<< y && says "actions/workflows/release.yml" &&
   [[ $(git ls-remote "$T/origin.git" refs/tags/hub-v1.11.0) == "$head"* ]] &&
   diff <(remote | grep -v hub-v1.11.0) <(echo "$before") > /dev/null && ! remote | grep -q local-only'
check 'refuses again on the same commit' '! release hub patch --yes && says "nothing to release"'
commit web/a 'fix: web two'; git push -q origin main; before=$(remote)
check '--yes pushes only the tag, no prompt' \
  'release web patch --yes < /dev/null && ! says "[y/N]" && [[ -n $(git ls-remote "$T/origin.git" refs/tags/web-v0.0.1) ]] &&
   diff <(remote | grep -v web-v0.0.1) <(echo "$before") > /dev/null'
# The Mod's release asset: orrery-<minecraft>-<version>.jar, from the one built jar (not -dev or -sources).
mod_jars() { bash "$HERE/mod-jars.sh" "$T/mod" "$T/dist" > "$T/out" 2>&1; }
mkdir -p "$T/mod/build/libs"
printf 'modId = orrery\nminecraftVersion = 1.7.10\n' > "$T/mod/gradle.properties"
check 'the Mod jar needs a build' '! mod_jars && says "want one built jar"'
touch "$T/mod/build/libs/orrery-1.5.0"{,-dev,-sources}.jar
check 'the Mod jar is named for its Minecraft target' 'mod_jars && [[ $(ls "$T/dist") == orrery-1.7.10-1.5.0.jar ]]'
touch "$T/mod/build/libs/orrery-1.4.0.jar"
check 'the Mod jar must be the only one' '! mod_jars && says "want one built jar"'
exit $fail

#!/usr/bin/env bash
# Tests release.sh against a throwaway bare "origin" and a clone of it.
#   bash .github/test-release.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# Origin: hub-v1.2.3 and hub-v1.10.0 (sort -V, not lexical), mod-v0.4.0 on HEAD, then a hub, a web, an agent and a
# factorio commit.
git init -q --bare -b main "$T/origin.git"
git clone -q "$T/origin.git" "$T/c" 2> /dev/null # empty repository warning
cd "$T/c"
commit() { mkdir -p "$(dirname "$1")"; echo "$2" >> "$1"; git add -A; git commit -qm "$2"; }
commit hub/a 'feat: hub one'; git tag hub-v1.2.3
commit hub/a 'fix: hub two'; git tag hub-v1.10.0
commit mod/a 'feat: mod one'; git tag mod-v0.4.0
commit hub/a 'feat: hub three'
commit web/a 'feat: web one'
commit agent/a 'feat: agent one'
commit factorio/a 'feat: factorio one'
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
check 'the agent and the Factorio mod are parts too' \
  '! release agent minor <<< n && says "(none) → agent-v0.1.0" && says "feat: agent one" && ! says "factorio one" &&
   ! release factorio patch <<< n && says "(none) → factorio-v0.0.1" && says "feat: factorio one"'
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
   [[ $(git ls-remote "$T/origin.git" "refs/tags/hub-v1.11.0^{}") == "$head"* ]] && [[ $(git cat-file -t hub-v1.11.0) == tag ]] &&
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
# The Factorio mod's release asset: orrery_<version>.zip, one top folder orrery_<version>/, the version in its info.json.
factorio_zip() { bash "$HERE/factorio-zip.sh" "$T/factorio" "$1" "$T/fdist" > "$T/out" 2>&1; }
mkdir -p "$T/factorio/locale/en"
check 'the Factorio zip needs an info.json' '! factorio_zip 1.2.3 && says "want one info.json"'
echo '{"name": "other", "version": "0.0.0"}' > "$T/factorio/info.json"
check 'the Factorio zip needs the mod named orrery' '! factorio_zip 1.2.3 && says "want one info.json"'
echo '{"name": "orrery", "version": "0.0.0", "description": "Says @hello <there>."}' > "$T/factorio/info.json"
cp "$T/factorio/info.json" "$T/factorio/locale/en/info.json"
check 'the Factorio zip needs only one info.json' '! factorio_zip 1.2.3 && says "want one info.json"'
rm "$T/factorio/locale/en/info.json"
check 'the Factorio zip needs a version X.Y.Z' \
  '! factorio_zip 1.2 && says "want a version" && ! factorio_zip v1.2.3 && [[ ! -e $T/fdist ]]'
touch "$T/factorio/control.lua" "$T/factorio/locale/en/orrery.cfg" "$T/factorio/CLAUDE.md"
check 'the Factorio zip has the portal'\''s layout, without CLAUDE.md' \
  'factorio_zip 1.2.3 && [[ $(ls "$T/fdist") == orrery_1.2.3.zip ]] &&
   diff <(unzip -Z1 "$T/fdist/orrery_1.2.3.zip" | grep -v "/$" | sort) \
     <(printf "orrery_1.2.3/%s\n" control.lua info.json locale/en/orrery.cfg) > /dev/null'
check 'the Factorio zip carries the version, the source keeps its own' \
  'unzip -p "$T/fdist/orrery_1.2.3.zip" orrery_1.2.3/info.json | jq -e ".name == \"orrery\" and .version == \"1.2.3\"" > /dev/null &&
   [[ $(jq -r .version "$T/factorio/info.json") == 0.0.0 ]]'
# The mod portal: factorio-publish.sh against a fake curl (on PATH for these runs only) that plays the portal. It keeps
# each call's argv, one per line, then the headers it read from stdin after a `stdin:` line, in $P/<n>. Who answers:
#   init_upload    UnknownMod when $P/state is "new", Forbidden when "forbidden", HTML when "down", else an upload_url;
#                  InvalidApiKey without the key's header
#   init_publish   another upload_url
#   upload_url     $P/upload, else {"success": true}
P=$T/portal ZIP=$T/fdist/orrery_1.2.3.zip KEY='k3y-%s-$(x)'
mkdir -p "$T/pbin" "$P"
cat > "$T/pbin/curl" << 'EOF'
#!/usr/bin/env bash
n=$(($(find "$P" -name 'call.*' | wc -l) + 1))
{ printf '%s\n' "$@"; echo stdin:; if [[ " $* " == *' -H @- '* ]]; then cat; fi; } > "$P/call.$n"
url=${!#}
case $url in
  https://mods.factorio.com/api/v2/mods/*)
    if ! grep -qxF "Authorization: Bearer $KEY" "$P/call.$n"; then echo '{"error":"InvalidApiKey","message":"Missing or invalid API key"}'
    elif [[ $url == */releases/init_upload && $(cat "$P/state") == new ]]; then echo '{"error":"UnknownMod","message":"Mod does not exist in mod portal"}'
    elif [[ $url == */releases/init_upload && $(cat "$P/state") == forbidden ]]; then echo '{"error":"Forbidden","message":"Insufficent permission"}'
    elif [[ $url == */releases/init_upload && $(cat "$P/state") == down ]]; then echo '<html>502 Bad Gateway</html>'
    elif [[ $url == */releases/init_upload ]]; then echo '{"upload_url":"https://mods.factorio.com/upload/mod/abc123"}'
    elif [[ $url == */init_publish ]]; then echo '{"upload_url":"https://mods.factorio.com/upload/mod/new456"}'
    else echo '{"error":"InvalidRequest","message":"what"}'; fi ;;
  https://mods.factorio.com/upload/mod/*) if [[ -f $P/upload ]]; then cat "$P/upload"; else echo '{"success":true,"url":"/mod/orrery"}'; fi ;;
  *) echo "curl: (6) Could not resolve host" >&2; exit 6 ;;
esac
EOF
chmod +x "$T/pbin/curl"
export P KEY
portal() { # <state> [zip]: one publish run against a fresh portal log
  rm -f "$P"/call.* "$P/upload"; echo "$1" > "$P/state"
  FACTORIO_API_KEY=${FACTORIO_API_KEY-$KEY} PATH=$T/pbin:$PATH bash "$HERE/factorio-publish.sh" "${2:-$ZIP}" > "$T/out" 2>&1
}
calls() { find "$P" -name 'call.*' | wc -l; }
# call <n> <expected argv, one per line, then stdin: and the headers>: that call was exactly this
call() { diff <(cat "$P/call.$1") <(printf '%s\n' "${@:2}") > /dev/null; }
init_call() { # <n> <endpoint>: the mod's name only, the key only as a header on stdin
  call "$1" -q -sS --proto =https --proto-redir =https -H @- --form-string mod=orrery \
    "https://mods.factorio.com/api/v2/mods/$2" stdin: "Authorization: Bearer $KEY"
}
args_only() { sed '/^stdin:$/,$d' "$P/call.$1"; } # a call's argv, without its stdin
no_key() { # the key in no output and no call's argv
  local n
  ! grep -qF -- "$KEY" "$T/out" || return 1
  for ((n = 1; n <= $(calls); n++)); do ! args_only "$n" | grep -qF -- "$KEY" || return 1; done
}
check 'the first release publishes the mod: init_upload, then init_publish with the name alone, then the page fields' \
  'portal new && says "publishing it" && says "orrery 1.2.3 is on the mod portal" && [[ $(calls) == 3 ]] &&
   init_call 1 releases/init_upload && init_call 2 init_publish &&
   call 3 -q -sS --proto =https --proto-redir =https -F "file=@$ZIP" \
     --form-string "description=Says @hello <there>." --form-string category=utilities \
     --form-string license=default_mit --form-string source_url=https://github.com/Edward-Pratt/orrery \
     https://mods.factorio.com/upload/mod/new456 stdin:'
check 'a later release uploads only the file, to the upload_url init_upload gave' \
  'portal known && ! says "publishing it" && [[ $(calls) == 2 ]] && init_call 1 releases/init_upload &&
   call 2 -q -sS --proto =https --proto-redir =https -F "file=@$ZIP" https://mods.factorio.com/upload/mod/abc123 stdin:'
check 'the key is in no command line and no output, only in the init calls'\'' stdin' \
  'portal new && no_key && ! args_only 3 | grep -qF Authorization &&
   [[ $(sed -n "/^stdin:$/,\$p" "$P/call.3") == stdin: ]]'
check 'another portal error stops before any upload, naming it' \
  '! portal forbidden && says "Forbidden: Insufficent permission" && [[ $(calls) == 1 ]] && no_key'
check 'an answer that is not JSON stops before any upload' '! portal down && says "502 Bad Gateway" && [[ $(calls) == 1 ]]'
check 'a refused upload fails, naming the portal'\''s error' \
  'rm -f "$P"/call.*; echo known > "$P/state"; echo "{\"success\":false,\"error\":\"InvalidModUpload\",\"message\":\"bad zip\"}" > "$P/upload" &&
   ! FACTORIO_API_KEY=$KEY PATH=$T/pbin:$PATH bash "$HERE/factorio-publish.sh" "$ZIP" > "$T/out" 2>&1 &&
   says "InvalidModUpload: bad zip" && [[ $(calls) == 2 ]] && no_key'
check 'a wrong key is refused by the portal' '! FACTORIO_API_KEY=wrong portal known && says InvalidApiKey && [[ $(calls) == 1 ]]'
check 'no key, no call' '! FACTORIO_API_KEY= portal known && says FACTORIO_API_KEY && [[ $(calls) == 0 ]]'
cp "$ZIP" "$T/fdist/orrery_1.2.4.zip"
check 'the zip must be orrery_X.Y.Z.zip holding that version' \
  '! portal known "$T/fdist/orrery_1.2.4.zip" && says "doesn'\''t name orrery 1.2.4" && [[ $(calls) == 0 ]] &&
   ! portal known "$T/fdist" && ! portal known "$T/fdist/missing.zip" && [[ $(calls) == 0 ]]'
exit $fail

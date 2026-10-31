#!/usr/bin/env bash
# Puts the Factorio mod's release zip on the mod portal (mods.factorio.com) as `orrery`. Run by release.yml for a
# factorio-v* tag, once the GitHub release has the zip:
#   FACTORIO_API_KEY=... bash .github/factorio-publish.sh dist/orrery_<version>.zip
# init_upload names the mod. Until the first release claims the name the portal answers UnknownMod, and init_publish,
# with only the mod's name, claims it instead. Either answers with an upload_url, which takes the zip: a first publish
# adds the mod page's description (the zip's info.json description), category, license and source_url; later releases
# send only the file. The API takes multipart/form-data and answers JSON, an error as {error, message}
# (https://wiki.factorio.com/Mod_upload_API, Mod_publish_API).
# The key reaches curl as a header on its stdin (-H @-), so it is in no command line and no log; the upload_url,
# already signed, gets no key at all.
set -euo pipefail
die() { echo "factorio-publish: $*" >&2; exit 1; }
[[ $# -eq 1 && -f $1 ]] || die "usage: $0 <orrery_X.Y.Z.zip>, with FACTORIO_API_KEY set"
zip=$1 MOD=orrery API=https://mods.factorio.com/api/v2/mods SOURCE=https://github.com/Edward-Pratt/orrery
[[ ${zip##*/} =~ ^orrery_([0-9]+\.[0-9]+\.[0-9]+)\.zip$ ]] || die "want a zip named orrery_X.Y.Z.zip, got ${zip##*/}"
v=${BASH_REMATCH[1]}
info=$(unzip -p "$zip" "orrery_$v/info.json") && jq -e --arg v "$v" '.name == "orrery" and .version == $v' <<< "$info" > /dev/null ||
  die "the zip's orrery_$v/info.json doesn't name orrery $v"
[[ -n ${FACTORIO_API_KEY:-} ]] || die 'FACTORIO_API_KEY is empty: add the repository secret'
CURL=(curl -q -sS --proto =https --proto-redir =https)

init() { # <endpoint>: asks for an upload_url for the mod, with the key; prints the portal's answer
  printf 'Authorization: Bearer %s\n' "$FACTORIO_API_KEY" | "${CURL[@]}" -H @- --form-string "mod=$MOD" "$API/$1"
}
field() { jq -r --arg k "$1" '.[$k] // empty | strings' <<< "$2" 2> /dev/null || true; }
why() { # <answer>: the portal's error and message, or the start of whatever it said
  jq -er '"\(.error // "no error code"): \(.message // "")"' <<< "$1" 2> /dev/null || printf '%.300s' "$1"
}

answer=$(init releases/init_upload) || die "can't reach the mod portal"
url=$(field upload_url "$answer") first=0
if [[ -z $url && $(field error "$answer") == UnknownMod ]]; then
  echo "the mod portal has no $MOD yet: publishing it"
  answer=$(init init_publish) || die "can't reach the mod portal"
  url=$(field upload_url "$answer") first=1
fi
[[ -n $url ]] || die "the mod portal gave no upload_url: $(why "$answer")"

form=(-F "file=@$zip")
if ((first)); then
  form+=(--form-string "description=$(jq -r '.description // ""' <<< "$info")" --form-string category=utilities
    --form-string license=default_mit --form-string "source_url=$SOURCE")
fi
answer=$("${CURL[@]}" "${form[@]}" "$url") || die "can't upload $zip to the mod portal"
[[ $(jq -r '.success == true' <<< "$answer" 2> /dev/null) == true ]] || die "the mod portal refused $zip: $(why "$answer")"
echo "orrery $v is on the mod portal: https://mods.factorio.com/mod/$MOD"

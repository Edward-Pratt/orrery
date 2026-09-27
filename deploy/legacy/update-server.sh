#!/usr/bin/env bash
set -Eeuo pipefail
trap 'echo "ERROR: failed at line $LINENO: $BASH_COMMAND"' ERR

download_update() {
    local input_url="$1"
    local output_zip="$2"

    if [[ "$input_url" =~ github\.com/([^/]+)/([^/]+)/actions/runs/([0-9]+)/artifacts/([0-9]+) ]]; then
        local owner="${BASH_REMATCH[1]}"
        local repo="${BASH_REMATCH[2]}"
        local artifact_id="${BASH_REMATCH[4]}"
        local api_url="https://api.github.com/repos/$owner/$repo/actions/artifacts/$artifact_id/zip"

        echo "Detected GitHub Actions artifact URL"
        echo "Repo:        $owner/$repo"
        echo "Artifact ID: $artifact_id"

        if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
            echo "Downloading via GitHub API using gh authentication..."
            local token
            token="$(gh auth token)"

            curl -L --fail \
                -H "Accept: application/vnd.github+json" \
                -H "Authorization: Bearer $token" \
                -o "$output_zip" \
                "$api_url"

        elif [ -n "${GITHUB_TOKEN:-}" ]; then
            echo "Downloading via GitHub API using GITHUB_TOKEN..."

            curl -L --fail \
                -H "Accept: application/vnd.github+json" \
                -H "Authorization: Bearer $GITHUB_TOKEN" \
                -o "$output_zip" \
                "$api_url"
        else
            echo "ERROR: GitHub artifact URL provided, but no GitHub authentication is available."
            echo "Run:"
            echo "  gh auth login"
            echo
            echo "or set:"
            echo "  export GITHUB_TOKEN=your_token_here"
            exit 1
        fi
    else
        echo "Downloading normal direct URL..."
        curl -L --fail -o "$output_zip" "$input_url"
    fi
}

fix_perms() {
    local path="$1"

    if [ -e "$path" ]; then
        chmod -R u+rwX "$path" 2>/dev/null || {
            echo "ERROR: Could not fix permissions for $path"
            echo "This usually means some files are owned by another user."
            echo "Try:"
            echo "  sudo chown -R \$USER:\$USER \"$path\""
            exit 1
        }
    fi
}

echo ""
echo "Copy Server Zip Url from:"
printf "\033[34;4mhttps://www.gtnewhorizons.com/downloads\033[0m\n"
echo ""
echo "Paste url of update .zip or GitHub artifact URL"
echo ""
read -r url

i="./"

# Use a fresh temp dir outside the server folder every run
work="$(mktemp -d)"
temp="$work/extract"
update="$work/gtnh-update.zip"

# Set max ram
ram="16G"

mkdir -p "$temp"

echo ""
echo "Using temporary work dir:"
echo "$work"
echo ""

# download update
download_update "$url" "$update"

echo "Checking downloaded zip..."
if ! unzip -tq "$update"; then
    echo "ERROR: Downloaded file is not a valid zip."
    echo "File info:"
    file "$update" || true
    echo
    echo "First few bytes:"
    head -c 300 "$update" || true
    echo
    exit 1
fi

# unzip outer update
echo "Extracting outer zip..."
unzip -q "$update" -d "$temp"

# Important: fix permissions BEFORE using find
fix_perms "$temp"

# If the downloaded zip contains another zip, extract that too
inner_zip="$(find "$temp" -type f -iname "*.zip" -print -quit || true)"

if [ -n "$inner_zip" ]; then
    echo "Found nested zip:"
    echo "$inner_zip"
    echo "Extracting nested zip..."

    nested_dir="$temp/nested"
    mkdir -p "$nested_dir"
    unzip -q "$inner_zip" -d "$nested_dir"

    # Fix permissions again after nested extraction
    fix_perms "$temp"
fi

# Find the real extracted server pack folder.
# This should be the folder containing config/ and mods/
packroot="$(
    find "$temp" -type d \
        -exec test -d "{}/config" \; \
        -exec test -d "{}/mods" \; \
        -print -quit
)"

if [ -z "$packroot" ]; then
    echo "ERROR: Could not find extracted GTNH server pack folder."
    echo "Expected a folder containing config/ and mods/"
    echo "Temp folder kept at:"
    echo "$work"
    exit 1
fi

echo "Using pack root:"
echo "$packroot"

# preserve journeymap server map from current instance
jm_backup="$work/JourneyMapServer"

if [ -d "$i/config/JourneyMapServer" ]; then
    mv "$i/config/JourneyMapServer" "$jm_backup"
fi

# remove old files
rm -rf \
    "$i/config" \
    "$i/libraries" \
    "$i/mods" \
    "$i/lwjgl3ify-forgePatches.jar" \
    "$i/java9args.txt" \
    "$i/startserver-java9.sh"

# copy update files from extracted pack > instance
cp -vrt "$i" "$packroot/config"

if [ -d "$packroot/libraries" ]; then
    cp -vrt "$i" "$packroot/libraries"
fi

cp -vrt "$i" "$packroot/mods"

if [ -f "$packroot/lwjgl3ify-forgePatches.jar" ]; then
    cp -v "$packroot/lwjgl3ify-forgePatches.jar" "$i"
fi

if [ -f "$packroot/java9args.txt" ]; then
    cp -v "$packroot/java9args.txt" "$i"
fi

if [ -f "$packroot/startserver-java9.sh" ]; then
    cp -v "$packroot/startserver-java9.sh" "$i"
fi

# restore journeymap server map
if [ -d "$jm_backup" ]; then
    rm -rf "$i/config/JourneyMapServer"
    mv "$jm_backup" "$i/config/JourneyMapServer"
fi

# setting ram
if [ -f "$i/startserver-java9.sh" ]; then
    sed -i -E "s/-Xmx[0-9]+[GgMm]/-Xmx$ram/g" "$i/startserver-java9.sh"
    chmod +x "$i/startserver-java9.sh"
fi

# Disable Pollution
if [ -f "$i/config/GregTech/Pollution.cfg" ]; then
    sed -i 's/B:"Activate Pollution"=true/B:"Activate Pollution"=false/' "$i/config/GregTech/Pollution.cfg"
fi

# apply custom overrides
if [ -d "../gtnhcustom/config" ]; then
    cp -rf ../gtnhcustom/config ./
fi

if [ -d "../gtnhcustom/mods" ]; then
    cp -rf ../gtnhcustom/mods ./
fi

# final permission cleanup for server files
chmod -R u+rwX config mods

if [ -d libraries ]; then
    chmod -R u+rwX libraries
fi

if [ -f startserver-java9.sh ]; then
    chmod +x startserver-java9.sh
fi

echo ""
echo "Update complete."
echo "Temp work dir was:"
echo "$work"

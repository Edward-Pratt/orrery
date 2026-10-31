# factorio (orrery)

The Factorio mod `orrery`: control-only Lua (`info.json`, `control.lua`) that connects a Factorio server to orrery.
It is published on the Factorio mod portal as `orrery`.

- `info.json` keeps `version` at `0.0.0`. The release writes the real one into the zip's copy, from the
  `factorio-vX.Y.Z` tag (`.github/factorio-zip.sh`; CI zips the newest `factorio-v*` tag's version).
- The zip is `orrery_<version>.zip` with the single top folder `orrery_<version>/`, the portal's layout. This
  `CLAUDE.md` is left out of it. `bash .github/test-release.sh` tests the script.
- Cut a release with `.github/release.sh factorio <major|minor|patch>`; `release.yml` attaches the zip to the
  GitHub release. Uploading it to the portal is still done by hand.
- Every player who joins a server with the mod must download that exact version from the portal, so release
  rarely: batch changes rather than shipping each one.

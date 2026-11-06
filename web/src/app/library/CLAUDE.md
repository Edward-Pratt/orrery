# library

The Library page (`library`, after Host; only when `/api/integrations` says the hub has a `library`, and for a user with
the `library` permission): its Packs,
newest first (name and version, Minecraft version, loader, size, source, sha256, who added it and when, "used by"), an
empty state, Add pack (a sheet: Link, Actions artifact (its `github.com/…/actions/runs/…/artifacts/…` link, fetched by
the hub with its token) or Upload through `Uploader`, name and version from `fromFileName` (here), Minecraft version
and loader left blank for the hub to read from the zip; all editable), the running add's card (its latest progress
from `libraryAdd` events, Cancel; no Add meanwhile), a red line saying why the last add failed (or the hub's note on
one that was already there), and Delete (typed name and version); then Java runtimes ("Temurin 21.0.8+9", Java
version, size, the servers set to each, an empty state), Add runtime (a sheet: 8, 17, 21 or 25) and Delete (typed
name; the hub's 409 names the servers). The running add's card serves either kind.

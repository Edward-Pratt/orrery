# Downloading GTNH server packs: GitHub releases, Actions artifacts, downloads.gtnewhorizons.com

Research for #124 (part of #123). Checked 2026-10-04 against the live GitHub API, the GTNH repos and the GitHub docs.
"Observed" means a real request made that day. Everything else cites the doc or file it comes from.

## TL;DR

- **Nightlies are GitHub release assets now.** Since DreamAssemblerXXL#306 (2026-08-25) the daily build publishes
  each run as a release in **`GTNewHorizons/GTNH-Daily-Builds`**. A release asset of a public repo needs **no
  token**, resumes with `Range`, and its signed URL lasts **1 hour**. Releases are kept **14 days** and at most **30**
  at a time. This is the easiest source for nightlies.
- **Actions artifacts** (DreamAssemblerXXL, the same builds) need **a token, even for a public repo** (observed 401
  without one). Any token works: a fine-grained token always has read access to every public repo, so the
  `GITHUB_TOKEN` the hub already has for `integrations.github` can download them. The redirect to the blob lasts
  about **10 minutes** (observed; the docs say 1 minute). `Range` works on the blob. Since DreamAssemblerXXL#271
  (2026-05-06, `archive: false`) the server zip is **not wrapped** in another zip. Artifacts are kept 90 days.
- **Stable and beta packs** come from `downloads.gtnewhorizons.com` (a Cloudflare R2 public bucket). No auth, no
  expiry, `Range` works, no directory listing. The URLs are listed in `https://www.gtnewhorizons.com/versions.json`.
- `GTNewHorizons/GT-New-Horizons-Modpack` releases (`2.9.0-RC-1.zip`, `2.9.0-nightly-*.zip`) are **not server packs**.
  They are the config repo's snapshot: `config/`, `journeymap/`, only 11 files under `mods/`.
- **The owner's browser workaround can go.** The hub can do that step itself: call the artifact API with its token
  and follow the 302. Node's `fetch` already does it (observed). `fetchDownload` needs two changes: an
  `Authorization` header for `api.github.com`, and resume (the URL expires, so resume means asking the API for a
  fresh URL and sending `Range` with `If-Range`).

## Where the server packs come from

| Kind | Where | Server pack name |
|---|---|---|
| Stable, beta, RC | `downloads.gtnewhorizons.com/ServerPacks/[betas/]` | `GT_New_Horizons_<ver>_Server_Java_8.zip`, `..._Server_Java_17-26.zip` (`17-25` before 2.9.0-beta-3) |
| Daily (nightly) release | `GTNewHorizons/GTNH-Daily-Builds`, tag `daily-<YYYY-MM-DD>+<run>` | `GTNH-daily-<date>+<run>-server-java8.zip`, `...-server-java17-26.zip` |
| Daily artifact | `GTNewHorizons/DreamAssemblerXXL`, workflow `daily-modpack-build.yml` (id 168111074) | same names as the release assets |
| Experimental artifact | DreamAssemblerXXL `experimental-modpack-build.yml` (id 168285064) | `GTNH-experimental-<date>+<run>-server-java...zip`. Last run 2026-06-14, so its artifacts have all expired |

Sources: [`daily-modpack-build.yml`](https://github.com/GTNewHorizons/DreamAssemblerXXL/blob/master/.github/workflows/daily-modpack-build.yml)
(the "Relocate built zips", "Upload server zip" and "Publish daily release" steps),
[`versions.json`](https://github.com/GTNewHorizons/GTNewHorizons.github.io/blob/master/public/versions.json).
That file is also served at `https://www.gtnewhorizons.com/versions.json`, which returned 200 with 39 versions from
2.8.0-beta-4 to 2.9.0-RC-1.

Every server zip I looked at (a daily release asset, a daily artifact, and 2.8.4 from downloads) starts with
`mods/adventurebackpack-...jar`: the pack's files sit at the zip root, with no folder around them.

Each daily run also uploads a `daily-build-bundle` artifact, about 3.2 GB, kept 1 day. It is a normal (archived)
artifact that holds all the zips, so it is a zip of zips. Don't use it.

## 1. GitHub release assets (daily builds)

- **Endpoint**: either `browser_download_url`, e.g.
  `https://github.com/GTNewHorizons/GTNH-Daily-Builds/releases/download/daily-2026-10-04%2B772/GTNH-daily-2026-10-04%2B772-server-java17-26.zip`
  (the `+` must be encoded as `%2B`), or the API at `GET /repos/{owner}/{repo}/releases/assets/{asset_id}` with
  `Accept: application/octet-stream`. To find the latest one: `GET /repos/GTNewHorizons/GTNH-Daily-Builds/releases?per_page=1`,
  then take the asset whose name ends in `-server-java8.zip` or `-server-java17-26.zip`.
- **Auth**: none for a public repo (observed: both URLs return 302 without a token). Unauthenticated API calls are
  limited to 60 an hour (observed `x-ratelimit-limit: 60`). The docs say clients "should handle both a 200 or 302
  response" ([REST: release assets](https://docs.github.com/en/rest/releases/assets#get-a-release-asset)).
- **Redirect**: a 302 to `release-assets.githubusercontent.com/github-production-release-asset/...`, an Azure SAS URL
  plus a JWT. Observed `se=` about 1 h ahead, and the JWT's `exp − nbf = 3600 s`, so it lasts **1 hour**.
- **Range**: works (observed `206`, `content-range: bytes 1000-1999/552962494`, `accept-ranges: bytes`). The `ETag`
  (`"0x8DF22009B86A1DA"`) and `last-modified` are stable, so a resume can send `If-Range`.
- **Wrapped?** No. A release asset is the file itself (observed: the first bytes are `PK\x03\x04` and then `mods/...`).
- **Retention**: the workflow deletes daily releases older than `RELEASE_RETENTION_DAYS: 14` and keeps at most
  `MAX_DAILY_RELEASES: 30` ("Delete expired daily releases" and "Enforce maximum daily release count").
  Observed: 23 releases, 2026-09-20 to 2026-10-04, each with 6 assets.
- **Sizes**: server java8 about 538 MB, java17-26 about 553 MB.

## 2. GitHub Actions artifacts (DreamAssemblerXXL)

- **Endpoints**:
  - list: `GET /repos/GTNewHorizons/DreamAssemblerXXL/actions/workflows/168111074/runs?per_page=1`, then
    `GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts`. Each artifact has `name`, `size_in_bytes`,
    `expires_at` and `digest` (`sha256:...`). You can also filter with `GET /repos/{owner}/{repo}/actions/artifacts?name=...`.
  - download: `GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip` → 302
    ([REST: Download an artifact](https://docs.github.com/en/rest/actions/artifacts#download-an-artifact)).
    A 410 means the artifact has expired.
  - Send `Accept: application/vnd.github+json` or no `Accept` header at all. `Accept: application/octet-stream`
    gets a **415** (observed).
- **Auth**: **required even for a public repo**. Observed `401 Requires authentication` without a token and 302 with
  one. The docs only say "Anyone with read access to the repository can use this endpoint", but in practice you must
  be logged in. upload-artifact's README says the same about its `artifact-url`: "Users must be logged-in in order for
  this URL to work".
  - Fine-grained token: the **Actions: read** repository permission
    ([permissions table](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens#repository-permissions-for-actions)).
    For a public repo it needs no extra grant: "Tokens always include read-only access to all public repositories on
    GitHub" ([managing PATs](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)).
    So the `GITHUB_TOKEN` already in `/etc/orrery.env` (scoped to `Edward-Pratt/orrery`, Contents: read) should be
    enough. I didn't test that exact token; I tested with a classic OAuth token. Check it with one `curl -I` on the host.
  - Classic token: needs the `repo` scope only for private repos.
- **Redirect**: a 302 to `productionresultssa*.blob.core.windows.net/actions-results/...zip?...&st=…&se=…&sig=…`.
  The docs say "This URL expires after 1 minute". Observed `se − st` was **10 minutes** two times. Plan for 1
  minute: never store the blob URL, ask the API for a fresh one each time. The blob URL needs no
  `Authorization` (observed 206 with a plain `curl`). That's why the owner's pasted link works, until it expires.
- **Range**: works on the blob (observed `206`, `Content-Range: bytes 0-3/551955036`). The `ETag` is stable across
  two separately signed URLs (observed `"0x8DF12523748506E"` both times), so a resume can get a fresh URL and send
  `Range` with `If-Range`. I didn't test whether an open transfer survives past `se`. Azure normally checks the SAS
  only when the request starts.
- **Wrapped?** Not any more. The server zips are uploaded with `archive: false` ("If 'false', only a single file can
  be uploaded. The name of the file will be used as the artifact name", per the
  [upload-artifact README](https://github.com/actions/upload-artifact#inputs)). Observed: the artifact
  `GTNH-daily-2026-10-04+772-server-java17-26.zip` is 552962494 bytes, the same as the release asset, and the
  download starts with `PK\x03\x04` then `mods/...`. Artifacts from before DreamAssemblerXXL#271 "Fix Double Zip
  Packing" (2026-05-06) were zip-in-zip, but those have all expired. To be safe, the hub could check that the
  downloaded zip holds exactly one `*.zip` entry and nothing else, and unwrap it if so.
- **Name**: the artifact name is the file name: `GTNH-daily-<YYYY-MM-DD>+<run_number>-server-java8.zip` or
  `...-server-java17-26.zip`.
- **Retention**: the default of 90 days applies
  ([docs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/remove-workflow-artifacts)). Observed
  `expires_at` = created + 90 days (2027-01-02 for run 772). `daily-build-bundle` uses `retention-days: 1`.
- **The browser link** `https://github.com/<o>/<r>/actions/runs/<run>/artifacts/<id>` only works with a github.com
  session cookie. The hub can read `<id>` from it and call the API instead.

## 3. downloads.gtnewhorizons.com

- A Cloudflare R2 public bucket (the 404 page links Cloudflare's R2 public-bucket docs). `/`, `/ServerPacks/` and
  `/index.html` all return 404, so **there is no listing**. Get the URLs from `versions.json`
  (`server.java8Url`, `server.java17_2XUrl`).
- No auth. Observed `200`, `accept-ranges: bytes`, `206` for `Range: bytes=0-99`, and a stable multipart `ETag`.
  The URLs have no expiry. The oldest pack listed (2.8.0-rc-2, uploaded 2026-02-14) still downloads.
- Not wrapped: `GT_New_Horizons_2.8.4_Server_Java_17-25.zip` starts with `mods/...`.
- The hub's current `fetchDownload` already handles these. Only resume is missing.

## What the hub needs (input for #126)

`fetchDownload` (`hub/src/packs.ts`) today is a plain `fetch(url, { redirect: 'follow' })`, with no headers and no
resume. To cover all three sources:

1. **Auth for the API host only.** Send `Authorization: Bearer $GITHUB_TOKEN` (and `X-GitHub-Api-Version`) only when
   the URL's host is `api.github.com`. Node 26's `fetch` follows the 302 to Azure (undici drops `Authorization` on a
   cross-origin redirect; observed: 206 from the blob). Release assets and
   downloads.gtnewhorizons.com need no token.
2. **Resume.** Keep the partial file. When retrying, request the API URL again to get a fresh blob URL, then send
   `Range: bytes=<have>-` and `If-Range: <etag>`. If the answer is 200 instead of 206, start over.
3. **Accept artifact links.** Turn `github.com/<o>/<r>/actions/runs/<run>/artifacts/<id>` into
   `api.github.com/repos/<o>/<r>/actions/artifacts/<id>/zip`, and treat a 410 as "expired".
4. **Optional checks**: compare `size_in_bytes` and `digest` (sha256) from the artifact listing with the download.
   Reject a zip that only holds one inner `.zip`, or unwrap it.

`integrations.github` (`hub/src/config.ts`) is only `repo`, `newerAfterDays` and `deploys`, and its token is
scoped to orrery's own repo. Downloading packs needs nothing new in it beyond that same token. GTNH's repos are
public, so the token's built-in public read access covers them.

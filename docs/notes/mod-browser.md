# Game tab: two fixes and a mod browser

Status: design, not built. Date: 2026-11-01. Based on `main` at `48f5a05` (production: `hub-v2.15.0`, `web-v0.13.0`,
`agent-v1.1.1`); file and line references are at that commit.

The owner asked for three things on a factorio server's Game tab (`web/src/app/servers/game.ts`):

1. The Factorio version picker says "2.1.24 · experimental (running)". factorio.com lists 2.1.24 as both stable and
   experimental, so it must say stable.
2. After adding Squeak Through 2 (`squeak-through-2` 0.2.1), the sheet still says "What changes: Nothing yet." and
   Update… stays disabled. Is that a bug?
3. A visual mod browser on the mod portal: search, categories, sort, thumbnails, summaries, download counts, only
   mods that fit the Factorio line, and Add, which puts a mod in the update with its dependencies (portal mod packs
   too).

Contents: [Fix 1](#fix-1-a-release-on-both-channels-is-stable), [Finding 2](#finding-2-nothing-yet-is-right),
[The mod browser](#the-mod-browser) (what the portal offers, UX, hub routes, trust, tests, release order, docs, out
of scope).

---

## Fix 1: a release on both channels is stable

**Cause (reproduced).** The hub is right. `FactorioCatalog.releases()` (`hub/src/factorio.ts:142-144`) pushes one row
per channel. `factorio.com/api/latest-releases` currently has headless 2.1.24 under both `stable` and `experimental`,
so the catalog answers `[{2.1.24, stable}, {2.1.24, experimental}]`. The dashboard's `versions()`
(`web/src/app/servers/game.ts:248-255`) is wrong. Its line 253 runs for every channel entry with the running version:

```ts
else if (v.version === running) list[0] = { version: running, label: `${running} · ${v.channel} (running)` };
```

So the experimental entry, which comes second, overwrites the stable label. When the duplicate version is not the
running one, the first entry wins and reads stable, but only because of the order. A spec with the real component and
that catalog answer renders exactly `['2.1.24 · experimental (running)']`.

**Fix in the dashboard (required).** This is the fix that ships the result: the dashboard deploys on its own, and
`hub-v2.15.0` keeps sending the duplicate. Keep each entry's `channel` (null for the running one before the catalog
answers) and let stable win whatever the order:

```ts
// factorio.com can list one release as both stable and experimental: it is stable.
const list: { version: string; channel: FactorioRelease['channel'] | null }[] = running ? [{ version: running, channel: null }] : [];
for (const v of answer.versions) {
  const at = list.findIndex((l) => l.version === v.version);
  if (at < 0) list.push({ version: v.version, channel: v.channel });
  else if (list[at]!.channel === null || v.channel === 'stable') list[at] = { version: v.version, channel: v.channel };
}
// label: `${version}${channel ? ` · ${channel}` : ''}${version === running ? ' (running)' : ''}`
```

Regression tests in `web/src/app/servers/game.spec.ts`:

- versions `[{2.1.24, stable}, {2.1.24, experimental}]` with 2.1.24 running give the options `['2.1.24 · stable (running)']`;
- the same versions with 2.1.23 running give `['2.1.23 (running)', '2.1.24 · stable']`;
- the same with the order reversed (experimental first) gives the same two answers.

**Fix in the hub (included, not required).** This branch needs a hub release anyway, so the catalog stops sending the
duplicate too: in `releases()`, push a channel's release only when `out` has no row with that version yet
(`&& !out.some((r) => r.version === version)`). Stable is read first, so a release on both channels is listed once, as
stable. Update the `FactorioRelease` and `GameCatalog` comments in `hub/src/api.ts` ("the latest headless one of each
channel; one on both is listed once, as stable") and the `factorio.ts` row of `hub/CLAUDE.md`. Test in
`hub/test/factorio.test.ts`: a fake `latest-releases` with the same headless version on both channels gives
`[{ version, channel: 'stable' }]`.

## Finding 2: "Nothing yet" is right

**Not a code bug.** The screenshot is the sheet opened on a server whose Agent already reports `squeak-through-2`
0.2.1 as installed. It is a settled state, not a transient one:

- The mod's version select reads "0.2.1", not "Newest that fits (0.2.1)". `add()` always pushes
  `{ name, version: null }`; only `open()` pins the installed versions (`game.ts:349`). So the mod came from what the
  server runs, not from Add in this sheet.
- "What changes" renders only while `current()` is the catalog's answer for exactly the picks shown (it compares the
  request it asked with `JSON.stringify(request())`). It is not the checking state, which shows a spinner and no
  "What changes".
- The hub's `#plan` (`hub/src/game-updates.ts:331-339`) diffs the resolved mods against the Agent's `installed` list.
  `squeak-through-2` 0.2.1 is already in it, so `changes` is `[]`. That gives "Nothing yet." (`game.ts:193`) and
  `startWhy` "Nothing to change yet." (`game.ts:272`), so Update… stays disabled.

The real portal data for `orrery` and `squeak-through-2`, run through the real `FactorioCatalog.resolve('2.1.24',
[orrery 1.0.0, squeak-through-2 null])` against a fake fetch, resolves cleanly: `squeak-through-2` 0.2.1, releases
0.2.1 and 0.2.0, no dependency to add (`! Squeak Through` is an incompatibility, `(?) cargo-ships` optional), nothing
unresolved. Through the real component, adding it to a server without it gives the select "Newest that fits", "What
changes: Added: squeak-through-2 0.2.1" and Update enabled. Opening the sheet with it installed gives the screenshot
exactly.

**Owner's check before closing.** Production's installed list wasn't read. The Game tab's summary card should show
the chip "squeak-through-2 0.2.1" under Installed, and the update history should hold a row with "Added:
squeak-through-2 0.2.1". With no such row, the mod got onto the server outside orrery; the Agent reports Factorio's
enabled mods either way. Most likely the earlier update succeeded and the sheet was opened again afterwards.

**Change: wording only, both places together.**

- `game.ts:193`: "Nothing yet." becomes "Nothing: the server runs these already. Add a mod or pick other versions."
- `game.ts:272`: "Nothing to change yet." becomes "Nothing to change: the server runs these already."
- `game.spec.ts:207-209` expect the new strings.

The mod browser removes the rest of the confusion: its cards tell **Installed** (the server runs it) apart from
**Added** (in this update, not on the server yet) and **Add** (see [Card states](#card-states)).

---

## The mod browser

### What the portal offers (checked 2026-11-01 with read-only GETs)

- `GET https://mods.factorio.com/api/mods?page_size=max&version=2.1&hide_deprecated=true` answers every mod with a
  release for Factorio 2.1, deprecated ones left out (`version=` drops them already; `hide_deprecated` is said for
  clarity), with `latest_release` rewritten to the newest 2.1 release. That is 5771 rows, 3.7 MB (1.1 MB gzipped), in
  0.8 to 3.4 s. Every row passes `validName`. Without `version`, the list is 24549 mods and 14.7 MB.
- Rows hold `name`, `title`, `owner`, `summary`, `downloads_count`, `category`, `score`, `requires_space_age`
  (true or null) and `latest_release` (`version`, `released_at`, `feature_flags`, `info_json.factorio_version`; no
  dependencies). No thumbnail, tags, images or description.
- The list API has no search: `q`, `query`, `search`, `category` and `tag` are silently ignored, and `sort` works only
  for `name`, `created_at` and `updated_at` (`downloads_count` and `score` are ignored). `GET /api/search` is 405
  (POST only, undocumented). The site's own search is server-rendered HTML. So the hub fetches the line's whole list
  once and searches, filters, sorts and pages it itself.
- `GET /api/categories` gives `[[id, title, description], …]`: content, overhaul, tweaks, utilities, scenarios,
  mod-packs, localizations, internal, no-category. There is no JSON list of tags (`/api/tags` is 404).
- A thumbnail is only in `GET /api/mods/<name>` (the short page, 0.4 to 133 KB, as it holds every release): a
  relative path like `/assets/<40 hex>.thumb.png`, served by `https://assets-mod.factorio.com` (the same path on
  `mods.factorio.com` is 404), content-addressed, PNG, 288×288, 6.5 to 147 KB in the sample; absent or null when the
  mod has none.
- Every API answer sends `cache-control: max-age=900, public`. No rate-limit headers; 15 quick requests all got 200.
- Portal mod packs are ordinary mods in the category `mod-packs` (73 for 2.1). Their releases' required dependencies
  are their mods, so the hub's resolver already adds them transitively when one is added (for example
  `space-exploration-official-modpack` has 9). Optional (`?`, `(?)`) dependencies are not added; `!` marks an
  incompatibility.

"Mod pack" here is only the portal's category name. It is never a **Pack** (`CONTEXT.md`: a Minecraft server's base
content), and no new glossary term is added: the dashboard shows the portal's own category title as a badge.

### UX: a Browse view in the update sheet

The Update game sheet gets a second view. Everything else in the sheet stays as it is.

**Entry.** Under the "Add by name" form, a ghost button "Browse the mod portal" (`lucideSearch`). It swaps the sheet's
body to the Browse view; the header reads "Browse mods" with a Back button (`lucideArrowLeft`, `aria-label="Back to
the update"`). Focus moves to the search box. Back (and Escape is still the sheet's close) returns to the update view
with focus on the Browse button. The picks, the catalog answer and the scroll position of the update view are kept:
both views read the same signals.

**Width.** The sheet keeps its width (`sm:max-w-md`, full screen on a phone). Results are one column of rows, which
fits that width and a phone alike. No widening, so no layout jump between the views.

**Filters (top of the view, not sticky).**

- Search: `hlmInput`, `type="search"`, `aria-label="Search the mod portal"`, placeholder "Search by name, title or
  summary". Debounced 300 ms; each new query drops the older request (`switchMap`).
- Category: a native `<select>` like the sheet's others, `aria-label="Category"`, "All categories" plus the
  categories from the hub's answer (their portal titles).
- Sort: a native `<select>`, `aria-label="Sort by"`: Most downloaded (default), Recently updated, Name.
- A muted line under them: "Mods for Factorio 2.1, deprecated ones hidden." The line comes from the version picked in
  the update view (`factorio()`), not the running one, so browsing for another line works.
- On a phone the search box is full width and the two selects share the next row.

Any change of query, category or sort starts again at page 1.

**Result rows (`<ul aria-label="Mods on the portal">`).** Each `<li>`:

- Thumbnail, 56×56, rounded, `<img loading="lazy" decoding="async" width="56" height="56" alt="">` from the hub's
  proxy (`/api/servers/<id>/game/mods/<name>/thumbnail`, the name `encodeURIComponent`'d). On `error` (404 or any
  failure) the image is replaced by a muted square with `lucidePackage`. The alt is empty: the title next to it is the
  text.
- Title as an `<h3>` (truncated to 2 lines, `line-clamp-2`), then a muted line: "by <owner> · 1.1M downloads · 0.2.1"
  (downloads as `Intl.NumberFormat(undefined, { notation: 'compact' })`, the full number in a `title`; the version is
  the newest release for the line).
- Summary, `line-clamp-3`, muted, plain text.
- Badges (`hlmBadge`, outline): "Mod pack" for the category `mod-packs`, "Space Age" when `requires_space_age`.
- Actions: the Add button (see below) and an icon link to the portal page, `lucideExternalLink`,
  `aria-label="<title> on the mod portal"`, `target="_blank" rel="noopener noreferrer"`, `href` the hub's `page`.

#### Card states

| State | When | Button |
|---|---|---|
| Installed | the name is in `installed.mods` and in the picks | outline, disabled, `lucideCheck` "Installed" |
| Added | in the picks, not installed | outline, disabled, `lucideCheck` "Added" |
| Required by X | a dependency the catalog added (`requiredBy`) | outline, disabled, "Required by X" |
| Removed | installed but taken out of the picks | "Add back" (same action as Add) |
| Add | none of these | `lucidePlus` "Add", `aria-label="Add <title>"` |

The state is always said in words, never by colour alone. Add calls the same path as Add by name (pushes
`{ name, version: null }` and asks the catalog again through `#ask()`); there is no second pipeline. The game's own
mods (`GAME_MODS`) never show: the portal doesn't list them, and the dashboard filters them anyway.

**Footer (sticky at the bottom of the Browse view).** "N changes" from `current()?.changes.length` (or "Checking with
the mod portal…" with a spinner while the catalog answers, or "A dependency can't be met" in red when `unresolved` is
not empty), and a primary button "Review the update" that goes back to the update view. Adding a mod pack shows the
count jump as its dependencies arrive, which is the visible answer to "does it add dependencies".

**Paging.** 24 rows a page. Under the list, "Showing 48 of 5,771" and a "Load more" outline button that appends the
next page (spinner and disabled while it loads; gone once every row is shown). Focus stays on the button. A failed
"Load more" keeps the rows shown and puts the error line above the button with Retry.

**States.**

- Loading (page 1): six skeleton rows (`hlm-skeleton`: square, two lines). The first load of a line can take a few
  seconds (the hub fetches the whole list); later ones are from the hub's cache.
- Empty: "No mods for Factorio 2.1 match "<query>"." with a "Clear search" link button; with a category too, "in
  <category>".
- Error: a red line with the hub's message ("The mod portal can't be read: timed out.") and a Retry button. A 404 from
  a hub without the route says "This hub has no mod browser yet: deploy `hub-v2.16.0` or later." (the dashboard can
  run ahead of the hub).
- The result count ("Showing 24 of 312") sits in an `aria-live="polite"` region, so a screen reader hears the
  outcome of each search.

**Accessibility.** Labelled controls, native selects, real buttons and links, a heading per row, state in words, the
live count, focus moved on entering and leaving the view. Images decorative (`alt=""`). The keyboard order is filters,
then each row's Add and link, then Load more, then the footer.

### Hub: routes, catalog and limits

Both routes are reads and live in `web.ts`'s `if (gameUpdates)` block with the other game routes, so they answer for a
stopped server too (GETs never reach the online check). Both need a session, like every `/api` route; both are 404
for a server `GameUpdates.has` refuses. They go through `GameUpdates` (a hub-core module the frontends may call),
which delegates to the catalog; its `catalog` dependency becomes
`Pick<FactorioCatalog, 'releases' | 'resolve' | 'sha256' | 'download' | 'link' | 'browse' | 'thumbnail'>`.

#### `GET /api/servers/:id/game/mods`

Query parameters, each checked (400 with the reason). Their shape is checked before any portal read; `category` is
then checked again against the categories answer (cached), and an unknown id is 400 too:

| Param | Rule | Default |
|---|---|---|
| `factorio` | required, `VERSION` (`^\d+\.\d+\.\d+$`); the hub takes its line (`lineOf`) | none: 400 |
| `q` | trimmed, at most 100 characters | empty |
| `category` | empty, or `^[a-z0-9-]{1,32}$` and one of the ids from `/api/categories` | empty |
| `sort` | `downloads`, `updated` or `name` | `downloads` |
| `page` | integer 1 to 1000 | 1 |

The page size is fixed at 24 (`BROWSE_PAGE`): not a parameter, so nobody asks for 5000 rows. A page past the end
answers an empty `mods` with the right `total`.

Answer types in `hub/src/api.ts`:

```ts
/** How the mod browser sorts: most downloaded first, newest release first, or by name. */
export type PortalSort = 'downloads' | 'updated' | 'name';
/** A portal category: its id (`mod-packs`) and title ("Mod packs"). */
export type PortalCategory = { id: string; title: string };
/**
 * A mod on the portal as the browser shows it: name, title, owner, summary (plain text, cut), downloads, its newest
 * release for the line (`version`, `updated` epoch ms or null), category id or null, whether it needs Space Age, and
 * its portal page (built by the hub).
 */
export type PortalListing = {
  name: string; title: string; owner: string; summary: string; downloads: number;
  version: string; updated: number | null; category: string | null; spaceAge: boolean; page: string;
};
/**
 * `GET /api/servers/:id/game/mods?factorio=&q=&category=&sort=&page=`: one page (24) of the portal's mods for the
 * Factorio version's line, deprecated ones left out, with how many match and the categories to filter by.
 * 400 for a bad parameter, 502 if the portal can't be read.
 */
export type ModBrowse = { line: string; total: number; mods: PortalListing[]; categories: PortalCategory[] };
```

(`PortalMod` is already an internal type in `factorio.ts`, hence `PortalListing`.)

`FactorioCatalog.browse(line, { q, category, sort, page })`:

- Reads `https://mods.factorio.com/api/mods?page_size=max&version=<line>&hide_deprecated=true` and
  `https://mods.factorio.com/api/categories` in parallel, through the existing public read (`#text`: https only,
  `PUBLIC_HOSTS`, at most 3 redirects each checked first, 15 s timeout, no account).
- Caps: the list `CAPS.list` = 16 MiB (decompressed bytes counted while reading, as `#text` does; its
  `content-length` pre-check sees the compressed size, which is smaller, so the real limit is the body count), the
  categories `CAPS.latest` (64 KiB). `CAPS.mod` (4 MiB) is too tight for a list that is 3.7 MB and growing.
- Caching: `#cached` takes a time to live per key (today one `CACHE_MS` for all). The list is kept 15 minutes
  (`max-age=900`), the categories 6 hours. It caches the **parsed slim rows**, never the raw text, so the 3.7 MB
  string is dropped once parsed (5771 slim rows are well under 2 MB in memory). One promise in flight per key, as now;
  a failed read isn't kept. Only the two newest lines are kept, so a different `factorio` can't grow memory.
- Each row is checked and made slim; a row that fails is dropped, never passed on:
  - `name` passes `validName`; `latest_release.version` passes `VERSION` and its `info_json.factorio_version` equals
    the line (no newest release for the line: nothing to add, dropped);
  - `title`: string, control characters removed, trimmed, cut to `TITLE_MAX` (200; the longest seen is 277), else the
    name;
  - `owner`: string, control characters removed, cut to 64, else "";
  - `summary`: string, `\r` and other control characters removed (newlines become spaces), runs of spaces collapsed,
    cut to 500 characters with "…", else "";
  - `downloads_count`: a finite number at least 0, else 0;
  - `released_at`: `Date.parse` finite, else null;
  - `category`: one of the category ids, else null; `requires_space_age === true`;
  - `page`: `https://mods.factorio.com/mod/` + `encodeURIComponent(name)`.
  - At most 50 000 rows are read; past that the answer is refused (502), as the portal changed shape.
- Categories: each `[id, title]` with `id` matching `^[a-z0-9-]{1,32}$` and a title cut to 64; others dropped.
- Search, in memory on the slim rows: the query lowercased and split on spaces; a row matches when every word is in
  its name, title or summary (lowercased). Then the category filter. Sort by the chosen key (ties by name); with a
  query, a row whose name or title equals it (case aside) comes first. Then the page.

`score` is not used: the portal ignores `sort=score`, its meaning is unknown, and its top values are obscure
cargo-ships submods while `flib` (1.08 M downloads) scores 175. So there is no "Trending" sort. The site's own
relevance ranking is not reproducible from the API either; name and title matches first is the stand-in.

#### `GET /api/servers/:id/game/mods/:name/thumbnail`

A proxy, not a direct `<img>` to the CDN, because:

- the hub is the only thing that talks to factorio.com and its hosts, and that rule is not weakened;
- a later CSP can then say `img-src 'self'`;
- the owner's IP and the dashboard's URL (as Referer) don't go to the CDN.

How:

- `:name` must pass `validName`, else 404. It needn't be in the cached list: any portal mod name is fine, the route is
  admin-only, and the portal says if it doesn't exist.
- The name's thumbnail path comes from `GET https://mods.factorio.com/api/mods/<name>` (the short page) through
  `#text`, capped 512 KiB, cached 6 hours by name (at most 10 000 names, cleared when full). A 404, a page over the
  cap, a page that names another mod, or a missing, null or malformed `thumbnail` all mean "no thumbnail": 404. The
  path must match `^/assets/[0-9a-f]{40}\.thumb\.png$`.
- The image is read from `https://assets-mod.factorio.com<path>` by its own request, with its own one-host pin
  (`THUMBS = 'assets-mod.factorio.com'`). It is **not** added to `PUBLIC_HOSTS`, which stays the JSON allowlist.
  `redirect: 'manual'` and nothing followed: any 3xx is 502. Upstream `content-type` must be `image/png` and the body
  must start with the PNG signature `89 50 4E 47 0D 0A 1A 0A`; capped 512 KiB (the largest seen is 147 KB); 15 s
  timeout; no account.
- `#text` becomes `#read` (a `Buffer`, same checks and caps) with `#text` on top of it, so the image read reuses the
  cap and timeout code.
- An in-memory LRU of the images keyed by the sha1 in the path, 100 entries (at most 50 MiB at the cap, about 5 MB
  at typical sizes); content-addressed, so never stale.
- At most 4 portal reads for thumbnails at once (a small queue in the catalog): a page of 24 rows is 24 short pages
  and 24 images, and the portal should not see bursts of 48.
- Answer: `200`, `content-type: image/png`, `x-content-type-options: nosniff`,
  `cache-control: private, max-age=86400`. Not `immutable`: the URL is by name, and a mod can change its thumbnail.
  The route has its own handler (`c.body(bytes, 200, headers)`), as the `game()` helper answers JSON only. 404 (no
  thumbnail) answers `cache-control: private, max-age=3600`; 502 (the portal failed) is not cached.
- A same-origin `<img>` sends the session cookie, so the route stays behind the session.

### Trust rules

- Everything from the portal is untrusted, as for game updates today: names pass `validName`, versions `VERSION`, every
  string is cut and stripped of control characters, numbers checked finite, categories against the portal's own list,
  answers size-capped and timed out, reads https only on allowlisted hosts, redirects checked before they are
  followed (the image read follows none).
- The dashboard renders every portal string as text (Angular interpolation), never `innerHTML` and never markdown.
  The summary is plain text from the hub; the description (markdown) is never fetched.
- Every URL the dashboard follows to the portal is built by the hub (`page`, from a checked name). Images come only
  from the hub's own route, which serves only a checked PNG with `nosniff`.
- Adding a mod from the browser is the same pick as Add by name: the update itself still goes through `catalog` and
  `update`, which check everything again, and the Agent checks names, versions and hashes once more. The browser adds
  no new way for a portal string to reach the Agent.

### Tests to write

No test touches the network: the catalog's tests and the whole-hub tests use the injected `PortalFetch`, and the
dashboard's use `HttpTestingController`.

`hub/test/factorio.test.ts`:

- a release on both channels is listed once, as stable ([Fix 1](#fix-1-a-release-on-both-channels-is-stable));
- `browse` asks `/api/mods?page_size=max&version=2.1&hide_deprecated=true` and `/api/categories`; a second call
  within 15 minutes reads neither again, and two at once share one read; after 15 minutes it reads again; a third
  line drops the oldest;
- rows with a bad name, no version, a version that isn't `VERSION` or a release for another line are dropped; a
  299-character title is cut to 200; a summary with `\r\n` and control characters comes out plain and cut to 500; an
  unknown category is null; `downloads_count` `"many"` is 0; `page` is the encoded portal URL;
- search: every word must match name, title or summary, case aside; the category filter; each sort; an exact name
  match first; page 2 holds rows 25 to 48, and `total` counts every match;
- a list over 16 MiB, a timeout and a redirect off `PUBLIC_HOSTS` are 502, with no URL in the message;
- `thumbnail`: the short page's path is fetched from `assets-mod.factorio.com` only; a path not matching the pattern,
  a missing thumbnail and an unknown mod give null (404); a redirect, a `content-type` other than `image/png`, a body
  without the PNG signature and an image over 512 KiB are 502; a second call for the same sha1 makes no request; no
  more than 4 reads run at once.

`hub/test/game-updates.test.ts` (whole hub through `test/fake-agent.ts`, whose fake `portal` gains the list, the
categories, a short page and an image) or `start.test.ts`:

- `GET /api/servers/factorio/game/mods` without a session is 401; for a Minecraft server 404; 400 for no `factorio`,
  a `q` over 100 characters, an unknown `sort` or `category`, `page=0` and `page=x`; a good one answers `ModBrowse`;
- the thumbnail route answers `image/png` with `nosniff` and `private, max-age=86400`; 404 for a name that fails
  `validName` or a mod without a thumbnail; the bytes are the fake image's.

`web/src/app/servers/game.spec.ts`:

- Fix 1's three cases, and Finding 2's new wording;
- Browse opens from the sheet, focuses the search box, and asks `…/game/mods?factorio=<picked version>&sort=downloads&page=1`;
  Back returns to the update view with the picks unchanged;
- typing asks once after the debounce, and an older answer arriving late is dropped; a category or sort change asks
  page 1 again;
- a row shows the title as text (a title holding `<b>x</b>` shows those characters), the owner, a compact download
  count, the version, the "Mod pack" and "Space Age" badges, and a portal link with `rel="noopener noreferrer"`;
- Add puts `{ name, version: null }` in the picks and asks the catalog; the row then says Added; an installed mod says
  Installed, a dependency "Required by X", a removed installed one "Add back";
- the footer counts the catalog's changes;
- Load more asks page 2 and appends; it is gone when every row is shown;
- a thumbnail's `error` shows the placeholder;
- skeletons while page 1 loads, the empty state with Clear search, the error with Retry, and the 404 line naming the
  hub release.

### Release and deploy order

1. Build on `fa/mod-browser`; verify as `CLAUDE.md` says (hub and web tests, typecheck, build).
2. Release the hub (`hub-v2.16.0`, minor: new routes) and deploy it.
3. Release the dashboard (`web-v0.14.0`) and deploy it. Fix 1 and the wording ship in it; against `hub-v2.15.0` the
   version label is already right, and Browse says which hub it needs.
4. Smoke on production: the picker says "2.1.24 · stable (running)"; browse 2.1, search "squeak", see the thumbnail;
   add a portal mod pack in a scratch sheet and watch its dependencies arrive; close the sheet without updating.

No Agent, mod or protocol change.

### Docs to update with the code

- `hub/CLAUDE.md`: the `factorio.ts` row (`browse`, `thumbnail`, the per-key cache times, `CAPS.list`, the
  `assets-mod.factorio.com` pin, the release on both channels), the `game-updates.ts` row (`browse`, `thumbnail`
  pass-throughs) and the `web.ts` row (the two GETs); the Trust boundaries' Game updates bullet (the thumbnail host pin,
  PNG check, no redirect).
- `web/CLAUDE.md`: the `src/app/servers/` row's `game.ts` part (the Browse view).
- `hub/src/api.ts` comments as above; `docs/ROADMAP.md`: a line for this work linking this note.

### Out of scope

- `POST /api/search` (undocumented) and scraping the site's HTML search.
- A "Trending" sort (`score` is unexplained and the API ignores sorting by it).
- Tags (no JSON list), descriptions, changelogs, image galleries and a per-mod detail view.
- Suggesting optional dependencies.
- Removing a mod or picking its version from the Browse view (the update view does that).
- A thumbnail cache on disk, and thumbnails in the update view's mod list.
- A Content-Security-Policy header. None exists today (`deploy/Caddyfile` has no `header` for the dashboard's sites,
  `web/src/index.html` no meta). With the proxy in place, `default-src 'self'; img-src 'self' data:` is a possible
  follow-up for the Caddyfile.
- Browsing from Discord.

# Status page: a public page for players

Status: hub built (branch `status-page-hub`, step 3 of the build order), dashboard and Caddy not yet. Date: 2026-11-05. Based on `main` at `81a05f8` (production: `hub-v2.19.1`,
`web-v0.17.0`, `agent-v1.3.0`; cut and not deployed: `hub-v2.20.0`, `web-v0.18.0`, `agent-v1.4.0`, `web-v0.19.0`).
File and line references are at that commit.

The owner asked for a public page where players can see the servers without logging in. Owner decisions
(2026-11-05):

- **Address:** `status.orrery.run`, a Caddy site of its own, not a route on `dash.orrery.run`.
- **What it shows:** each listed server's name, game, state, the number of players online **and their names**,
  and uptime. No join address, no version, nothing else. A factorio server's game password is never shown.

Contents: [What the page shows](#what-the-page-shows), [Hub](#hub), [Dashboard](#dashboard),
[Caddy and DNS](#caddy-and-dns), [Trust rules](#trust-rules), [Tests to write](#tests-to-write),
[Build order](#build-order), [Release and deploy](#release-and-deploy), [Docs to update](#docs-to-update),
[Out of scope](#out-of-scope).

---

## What the page shows

One card per listed server, in config order, with the orrery logo and "orrery" at the top:

| Field | Source | Shown as |
|---|---|---|
| Name | the server's config `name` | the card's title |
| Game | `game` | "Minecraft" / "Factorio" under the name |
| State | `online`, `hung`, `paused` (as on `ServerCard`) | **Up**, **Up · paused** (factorio, nobody on), **Not responding** (hung), **Down** |
| Players | `players` (game names, never Discord names or links) | "3 online" and the names; "Nobody on" |
| Uptime | `Db.uptime(id, from, to)` over 7 and 30 days | "99.2% this week · 98.7% this month"; left out while unknown |

A line at the bottom says when the page last heard from the hub ("Updated 12 s ago"). The page polls every 30 s
and never opens the event stream. If the hub doesn't answer (Caddy's 502, or no network), the cards stay greyed out
under one line: "Can't reach orrery right now." That is a true status too: the hub being down is the news.

## Hub

### Config

A new optional section, `integrations.web.status`:

```json
"web": {
  "status": { "servers": ["gtnh", "factorio"] }
}
```

- The section switches the page on (ADR 0002: an integration's parts are switched on by their section). Without it,
  `/api/public/status` is not registered, so it falls to the session check like any unknown path: 401 logged out
  (404 with a session). The Status page then says "Can't reach orrery right now".
- `servers` lists which servers appear, in order. A server is **never** public by default: one added later (a Pack
  install) stays off the page until its id is listed. `check-config` refuses an unknown id, a duplicate, or an empty
  list.
- This is a part of the web integration, not an integration of its own: it needs the web port. ADR 0002 stands.

### Route

`GET /api/public/status`, in a new module `hub/src/web/web-public.ts` (`publicRoutes(app, deps)`), registered next to
`/environment` (`web.ts:260`), so **before** the session middleware (`web.ts:316`) and the CSRF check: no cookie is
read and none is needed. It answers a new type in `hub/src/api.ts`:

```ts
/** `GET /api/public/status`, with no session: only the servers listed in `integrations.web.status`. */
export type PublicStatus = { servers: PublicServer[] };
export type PublicServer = {
  name: string;
  game: Game;
  state: 'up' | 'paused' | 'hung' | 'down';
  players: string[];
  /** Share of the last 7 and 30 days the server was up (0–1), null while unknown. */
  uptimeWeek: number | null;
  uptimeMonth: number | null;
};
```

- Built by picking fields one by one from `ServerHub` and `Stats`, never by spreading a `ServerCard`: a field added to
  the card later stays private until someone adds it here on purpose. No server `id` either (nothing needs it).
- `Cache-Control: public, max-age=15`, and the hub keeps the last answer for 15 s, so the page left open on a hundred
  phones costs one uptime query per 15 s. Uptime over 30 days reads the never-pruned uptime log; check its cost on
  the production `hub.db` while building and keep the 15 s memo either way.
- The header comments of `web.ts` ("`/environment` … the one read without a session") and `api.ts` change to name the
  second one.

`web.ts` is 816 lines and not exempt: the file-length gate fails if it grows. See [Build order](#build-order).

## Dashboard

The page is part of the dashboard's build (one build, one deploy), not a second app:

- A lazy route `status` → `web/src/app/public/status.ts` (new folder `app/public/` with its `CLAUDE.md`), using
  `Logo`, `status.ts`'s colours, and a 30 s poll of `/api/public/status` with `HttpClient`.
- The shell (`app.ts`) shows a public route **alone**: no sidebar, no login card. On `status.orrery.run` every
  `/api/*` but `/api/public/*` is 404, so the public route must send **no request but `/api/public/status`**. Today
  the shell asks for the session (`session.ts`, `/api/me`) and the environment (`environment.ts`,
  `/api/environment`, for the staging badge and the tab title) at start, and `Integrations`, `Attention` and
  `LiveEvents` fetch once logged in. The build makes the public check come first (route data `public: true`, read from
  the router) and creates none of those services on a public route: the tab title there is plain "orrery".
- The public route sends one request, `/api/public/status`, which answers 401 when the hub has no
  `integrations.web.status` or is older than this release (an unknown path falls to the session check). The
  `loggedOutOn401` interceptor must skip it, or it would call `Session.lost()` on the public page: a 401 there is
  "Can't reach orrery right now", nothing more.
- Phone first: the cards stack; the page is light or dark from the system setting (no Theme menu there).

## Caddy and DNS

A new site in `deploy/Caddyfile`:

```caddy
status.orrery.run {
	# Only the public read reaches the hub from here: no login, no event stream, no actions.
	handle /api/public/* {
		reverse_proxy 127.0.0.1:25581
	}
	handle /api/* {
		respond 404
	}
	redir / /status
	handle {
		root * /var/www/orrery
		try_files {path} /index.html
		file_server
	}
}
```

- It serves the same `/var/www/orrery` as the dashboard, so `deploy-web.sh` needs no change.
- The session cookie is host-only on `dash.orrery.run` (`COOKIE` sets no `Domain`), so a browser never sends it to
  `status.orrery.run`. Keep it that way.
- By hand, once: a DNS record for `status.orrery.run` pointing at the host, the new Caddyfile, `systemctl reload caddy`.
- Staging gets no status site.

## Trust rules

- `PublicServer` holds only the six fields above. Nothing from `agents[]` (`address` is the friend's tailnet IP),
  `config.json` tokens, paths, Discord IDs or linked names, service names, Host figures, or a factorio server's
  settings ever goes in. Before the PR, grep the type and the route for `address`, `token`, `dir`, `discord`,
  `service`, `password`.
- Player names are public by the owner's choice (2026-11-05). Linked Discord names are not: a player is shown by the
  name they play under.
- The route is read-only and takes no input: no query string is read, so nothing to validate and nothing to inject.

## Tests to write

Hub: a new `hub/test/web/public.test.ts`, starting the hub through `startHub` as `test/start.test.ts` does today
(the web API's tests live there; it is 116 KB and must not grow, so move the helpers this needs into a shared
fixture file first, as a pure move):

- With the section: 200 without a cookie; only the listed servers, in config order; each object's keys are exactly the
  six fields (a key-set assertion, so a new field fails the test); state for online, paused, hung and offline servers.
- Without the section: 401 without a session (as any unknown path).
- `Cache-Control` is set; two calls within 15 s read uptime once (a counting fake `Stats`).
- The CSRF and session checks still guard everything else (an existing route still answers 401 without a cookie).
- `check-config`: unknown id, duplicate id, empty list, `status` without `web`.

Dashboard (`web/src/app/public/status.spec.ts`):

- Renders each state and the player names; a failed fetch shows "Can't reach orrery right now".
- The shell on `/status`: no request but `/api/public/status` (`HttpTestingController.verify()` after it renders),
  no login card, no sidebar.

## Build order

1. **Pure move, its own commit** (no behaviour change): take the login, callback, session and CSRF block out of
   `web.ts` into `hub/src/web/auth.ts`, with the tests unchanged and green. `web.ts` shrinks, and the Android app's
   bearer sessions (`docs/notes/android-app.md`) change that module, not `web.ts`.
2. Hub: config section and `check-config`, `PublicStatus` types, `web-public.ts` and one registration line in
   `web.ts`, tests.
3. Dashboard: the public shell path, `app/public/status.ts`, tests.
4. `deploy/Caddyfile`.

## Release and deploy

- Cut `hub-v2.21.0`, deploy it, add `integrations.web.status` to production's `config.json`, restart the hub; then
  `web-v0.20.0` and deploy it; then by hand: the DNS record and the Caddyfile.
- An older dashboard on a newer hub: nothing changes (the route is new). A newer dashboard on an older hub: the page
  says "Can't reach orrery right now" (401, as for any unknown path). Deploy the hub first.
- Smoke on production: open `https://status.orrery.run` logged out on a phone; `/` redirects to `/status` (and only `/`: `/status` itself and
  an unknown path serve the page, not a loop); the cards
  match the dashboard; `https://status.orrery.run/api/servers` is 404; stop a server and see **Down** within 45 s.

## Docs to update

`docs/ROADMAP.md` (its section), `CONTEXT.md` (**Status page**: the public page on `status.orrery.run`, listed servers
only; _Avoid_ "status" alone, which is Discord's `/status` and `StatusAnswer`), `hub/src/web/CLAUDE.md`,
`web/CLAUDE.md` (the public route and the shell rule), `deploy/CLAUDE.md` (the new site), the header comments named
above.

## Out of scope

- Join address, version and pack, MOTD, a "how to join" text (possible later as more `PublicServer` fields, each an
  owner decision).
- Live updates over the event stream: it carries chat and admin-only notices.
- History graphs, player counts over time, a status page for services, checks or Hosts.
- An incident or maintenance message.

# hub (orrery-hub)

Node 24+ (tested on 24.21 and 26.9) + TypeScript + discord.js 14. Node runs `.ts` directly (type stripping) — there is no build step.

```bash
npm test            # node --test "test/*.test.ts"
npm run typecheck   # tsc, noEmit
npm run check-config   # validates ./config.json (or -- <path>) offline; same rules as startup
npm start           # node src/index.ts; reads ./config.json (or argv[2]), env DISCORD_TOKEN (only with integrations.discord)
                    # and DISCORD_CLIENT_SECRET (only with integrations.web), GITHUB_TOKEN (with integrations.github; also lets the library fetch Actions artifacts),
                    # FACTORIO_USERNAME and FACTORIO_TOKEN (optional, for game updates' mod links; without both, a warning, and every game update is refused: each has `orrery`, a portal mod)
```

## TypeScript constraints (type stripping)

- Erasable syntax only: no `enum`, `namespace`, or constructor parameter properties.
- Relative imports include the `.ts` extension; type-only imports use `import type` / `type X`.

## Modules

`src/` keeps the wiring (`index.ts`, `start.ts`, `config.ts`, `check-config.ts`), the contract the agent and the
dashboard import (`types.ts`, `protocol.ts`, `api.ts`, `api-game-extras.ts`) and two small helpers (`daily.ts`,
`units.ts`). Everything else is in a folder per feature, named as CONTEXT.md names it, each with a CLAUDE.md saying
what its files hold: `servers/`, `agents/`, `services/`, `backups/`, `packs/`, `updates/`, `discord/`, `web/`,
`stats/`. Each file starts with a comment that says its job and its contract: read it before changing the file, and
change it with the file. `start.ts` wires them all from config, so it is the map. Tests mirror the folders under
`test/`; `test/fake-mod.ts` and `test/fake-agent.ts` serve them all.

## Dependencies

Runtime: `discord.js`, and `hono` with its Node adapter `@hono/node-server` (web integration). Prefer Node built-ins (`node:net`, `node:readline`, `node:sqlite`,
`node:test`, `node:crypto`) over adding packages.

## Trust boundaries (do not weaken)

- Mod input: every line goes through `parseModLine` (checks `Object.hasOwn` on the type, field types and every
  field's limit, and returns a copy holding only the schema's fields); Agent port input through `parseAgentLine`.
  Tokens 16–256 chars (an Agent's 32–256), compared with `timingSafeEqual`. The Mod port and the web API bind `127.0.0.1`.
- Agent port (`agents.ts`): it binds only `integrations.agents.listen` (the tailnet address); a peer that isn't a
  configured Agent's address is destroyed before a byte is read (both first lines); every line is capped at
  `LIMITS.lineBytes` and rate-limited, before and after the handshake, and each message type has its own budget per
  connection (`TYPES`; host samples one per 10 s per Agent, stored with the hub's clock; a heartbeat's names new to its
  server within `NEW_PLAYERS`), both kept across reconnects
  (never a fresh burst), and each kind of connection welcomed at most once per 5 s per Agent; its server's lifecycle
  events (each a never-pruned uptime row) at most 20 an hour (`ServerHub`, by server id, across reconnects); at most 4 connections at once
  per address, and a refused one is destroyed within 2 s; an Agent speaks only for its own `server`, and
  its game connection is accepted only while its Agent connection is up. A `reply`'s data is read only through
  `parseReplyData` for the request it answers.
- Discord → MC: `ServerHub.say` cleans text with `mcText` (strips `§` codes/control chars, caps 256); `broadcast`'s notice to an Agent too (caps 1 KiB). The hub never builds Factorio command text: the Agent does.
- MC → Discord: `md()` escapes markdown incl. headings/masked links (a milestone's text, player and force too, a Backup's name, as an Agent's saves are named in the game's folder, and every other string an Agent sends that a post or a topic shows); text mid-line in a notice's embed title (a backup's detail, a save's name, an error, a mount, a reason, a version) gets `inline()`, which escapes every inline markdown and masked links but not the line-start rules (a title renders no headings or lists); a post is cut to 2000 characters after it; the Client uses
  `allowedMentions: { parse: [] }` so nothing the bot posts can ping. A factorio player's relay webhook name is
  tagged `(Factorio)`, and one with whitespace or parentheses is posted as the bot (`relayAs`), so a name from the
  game never passes for a dashboard line or the bot; one with `discord` or `clyde` goes as the bot too, and the names
  Discord refused are kept at most 1000 (`REFUSED_KEPT`), so fresh names from an Agent can't grow the hub's memory.
- Services: only units listed in `integrations.systemd` are passed to systemctl/journalctl (validated unit names, after `--` or as `--unit=`, `execFile` without a shell); polkit (`deploy/orrery-hub.rules`) allows exactly those, except agent-backed services, which are never passed to them: their actions are the Agent's `serviceAct` on its own unit, their logs its `journal`, and they stay out of polkit's `UNITS`.
- New server: the id (`^[a-z][a-z0-9-]{0,31}$`) is the only request string that becomes a path or a unit name (`<root>/servers/<id>`, `<root>/java/<id>`, `<id>.service`, asked of systemd only with `show --property=LoadState --`, the one call on an unlisted unit); the start script must be a plain `*.sh` at the pack's content root; the runtime one in the table. The Mod token is random, written only to the 0600 `orrery.cfg` and `.orrery-pending.json`, and never in an API answer; `add-server.sh` treats the pending file as untrusted.
- Server logs: `GET /api/servers/:id/logs/:name` reads only a name the hub's own listing of that server's `logs/`, `crash-reports/` and `hs_err_pid*.log` holds right now (plain files by `lstat`), never a path built from the request, and opens it `O_NOFOLLOW`; `..`, slashes, unlisted names and symlinks are 404. At most a file's last 4 MB is held. A server an Agent runs has
  no folder here: its listing is the Agent's `logs` reply, and a `log` request goes out only for a name a fresh
  listing holds (else 404); the Agent checks the name against its own listing again.
- Restore: the hub passes the restore script only a backup name it listed itself, as an argument (no shell), and only while the linked service is stopped; the script re-checks both and refuses to run as root. A server an Agent runs: only a name its Agent's latest `saves` push holds goes in its `restore` request, only while its pushed service state is inactive or failed; the Agent checks both again and copies the save as the newest, overwriting nothing.
- Deploys: GitHub is read with `GITHUB_TOKEN` (env only); only a tag GitHub listed, matching `^(hub|web|mod|agent)-v\d+\.\d+\.\d+$`, for
  its own part, ever goes into a unit name; an `agent` one only into that Agent's `deploy` request, never a unit of
  this host's, and the Agent checks it again before its own deploy unit's name. Deploy units are outside `integrations.systemd`: only
  `<configured template>@<that tag>.service`, and only `start` (plus `show` to read it). polkit's separate deploy
  block allows exactly that; the unit's script re-checks the tag (`deploy-hub.sh` also refuses to run as root;
  `deploy-web.sh` runs as root from a root-owned copy and writes the status file as the root folder's owner). A Mod jar is written
  only into a configured server's `mods/`, under a name built from the tag.
- Packs: a zip's entries are listed (`unzip -Z`, count checked) before anything is extracted, and a symlink, an absolute
  path or a `..` refuses it; `unzip` runs through `execFile`, no shell. Every path from a request (an Extra's target, an
  edit's file) is normalised, refused if absolute or with a `..`, kept inside `dir` (symlinks resolved) and outside the
  Kept paths (the Mod's jar among them); staged files are checked the same way before the swap. Extras are stored under
  their row id, so no request path is ever a path on the hub's side. Uploads are capped at 4 GiB and chunks at 64 MiB
  (bytes counted, not `content-length`); a chunk's offset must be exactly the bytes received, and upload ids are
  random and checked against `^[0-9a-f]{32}$`, so no request names a file either. A library download sends the
  GitHub token only on the API request the hub built from an Actions artifact link (a pasted `api.github.com` URL gets
  none), only to `https://api.github.com` and never on a redirect's hop, and follows only `https:` redirects. Runtime names come from Adoptium's answer and must match `^temurin-[0-9][0-9A-Za-z.+_-]*$` before they touch a path; a request's runtime name must be one in the table. Library zips are stored by sha256
  (`library/<sha256>.zip`): a pack's name and version never become a path.
- Game updates: the owner's factorio.com account (`FACTORIO_USERNAME`, `FACTORIO_TOKEN`: env only, from
  `/etc/orrery-factorio-account.env`, the hub unit's alone) is sent only on a mod's download-link request to
  `https://mods.factorio.com/download/…`, never following its redirect; only a redirect to `https://dl-mod.factorio.com`
  whose only query key is `secure` and that holds no credential reaches the Agent, which never gets the account. No
  error or log holds that request's URL. Everything from factorio.com and the portal is untrusted: names, versions,
  hashes and links pass the Agent's own checks before they are used, answers are size-capped and time out, and a
  public read follows only `https:` redirects. The mod browser's strings (titles, owners, summaries, categories) are
  plain text, cut and stripped of control characters, its numbers checked finite and its portal links built by the hub
  from a checked name; the dashboard never talks to the portal: a thumbnail comes through the hub, read only from
  `https://assets-mod.factorio.com` (its own pin, not a public read's host) by a checked `/assets/<sha1>.thumb.png`
  path, following no redirect, and served only as `image/png` with the PNG signature and `nosniff`. What an Agent says about its update (`detail`, errors, the save's
  name) is redacted before it is a step, a log line or a notice, `inline()` in a Discord notice's title (with the
  version it reported), and never a path or a command.
- Moderation: the hub never builds a Factorio command; it sends the checked `action`, a `player` by the admins' rule
  and a `reason` it refuses with any control character, separator, bidi control or BOM (the Agent cleans it again).
  The Agent's `playerLists` (container-written files) comes through `parseReplyData` and drives display only. One
  request per server at a time, 20 a minute, `playerLists` at most every 2 s, so a dashboard can't flood RCON.
- Game settings: a factorio server's game password goes from a `PUT …/settings` body into one `settingsSet` and
  nowhere else: no answer, event, audit entry, log line or error holds it (the report has only `game_password_set`),
  and the hub's refusals name the field, never the value. What the Agent reports (`settings`, `rolledBack`, its
  refusals) is untrusted: it drives display, audit text and refusals only, never a command or a path.
- `/cmd`: admin role check + `deferReply`. Every action on a server (commands via `runCommand`, restarts scheduled
  or cancelled) goes to the `audit` table with its actor: `discord:<username> (<id>)`, or `hub:<why>`
  (`hub:daily`, `hub:restart`) for the hub's own, or `web:<username> (<id>)` from the dashboard (chat from it too).
- Web: binds `127.0.0.1` (Caddy adds TLS in front). Login is Discord OAuth with a single-use `state` cookie; only
  members with the admin role get a session. Session ids are random, sent only in an httpOnly, Secure, SameSite=Lax
  cookie, stored hashed, and expire server-side. Every 10 minutes a request re-asks Discord, in the background, whether the user still has the admin role (with the access token from login, stored sealed with the cookie); losing it, or Discord refusing the token, ends the session, while Discord being down keeps it. Every `/api` route but login/callback and `/api/environment` (the Environment's name only) needs one. Every request
  but GET/HEAD (logout too) must also carry `Origin` = the public URL's origin (else 403) and a JSON content type
  (else 415): CSRF, alongside SameSite=Lax. The one exception to JSON is an upload's chunk, `PUT /api/uploads/:upload` (exactly
  that method and path), which takes only `application/octet-stream` (no cross-site form can send it); its Origin is
  checked all the same. Chat from the dashboard goes through `ServerHub.say` like Discord's. The OAuth client
  secret comes from `DISCORD_CLIENT_SECRET`, never config.

## Tests

`test/servers.test.ts` drives a real socket with a fake mod (`fakeMod`, `online`, `until` helpers in `test/fake-mod.ts`) — use it
for any hub behaviour change. `test/agents.test.ts` does the same for the Agent port: a fake Agent's two connections on real
sockets on 127.0.0.1 (an ephemeral port), the expected peer address set through the Agent's config `address`. `test/fake-agent.ts` holds a whole hub with a fake Agent on the Agent port and a fake portal (`PortalFetch`, with the mod browser's list, categories, short pages and a thumbnail), for `test/game-updates.test.ts` (game updates), `test/game-settings.test.ts` (game settings) and `test/agent-deploys.test.ts` (Agent deploys); `test/factorio.test.ts` drives the catalog on a fake portal alone. `test/start.test.ts` starts a whole hub via `startHub` with a stub frontend and a fake Discord OAuth, driving the web API through `app.request` (no port). Keep timing-sensitive tests on small `HubOptions` timeouts, not sleeps of seconds.

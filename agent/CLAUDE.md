# agent (orrery-agent)

A Node service on a remote Host. It dials out to the hub with its token and runs that Host's Factorio server: RCON,
the Factorio mod's events, the server's unit, saves, host samples, game updates and its own deploys (`update`,
`updateResume`, `updateCancel` and `deploy`, from `agent-v1.1.0` on: release 2 in `docs/ROADMAP.md`; the hub's side is
built separately against the same contract, and refuses both for an older Agent), and its game settings (`settings`
and `settingsSet`, from `agent-v1.2.0` on: `docs/notes/factorio-world-settings.md`, stage A). Node 24+ + TypeScript, run directly (type stripping, no build step) like the hub. No runtime
dependencies: Node built-ins only (game tarballs go through the Host's `xz`, which setup installs).

```bash
npm test            # node --test "test/*.test.ts"
npm run typecheck   # tsc, noEmit; also type-checks the hub types src/ imports
node src/index.ts           # the agent (orrery-agent.service)
node src/index.ts check     # the first-boot check: a report on stdout, line by line, exit 0 when nothing failed
```

On the Host it reads `/etc/orrery-agent/config.json` and, for game updates, `/etc/orrery-agent/image.json` (`{ image,
glibc }`, both written by `deploy/setup-agent-host.sh`), and the environment `ORRERY_AGENT_TOKEN` and `RCON_PASSWORD`
(root-only env files read by systemd). For tests and the local dev loop only, `ORRERY_AGENT_CONFIG` moves the config
file (and `image.json`, read from beside it) and `ORRERY_AGENT_ROOT` the agent's folder (`/srv/orrery-agent`).

## Wire contract

`docs/protocol.md` ("Agent connection") is authoritative. The message types come from `hub/src/types.ts`, through
`import type` only: a release tarball is `agent/` alone, so no runtime import may leave `agent/`. `src/wire.ts` holds
the agent's copies of `PROTOCOL_VERSION` and `LIMITS`; `test/wire.test.ts` checks them against
`hub/src/protocol.ts`, so change them together. `src/update.ts`'s `GAME_MODS` (the game's own mods, for an update's
`to`) is a copy of `hub/src/updates/factorio.ts`'s, checked by `test/update-messages.test.ts`. One line on the Agent port is at most 1 MiB (`LIMITS.lineBytes`,
set on 2026-10-31 while the owner was away: `docs/adr/0004`), its `\n` included, both ways.

The release is `agent-v` + `package.json`'s `version`, which stays `0.0.0` in the repo (like `factorio/info.json`):
the hello's `agentVersion` and the `connected` file carry it, and an agent deploy (`deploy`, run by
`deploy/deploy-agent.sh`) is `ok` only when it matches the tag: the script's gate compares the `connected` file's
`version` with the tag, and its rollback's with the release folder `current` pointed at before.

## TypeScript constraints (type stripping)

- Erasable syntax only: no `enum`, `namespace`, or constructor parameter properties.
- Relative imports include the `.ts` extension; type-only imports use `import type` / `type X`.

## Modules

Each file in `src/` starts with a comment that says its job and its contract. That comment is the file's
documentation, so read it before changing the file, and change it with the file. By area:

- Running: `index.ts` (the service, and `index.ts check`), `config.ts`, `check.ts` (the first-boot report),
  `host.ts` (host samples).
- The hub: `wire.ts` (the agent's copy of the contract), `hub.ts` (the two connections).
- The server: `service.ts` (its unit), `rcon.ts`, `status.ts`, `gate.ts` (its starts), `events.ts` (the mod's
  events), `settings.ts`, `moderation.ts`, `logs.ts`.
- Saves and files: `saves.ts`, `save-check.ts`, `files.ts`.
- Game updates and deploys: `update.ts`, `unpack.ts`, `deploy.ts`.

## Trust boundaries (do not weaken)

- The agent never runs a path or argv it received from the hub. Every request maps to a fixed operation on its own
  configured unit, folders and file names, and a name is checked against the agent's own listing.
- What the hub sends is checked like the hub checks what it gets: documented fields only, each within its limit,
  and a line over 1 MiB closes the connection. Every line the agent sends fits the hub's limits too.
- RCON output is untrusted, and so is every file under the server's `data` folder (the container writes it): they
  drive display and alerting only, never a path or a security decision. Such files are opened without following
  symlinks or blocking, and read only if they are small regular files.
- Game events come over UDP only from Factorio's own Lua UDP port, only while the unit is active, and only once
  Factorio's log (this run's, not the previous one) shows Factorio bound that port; a `link` or `unlink` only for a
  player online at the latest `/orrery-status` (a fresh one if the last poll's list lacks them; never a UDP `join`). Every field is checked against the hub's limits before it is sent.
- RCON commands the agent builds are the mod's own commands with one line of JSON as the argument, and Factorio's
  built-ins `/config set <option> <value>` (the option from a fixed table in `settings.ts`, the value one it validated:
  one line, printable, within its field's limit), `/promote <name>`, `/demote <name>`, `/unban <name>`,
  `/kick <name> [reason]` and `/ban <name> [reason]` (the name checked against `^[A-Za-z0-9_.-]{1,60}$`, a kick only
  for a player online at the latest `/orrery-status` or a fresh one, under its spelling; the reason cleaned by
  `moderation.ts`'s `cleanReason`: one printable line of at most 200 characters; the owner allowed kick, ban and
  unban on 2026-11-02). These were checked on 2.1.24 not to flag the save. The first-boot check also sends the
  built-in `/help`. Never Lua, never `/c` or `/sc`, which would flag the save for good.
- The banlist (`server-banlist.json`) is container-written too: its names and reasons drive display and a moderation
  action's outcome only, never a command (an Unban sends the name the hub's request carries, checked again); an entry's
  other keys, an address included, are never copied. An outcome comes from the files and the status, never from
  Factorio's reply, which reaches no reply, log or push.
- The game settings files (`server-settings.json`, the adminlist) are container-written: they drive display only. What
  the agent writes there comes from its checked fields alone (never public, never on the LAN, no factorio.com
  credentials), through the config folder opened without following a link; the game password goes only into that
  file, its own `<state>/settings.json` (mode 600) and its one `/config set password` command: no log line, reply,
  push or error carries it.
- The agent's own state lives under `/srv/orrery-agent`, which the container never mounts; the config refuses server
  folders that overlap it.
- `serviceAct` acts on the agent's own configured unit only: the verb is all it takes from the request, and systemctl
  runs through `execFile` with `--no-block --` before the unit, never a shell.
- What the agent deletes or writes in `saves/` (pruning, a restored copy) goes through that folder opened once without
  following a symlink, so a `saves/` the container swapped for a link can't point it elsewhere. A restore copies from
  the open handle of a listed regular file, only while the unit is stopped (read again before the copy gets its
  name), and never overwrites a file.
- `deploy` starts one fixed unit, `orrery-agent-deploy@<tag>.service`, for a tag checked against `^agent-v\d+\.\d+\.\d+$`
  (the only part of the request it uses), through `execFile` with `--no-block --` before the unit; polkit allows
  factorio exactly that start, and the script it runs is root-owned and checks the tag again. A tag from
  `deploy-status.json` is checked the same way before it names a unit, and a `deployResult`'s log is `redact`ed.
- Everything the agent logs, to the journal and `agent.log`, has URL query strings stripped (`redact`): a signed
  download link's credentials never reach a log.
- A game update's input is checked like any other (`checkUpdate`): versions, names and URLs; downloads come only from
  `ALLOWED_HOSTS` over https, redirects included, each capped in size and stopped after 60 s without a byte. The agent takes no hash on the hub's word: the game's from
  factorio.com's sha256 list, each mod's from the mod portal's public API, and a mismatch fails prepare. Nothing is
  staged in `/tmp`; a release is unpacked by the agent's own tar reader, never through a path or link that leads out,
  and a binary needing a newer glibc than the image never becomes a release. `current` only ever points at a validated
  `releases/X.Y.Z`. The update's bookkeeping is `<state>/update.json`, in the agent's folder: no file under the data
  folder decides anything about an update but which of the release's own (sha256-checked) mods stay on, as the
  server's current `mods/mod-list.json` has them (the container sets that list for the running server anyway; read
  without following a link, a list that isn't Factorio's fails prepare), and no step detail, reply error or log line carries a query string.
- Whatever RCON or a container-written file puts in a line the agent logs or reports (a reply, a save or mod name, a
  log line) is `printable` first, and a save or player name that isn't is dropped: it can neither forge a line of
  `agent.log` nor drive the terminal that shows the first-boot report.

## Tests

`test/rcon.test.ts` drives a real socket with a fake RCON server (`fakeRcon` in `test/fake-rcon.ts`, shaped like
Factorio 2.1 as checked on a real 2.1.24 server: one auth reply, -1 for a wrong password (else the request's id);
one reply packet per command, every printed line ending in `\n`; a packet with an empty body never answered;
commands answered in order; `writeSize` cuts each reply packet into small writes; `port` brings a closed one back). `test/fake-hub.ts` is a fake
Agent port: a TCP server that parses every line with the hub's own `parseAgentLine` / `parseModLine` (a line the
real hub would refuse lands in `invalid`, which tests assert empty) and answers each first line with a welcome, a
reject, a reset or nothing; `eventually` polls a condition.

Keep timing-sensitive tests on small timeouts, not sleeps of seconds; stop every poller and client in `t.after`.
Times are relative to `Date.now()` (or a fake clock), never a fixed date, so no test turns red on a later day. A
test never races a timer of the code's: it waits for what the code shows (a message, a log line), gives a timer it
must not see fire a wide margin, and asserts only lower bounds on how long a timer took (a busy machine makes timers
late, never early).

Each test file starts with a comment saying what it covers; keep it true when the tests change.

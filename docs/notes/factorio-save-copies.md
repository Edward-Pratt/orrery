# Factorio: save copies on the hub

Status: design, not built. Date: 2026-11-01. Based on `main` at `2f368ab` (production: `hub-v2.17.0`, `web-v0.15.1`,
`agent-v1.1.1`). To be built **after stage B** of `docs/notes/factorio-world-settings.md` (on `fa/world-settings`),
because it reuses that stage's file transfer, save header check and save uploads. That stage is designed but not
built yet: [What this needs from stage B](#what-this-needs-from-stage-b) lists what this note depends on.

Every Save of a factorio server lives on its Host, the friend's VM. If that VM's disk is lost, or the friend wipes it,
the world is gone. The owner asked for copies off the Host:

- the hub pulls the newest named save from the Agent on a schedule, and before game updates and new worlds;
- it keeps them on the hub's own host, the newest N within a disk budget;
- the Saves tab lists them as **Copies on the hub**, with **Download** and **Put back on the server**;
- failures are audited and posted to Discord, and an offline Agent or a hub restart mid-copy loses nothing.

Contents: [Decisions](#decisions), [What this needs from stage B](#what-this-needs-from-stage-b),
[Glossary and ADRs](#glossary-and-adrs), [When a copy is made](#when-a-copy-is-made), [The transfer](#the-transfer),
[Storage on the hub host](#storage-on-the-hub-host), [Retention and the disk budget](#retention-and-the-disk-budget),
[Interruptions](#interruptions), [The Saves tab](#the-saves-tab), [Download](#download), [Put back on the
server](#put-back-on-the-server), [Hub](#hub), [Agent](#agent), [Wire additions](#wire-additions),
[Audit and Discord](#audit-and-discord), [Trust](#trust), [Tests](#tests), [Release](#release),
[Docs to update with the code](#docs-to-update-with-the-code), [Decisions for the owner](#decisions-for-the-owner),
[Out of scope](#out-of-scope).

---

## Decisions

| Question | Decision |
|---|---|
| Who opens the connection | The Agent. ADR 0004: the Agent dials out and the hub never connects to it. So "the hub pulls" means the hub asks for a copy on the Agent connection, and the Agent opens a fourth kind of connection to the hub's Agent port and streams the file in. |
| Which saves are copied | Named saves the Agent made: the 6 h ones (which `Saves.played` makes only after play), a game update's pre-update save, a restore's pre-restore save (stage B), and any listed save an admin picks by hand. |
| "Every 6 h when someone played" | Driven by the pushed `saves` list: a new plain `orrery-<time>.zip` is copied, at most once per 5 h 30 min **by the hub's clock**. The Agent already makes those only after play, so no second play check is needed, and the Agent's clock decides nothing. |
| Before a game update | Recommended: copy the update's pre-update save **after** the update ends (its content is from before; the update never waits on a transfer). The alternative, blocking the update until a fresh copy is on the hub, is laid out in [Decisions for the owner](#decisions-for-the-owner). |
| Before a new world | Stage B's New world doesn't touch the current world, so there is nothing to copy then. What matters is loading another world: the copy is of the restore's **pre-restore save**, made after the restore job ends. |
| Where copies live | `<root>/save-copies/<serverId>/<copy id>.zip` under the Environment's root (`dirname(dbPath)`, ADR 0003), named by a hub-issued id, never by the save's name. Not under `releases/` or `current/`. |
| Keeping | Two buckets, as stage B does for pre-restore saves: the newest **10 scheduled** copies, and the newest **5 others** (pre-update, pre-restore, by hand). All of them within a disk budget, **20 GB** by default. The newest copy of each bucket is never pruned. |
| Free space | A copy starts only if the hub host keeps `diskMinFreeGB` (from `integrations.host`, 10 by default) free after it. |
| Integrity | The Agent hashes the file from one open handle first and answers its size and sha256. The hub hashes what it receives and keeps the copy only on an exact match. |
| Resuming | A cut transfer resumes from the length of the hub's partial file. Copies in progress survive a hub restart (unlike `Uploads`, which is wiped at start). |
| Transfers per Agent | One at a time, in either direction (a stage B upload, or a copy). An admin's put-back pauses a running scheduled copy, which resumes after it. |
| Download | A hub route streams the file to the admin's browser as an attachment. |
| Put back on the server | Stage B's save upload, fed from the copy instead of a browser upload, then the normal restore. |
| Off by config | On for every Agent by default. `"saveCopies": false` on an Agent turns it off; `{ keep, keepOther, maxGB }` changes the defaults. |
| RCON | None. Nothing in this feature builds or sends a Factorio command. |

---

## What this needs from stage B

This design reuses stage B's design, not its code, since that code isn't written yet. If stage B is built
differently, the parts named here follow it:

- **The fetch connection** (`agentFetch`): its first-line rules on the Agent port, which `agentSend` below mirrors.
  "One transfer per Agent at a time" covers both.
- **`save-header.ts`** (the hub's copy and the Agent's): the capped zip and header reader. The hub reads a copy's
  version and mods with it, for display only.
- **`SaveUploads`** (`hub/src/save-uploads.ts`) and the Agent's `fetch.ts`: the hub-to-Agent direction, which Put
  back reuses with the copy as its source.
- **The pre-restore save** (`orrery-pre-restore-<time>.zip`) and **`restoreResult`**: the restore's end, after which
  its pre-restore save is copied.
- **The extended restore** (`stop`, `start`, `dropMods`, `restoreStep`): what "Restore it now…" runs after a put-back.

If stage B ships without the fetch connection, Put back on the server can't be built; the rest of this note can.

---

## Glossary and ADRs

This design contradicts two written statements, and changes them on purpose:

- `CONTEXT.md`, **Save**: "kept on its Host and never copied off it". The new text: "kept on its Host. The hub keeps
  Save copies of some of them."
- Stage B's **Out of scope**: "Deleting, renaming or downloading saves from the dashboard (a Save is never copied off
  its Host)." Downloading a Save copy is now in scope. That line should lose its parenthesis and "downloading" when
  `factorio-world-settings.md` is next edited, on its own branch.

New `CONTEXT.md` term, under Backups:

> **Save copy**:
> A Save the hub copied off its Host, kept on the hub's own host under its root: made every 6 h after play, after a
> game update (its pre-update save) or a restore (its pre-restore save), or by hand. It can be downloaded, or put back
> on the server as an uploaded save and then restored. The hub keeps the newest ones within a disk budget.
> _Avoid_: backup (a Backup is restored where it is), off-site backup, snapshot, mirror

ADR 0003's layout tree gains one line (additive, its rules unchanged: stored by id, never by request text):

```
├── save-copies/<serverId>/<id>.zip   Save copies; names and sources live in hub.db
```

ADR 0004 is unchanged: the Agent still dials out, and the new connection is one more first line on the same port,
under the same address and token checks.

---

## When a copy is made

`SaveCopies` (the hub) decides, from what the Agent pushes. Each trigger makes a **copy job**, which waits while the
Agent is away.

| Trigger | What is copied | Reason (`reason`) | By |
|---|---|---|---|
| A `saves` push lists a plain named save (`orrery-<time>.zip`, no `pre-update`) that is newer, by its listed `mtime`, than every save copied so far, and the last scheduled job started at least 5 h 30 min ago by the hub's clock | that save | `schedule` | `hub` |
| `updateDone` with a `backup` (the pre-update save), whatever its outcome | the save it names | `update` | `hub` |
| Stage B's `restoreResult`, whatever its outcome, once a later `saves` push lists an `orrery-pre-restore-*` save newer than every one copied | that pre-restore save | `restore` | `hub` |
| An admin's **Copy to the hub** on a listed save | that save | `manual` | the admin |

- The 5 h 30 min guard is the hub's own clock. It lets the Agent's 6 h saves through (each is 6 h after the last)
  and stops a hostile Agent from making the hub copy more often by listing saves with made-up times.
- "Newer than every save copied so far" compares listed `mtime`s, which come from the Agent's clock. That only orders
  saves from the same Agent, and the hub-clock guard bounds the rate, so a wrong clock can at worst skip a copy.
- A **Save now** from the dashboard makes a plain named save too, so it counts for the schedule when the guard allows.
- While a scheduled job waits (the Agent is away), a newer plain named save in a later push replaces it: only the
  newest is worth copying.
- An `update` or `restore` job never replaces another. A `manual` job for a save already copied (same name, size and
  listed `mtime`) is refused with 409, "That save is already on the hub."
- A copy already done is never made again for the same name, size and `mtime`.
- At most one job per server is **running** at a time. The others wait in order: `restore`, `update`, `manual`, then
  `schedule`.

---

## The transfer

### Shape

1. The hub picks the next job and issues its **copy id**, 32 hex characters (`randomBytes(16)`), stored in the job's
   row before anything is sent.
2. The hub sends `saveCopy { id, copy, name }` on the Agent connection.
3. The Agent checks `name` against its own listing, as `restore` does, and opens the file through the saves folder
   handle (`O_NOFOLLOW`, a regular file on the folder's filesystem, at most 1 GiB). It keeps that **handle** for the
   job, hashes the file from it, and replies `{ size, sha256, mtime }`. Factorio may replace a save later (an
   autosave picked by hand); the open handle still reads the file it hashed.
4. The hub checks the size against its budget and free space ([Retention and the disk
   budget](#retention-and-the-disk-budget)). A refusal ends the job here, with `saveCopyEnd`, before any socket is
   opened. Else it sends `saveCopySend { id, copy }` (an empty reply), and only from then is that copy id open for a
   send connection.
5. On `saveCopySend`, the Agent opens a new connection to the hub's Agent port, with the first line `agentSend`.
   Two requests, not one, because the reply and the new connection travel on different sockets: with one, the send
   could reach the hub before the reply and be refused for a race.
6. The hub answers one line, `{"type":"send","offset":N}`. N is the length of its partial file for that copy (0 for a
   new one).
7. The Agent streams the file from N to the end from its handle, then ends its side (half-close).
8. The hub writes the bytes to the partial file, hashing as they come. At the end it checks that the length is
   `size` and the hash `sha256`, then renames the partial file to `<id>.zip`.
9. The hub sends `saveCopyEnd { id, copy }`, and the Agent closes its handle. It is sent on success, on failure and
   on a cancel.

### The send connection (`agentSend`)

```json
{"type":"agentSend","agentId":"factorio-vm","token":"<the Agent's token>","copy":"<32 hex>"}
```

The same rules as the other first lines on the Agent port:

- The peer address is checked at accept, before any byte is read.
- There is a 5 s first-line deadline, and the token is compared in constant time.
- The line takes from the address's line budget.

Its own rules:

- The `copy` must be a copy id the hub sent `saveCopySend` for, to **that** Agent, whose job is still running and
  has no send connection yet. Else the hub sends `reject` (`no such copy`), then closes within 2 s.
- One transfer per Agent at a time, in either direction. A `agentSend` while a fetch or another send runs for that
  Agent is rejected with `a transfer is running`.
- It is welcomed at most once per 5 s per Agent. The key is `transfer <agentId>`, shared with `agentFetch`, so
  alternating the two kinds can't churn either. A sooner one is rejected with `reconnecting too fast`.
- Before the hub's `send` line, the Agent sends nothing: a byte after the first line's newline (in the same chunk or
  later) and before `send` destroys the socket.
- After the hub's `send` line, the hub writes nothing more. The Agent sends exactly `size − N` raw bytes. One more
  byte destroys the socket and discards what the connection added past `size`.
- A socket that brings no byte for 60 s is destroyed.
- Raw bytes take from no line budget: they are capped by `size` instead, which the hub already checked against its
  free space and budget.
- The connection counts toward the 4 sockets per address (`PEER_SOCKETS`). With one transfer per Agent at a time,
  the Agent connection, the game connection and a transfer leave one spare, so a reconnect during a transfer fits.

### Pacing on the Agent

The VM's uplink also carries the players' game traffic. The Agent paces its send:

- `SEND_ONLINE_BPS`, 4 MiB/s, while the last `/orrery-status` had anyone online;
- `SEND_IDLE_BPS`, 16 MiB/s, otherwise.

These are Agent constants, not hub fields: the hub never sets how hard the friend's VM works. Both numbers are
placeholders until the dev loop measures them; the smoke on production checks that nobody lags during a copy.

### Retries

- A cut connection: the hub retries the job up to 3 times, 30 s apart. Each try starts again at step 2 (`saveCopy`),
  so an Agent that restarted meanwhile opens the file again.
- If the reply's `size` and `sha256` equal the row's, the hub resumes from its partial file's length. Before
  answering `send`, it hashes the partial file from disk to rebuild the running hash (after a hub restart it has no
  hash in memory).
- If they differ (the file changed on the Host), the hub truncates the partial file and starts at 0. This counts as a
  try.
- A hash mismatch at the end deletes the partial file and counts as a try. Two in a row fail the job with "the save
  changed while it was copied".
- A save no longer listed fails the job at once with "<name> is no longer on the server" (it was pruned there).
- After the last try, the job fails, and its partial file is removed.

---

## Storage on the hub host

```
<root>/save-copies/<serverId>/
├── <id>.zip         a finished copy
└── .<id>.partial    a copy in progress (kept across hub restarts)
```

- `<serverId>` is a config `id`, which config validation already restricts. `<id>` is the hub's 32-hex copy id.
  Nothing from the Agent or the save becomes a path.
- The folder is `0700`, the files `0600`, as the hub's user.
- The hub never unzips a copy. It reads the copy's header with stage B's `save-header.ts` once the copy is done: the
  Factorio version and the mods, shown in the list. A header that can't be read **keeps** the copy, marked "Can't
  read its header: <reason>". Losing a world over a reader bug would be worse; Put back refuses it anyway, and says so.
- On start, before any Agent connects, `SaveCopies` sweeps each folder against the table:
  - a `.zip` with no row is removed and logged;
  - a row marked done with no file is deleted and audited (`save copy missing`);
  - a `.partial` with no running row is removed;
  - a running row keeps its partial file, waiting for its Agent.

### Table (added; no existing table changes)

```sql
CREATE TABLE IF NOT EXISTS save_copies (
  id TEXT PRIMARY KEY,          -- 32 hex, the file's name
  server_id TEXT NOT NULL,
  source TEXT NOT NULL,         -- the save's name on the Host (display; printable, at most LIMITS.text)
  source_mtime INTEGER NOT NULL,-- its listed mtime (the Agent's clock: display and ordering only)
  reason TEXT NOT NULL,         -- 'schedule' | 'update' | 'restore' | 'manual'
  by TEXT NOT NULL,             -- 'hub' or the admin's name
  started INTEGER NOT NULL,     -- the hub's clock
  size INTEGER,                 -- from the Agent's saveCopy reply
  sha256 TEXT,
  copied INTEGER,               -- the hub's clock when done; NULL while waiting or copying
  version TEXT,                 -- from the header, NULL if unreadable
  mods TEXT,                    -- JSON { name, version }[] from the header, NULL if unreadable
  header_error TEXT
);
CREATE INDEX IF NOT EXISTS save_copies_server ON save_copies (server_id, copied);
```

A failed job's row is deleted: the audit keeps its outcome. The table holds only running, waiting and finished copies.

---

## Retention and the disk budget

Config, per Agent in `integrations.agents.agents[]` (all optional):

```json
"saveCopies": { "keep": 10, "keepOther": 5, "maxGB": 20 }
```

or `"saveCopies": false`. `keep` and `keepOther` are integers from 1 to 100, `maxGB` a number above 0. `config.ts`
checks them, and `hub/config.example.json` shows the defaults.

**Before a copy starts** (once the `saveCopy` reply gives its size):

- `size` is at most 1 GiB, as stage B's uploads.
- `size` is at most the budget (`maxGB`). A save larger than the whole budget is refused: "This save is 24.1 GB,
  over the 20 GB kept for copies."
- The hub host's free space where the copies live (`statfs`), minus `size`, minus what the partial file already
  holds, stays at or above `diskMinFreeGB` (`integrations.host`'s, else 10). Else the job fails with "The hub host has
  14.2 GB free: this copy needs 0.9 GB and 10 GB must stay free."

**After a copy is done**, the oldest copies are pruned until both buckets fit their counts and all copies fit
`maxGB`:

- scheduled copies beyond the newest `keep`, then other copies beyond the newest `keepOther`;
- then, while over `maxGB`, the oldest copy of either bucket;
- never the newest copy of each bucket, nor a copy being downloaded or put back right now (it is pruned once that
  ends).

Pruning only after success means the budget can be exceeded by one copy's size while a transfer runs. That is
accepted: deleting an old copy before the new one is safe would risk having neither. The free-space check above
already covers that one copy.

Deleting a file while a download streams it is harmless on Linux (the open file stays readable), but the rule above
avoids even that.

---

## Interruptions

- **The Agent is offline.** Jobs wait, with "Waiting for the Agent". When it connects (`agentUp`), the next job
  starts. A scheduled job is replaced by a newer save, as above. An `update`, `restore` or `manual` job that waited 7
  days fails, with "the Agent was away 7 days". Finished copies stay downloadable the whole time: that is their point.
- **The Agent restarts mid-copy** (a deploy, a crash): the send connection is cut, the Agent's handle is gone, and the
  hub retries. That is one try.
- **The hub restarts mid-copy**: the row and its partial file stay. At start the job is marked "interrupted: the hub
  restarted", in the voice of `game-updates.ts`'s interrupted updates. When the Agent connects, it resumes as a retry.
  The Agent's handle from before times out (below).
- **The Agent holds a handle for a job the hub forgot**: closed 60 minutes after its last send connection ended, or at
  `saveCopyEnd`, whichever comes first.
- **A game update, a deploy or a restore starts while a copy runs**: nothing waits. The copy reads its own open
  handle, so pruning or a restore on the Host doesn't touch it. An Agent deploy restarts the Agent, which is a cut.
- **An admin puts a copy back while a scheduled copy runs**: the scheduled copy is cut and paused, the put-back runs,
  then the scheduled copy resumes from its partial file. A pause is not a try. An `update`, `restore` or `manual` copy is never paused: the put-back waits, and
  the dashboard says "Waiting for a copy to finish (63%)".
- **The hub host's disk fills mid-copy** (`ENOSPC`): the job fails, its partial file is removed, and the failure is
  posted. The host's own `diskLow` notice covers the disk itself.

---

## The Saves tab

A section under the saves list, for a factorio server with `features.saveCopies`, titled **Copies on the hub**.

**Header line**: "7 copies, 1.4 GB of 20 GB · the hub host has 54.2 GB free". A muted line under it: "Copies are kept
on the hub's host, so they survive the server's host. The newest 10 scheduled copies and the newest 5 others are
kept."

**Rows**, newest first:

- the save's name on the Host (`source`), with a mark for its reason: Scheduled, Before update (with the versions from
  the audit row, when known), Before restore, By hand (with the admin's name);
- "Made <time>" (the Host's listed time) and "copied <time>" (the hub's);
- size, and "Factorio 2.1.24 · 12 mods", or "Can't read its header" with the reason in a `title`;
- "Also on the server" when the pushed list still holds a save of the same name, size and `mtime`. Its menu then says
  "Restore that one…" first: there's no need to send it back.
- a row menu (`aria-label="Actions for <source>"`): **Download**, **Put back on the server…**, **Delete…** (a
  confirmation naming the copy).

**A job in progress** shows as the first row: "Copying orrery-20261101T180000Z.zip: 63% (412 of 650 MB), 3.9 MB/s",
with a `role="progressbar"` (`aria-valuenow`), or "Waiting for the Agent", or "Retrying in 30 s (try 2 of 3)".

**On the saves list**, each row menu gains **Copy to the hub**. It is disabled while that save is already on the hub
("Already on the hub") or while a job for it runs.

**States**

- The Agent isn't connected: copies stay listed with Download. Put back and Copy to the hub are disabled, with "The
  Agent isn't connected."
- An older Agent (below `COPIES_FLOOR`): "This server's Agent runs agent-v1.3.0, which can't send copies. Deploy
  agent-v1.4.0 or later from the Host page (Releases)." Existing copies can still be downloaded.
- An older hub (the dashboard runs ahead): its 404 shows "This hub keeps no save copies yet: deploy hub-v2.20.0 or
  later."
- Off in config: the section isn't shown (`features.saveCopies` false).
- The last scheduled copy failed: a warning line under the header, "The last copy failed <time>: <reason>." It stays
  until a copy succeeds.

The version numbers in these texts are placeholders: see [Release](#release).

---

## Download

`GET /api/servers/:id/save-copies/:copy/file`:

- Admin session required, as every route. A GET changes nothing, so it needs no CSRF check (`web.ts` checks the
  state-changing requests), and the dashboard's `<a href download>` works with the session cookie.
- 404 for an unknown server or copy, or one not finished.
- Streams the file (`createReadStream`, as a web stream) with `Content-Type: application/zip`, `Content-Length`,
  `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` and `Content-Disposition: attachment;
  filename="<safe>.zip"`. `<safe>` is the source name without `.zip`, each character outside `[A-Za-z0-9_-]` replaced
  by `-`, cut to 80, or `save`; the server's id goes in front (`factorio-orrery-20261101T180000Z.zip`).
- Audited as `save copy download` with the copy's source name. A download doesn't post to Discord.

Caddy proxies `/api` and streams responses, so a large copy needs no Caddy change. The smoke checks a 500 MB
download through it.

---

## Put back on the server

`POST /api/servers/:id/save-copies/:copy/put-back` (JSON `{}`, CSRF-checked) answers 202 with stage B's save upload
answer: the header, and the mods the server lacks.

- It goes through stage B's `SaveUploads.add` with a new source, the copy, instead of a finished browser upload. The
  hub hard-links the copy's file to `<root>/save-uploads/<fetch id>` (the same filesystem, so no bytes are copied). If
  linking fails, it copies the file.
- The rest is stage B unchanged:
  - the header checks (refused if made with a newer Factorio; missing mods shown as a warning);
  - its refusals (409 while an update, a deploy, a restore or another upload runs on that server);
  - `saveUpload`, the Agent's fetch, its own sha256 and header check;
  - `uploaded-<time>-<safe>.zip`, stamped older, and `saveUploaded`.
- The name sent with `saveUpload` is the copy's source name. The Agent makes its own `<safe>` from it, as for any
  upload.
- The dashboard opens stage B's upload sheet at its **Send** step, and ends with **Restore it now…** (the restore
  sheet with Stop and Start) and **Close**.
- Audit: `save copy put back` with the source name, then the save upload's own rows.

---

## Hub

New module `hub/src/save-copies.ts`, `SaveCopies` (hub core, made with the agents integration and `Db`), for the
servers of Agents whose `saveCopies` isn't false (`has`; others 404):

- `start()`: the sweep above, then listens to `Agents` for `saves`, `updateDone`, `restoreResult` (stage B),
  `agentUp` and `agentLost`.
- `state(id)`: `SaveCopiesState` (below).
- `copy(id, name, by)`: a `manual` job; 404 for a save not listed, 409 when already on the hub or a job for it runs,
  or the Agent is below `COPIES_FLOOR`.
- `file(id, copy)`: the path and size for Download, or null.
- `remove(id, copy, by)`: deletes the copy (refused while it is downloaded or put back).
- `putBack(id, copy, by)`: through `SaveUploads`, as above.
- `accept(agentId, copy, socket)`: called by `Agents` for a welcomed `agentSend`.
- It publishes `saveCopies` on the server's live feed when the list changes, and `saveCopyStep` (`copy`, `state`,
  `received`, `size`) at most once a second while bytes come in.

`COPIES_FLOOR` is the Agent release that adds `saveCopy` (placeholder `agent-v1.4.0`). `agent-v0.0.0` counts as
newer, as for `beforeAgentFloor`.

`hub/src/agents.ts`: the fourth first line, `agentSend`, with the rules above. The send socket is handed to
`SaveCopies` once welcomed; `Agents` keeps only the transfer slot and the 5 s welcome key. `WITH_DATA` gains
`saveCopy`.

`hub/src/web.ts`: a block `if (saveCopies)`, apart from the other routes:

- `GET /api/servers/:id/save-copies` → `SaveCopiesState`;
- `POST /api/servers/:id/save-copies` with `{ name }` → 202 (a `manual` job);
- `GET /api/servers/:id/save-copies/:copy/file` → the stream;
- `POST /api/servers/:id/save-copies/:copy/put-back` → 202;
- `DELETE /api/servers/:id/save-copies/:copy` → 204.

`:copy` must match `^[0-9a-f]{32}$`, else 404 before any lookup. `Features` gains `saveCopies`
(`saveCopies?.has(id)`).

Types in `hub/src/api.ts` (a new section):

```ts
/** Why a save copy was made. */
export type SaveCopyReason = 'schedule' | 'update' | 'restore' | 'manual';
/** A save copy on the hub: `source` and `sourceMtime` are the Host's (display only). */
export type SaveCopy = {
  id: string; source: string; sourceMtime: number; reason: SaveCopyReason; by: string; copied: number; size: number;
  version: string | null; mods: { name: string; version: string }[] | null; headerError: string | null; onServer: boolean;
};
/** The job running or waiting first: `state` says which; `received` counts the bytes on the hub. */
export type SaveCopyJob = {
  id: string; source: string; reason: SaveCopyReason; state: 'waiting' | 'copying' | 'retrying';
  received: number; size: number | null; tries: number; detail: string;
};
/**
 * `GET /api/servers/:id/save-copies`. `used`: the bytes all copies take; `free`: the hub host's free bytes there.
 * `lastError`: the last failure, until a copy succeeds. `blocked`: why Copy to the hub and Put back are refused now.
 */
export type SaveCopiesState = {
  copies: SaveCopy[]; job: SaveCopyJob | null; waiting: number; keep: number; keepOther: number; maxBytes: number;
  used: number; free: number | null; lastError: string | null; blocked: string | null;
};
```

---

## Agent

New module `agent/src/send.ts`, `Sends`, next to stage B's `fetch.ts`:

- On `saveCopy`: checks `copy` (32 hex) and `name` (at most `LIMITS.text`, printable, listed now by `Saves.list`).
  Opens the file through `Saves`' folder handle (a new `Saves.open(name)` returning the handle and its `fstat`: a
  regular file, the folder's filesystem, at most 1 GiB). Hashes it from the handle, with 1 MiB reads. Replies `{ size,
  sha256, mtime }`. It opens the send connection only on `saveCopySend` for the copy id it holds (else `ok: false`,
  "no such copy").
- On `saveCopySend`: replies at once, then opens the send connection.
- Holds at most one job, keyed by copy id. A `saveCopy` for another copy id while one is held closes the old one
  first: the hub runs one at a time. One for the same id reuses the handle, and the hash if the `fstat` size and
  `mtime` are unchanged.
- The send connection: the `agentSend` line, then it reads one line of at most 1 MiB, which must be `send` with an
  integer `offset` from 0 to `size`, or `reject`. It then writes from the handle at `offset`, paced, honouring the
  socket's backpressure, and ends. It never reads anything after that line: a further byte from the hub destroys the
  socket.
- On `reject` (`no such copy`, `a transfer is running`, `reconnecting too fast`), or a cut, it does nothing more: the
  hub decides whether to retry, and retries start with `saveCopy`. It never opens a send connection on its own.
- On `saveCopyEnd`, or 60 minutes after its last send connection ended, it closes the handle.
- Refused (`ok: false`) while a stage B fetch runs (the hub never asks then; this is the Agent's own guard).
- Logs name the save and the byte counts, never the token.

`agent/src/hub.ts` routes `saveCopy`, `saveCopySend` and `saveCopyEnd`. `agent/src/index.ts` makes `Sends` with the hub's address and
the Agent's token from its config, as for `fetch.ts`.

---

## Wire additions

Additive. No `PROTOCOL_VERSION` bump.

| Direction | Message | Fields | Notes |
|---|---|---|---|
| first line | `agentSend` | `agentId`, `token`, `copy` (32 hex) | the send connection. The hub answers `send` `{ offset }` (an integer from 0 to the copy's size), then the Agent sends raw bytes; or `reject` |
| hub → Agent | `saveCopy` | `id`, `copy` (32 hex), `name` (a listed save, at most `LIMITS.text`) | `reply.data` `{ size: integer 1 to 1 GiB, sha256: 64 hex, mtime: integer }`; answered within 5 min (`AGENT_HASH_MS`: it hashes up to 1 GiB on the VM's disk) |
| hub → Agent | `saveCopySend` | `id`, `copy` (the copy id of the `saveCopy` just answered) | an empty reply; 30 s. The Agent then opens the send connection |
| hub → Agent | `saveCopyEnd` | `id`, `copy` | an empty reply; 30 s |

**Budgets**

- No new Agent → hub message type, so `TYPES` and `SAME` don't change. The hub counts the bytes received itself, so
  the Agent pushes no progress.
- The replies to `saveCopy`, `saveCopySend` and `saveCopyEnd` take the line budget only, as every reply does.
- `agentSend` takes its address's line budget, and is welcomed at most once per 5 s per Agent (shared with
  `agentFetch`).
- The hub has at most one copy job in flight per Agent (one `saveCopy` and one `saveCopySend` per try), at most one try per 30 s, and at most one scheduled job
  per 5 h 30 min per server.

Places that change together:

- `hub/src/types.ts`: `AgentRequest` (`saveCopy`, `saveCopySend`, `saveCopyEnd`), `AgentReplyData` (`saveCopy`).
- `hub/src/protocol.ts`: the `agentSend` first-line schema, the reply schema, the `send` line.
- `agent/src/wire.ts`: `readAgentLine` for the three requests, and its `LIMITS` copy, with `agent/test/wire.test.ts`.
- `docs/protocol.md`: a fourth row in the Agent connection's "Handshake", the three requests in "Hub → Agent", the
  limits, and the send connection's rules in "Rate rules".

**Version skew**, stated in `docs/protocol.md`:

- A hub older than this never sends `saveCopy` and never sees `agentSend`.
- An Agent older than this is blocked by `COPIES_FLOOR` before anything is sent. Its copies on the hub stay listed
  and downloadable. If `saveCopy` were sent anyway, it answers `saveCopy is not supported by agent-v…`
  (`agent/src/hub.ts`), which fails the job with that text.
- An older Agent never opens a send connection. A newer Agent facing an older hub never gets `saveCopy`, so it never
  opens one either. If it did, the older hub would read `agentSend` as an unknown first line and close the socket, as
  for any bad first line.

---

## Audit and Discord

**Audit** (target the server):

- `save copy`: the source name, the reason, the size, then the outcome: "copied in 2 min 41 s", or "failed: <reason>"
  (actor `hub`, or the admin for a by-hand copy);
- `save copy pruned`: the source names pruned after a copy, in one row;
- `save copy delete`, `save copy download` and `save copy put back`, each with the source name and the admin;
- `save copy missing`: a copy whose file was gone at start.

**Discord** (the alerts channel, through the existing notice path; new `Notice` kinds with their `format.ts` text):

- `saveCopyFailed`: "Couldn't copy <save> off <server>: <reason>." Posted for the **first** failure of a streak only.
  Later failures in the streak are audited and shown on the Saves tab, but not posted.
- `saveCopyOk`: "Save copies of <server> work again: <save> is on the hub." Posted once, after a streak ends.
- `saveCopiesStale`: "<server>'s newest copy on the hub is <n> h old, and newer saves weren't copied." Checked hourly:
  posted when the newest copy is over 24 h older than the newest plain named save listed, and once per stale spell.
  It catches what no failure reports, such as an Agent that never opens its send connection.

A copy waiting because the Agent is away posts nothing: `agentLost` already says so. Successful copies, downloads,
deletes and put-backs post nothing.

---

## Trust

- **No RCON.** Nothing in this feature builds, sends or relays a Factorio command, so "the hub never builds Factorio
  command text" isn't touched, and neither is `agent/CLAUDE.md`'s RCON rule.
- **Nothing from the hub becomes a path on the Host.** `name` is checked against the Agent's own listing, as
  `restore` does. The file is opened through the folder handle with `O_NOFOLLOW`, regular and on the folder's
  filesystem. The copy id is checked as hex and is only a key in memory.
- **Nothing from the Agent becomes a path on the hub host.** Copies are stored under a hub-issued id. `source` is
  display text, printable and capped, as the `saves` push already is.
- **What the Agent sends is untrusted bytes.** The Agent's container can write any file in `saves/`, so a copy may be
  anything. The hub:
  - accepts only copies it asked for;
  - caps them at the `size` it checked against 1 GiB, the budget and the free space;
  - never unzips them, and reads the header only with stage B's capped reader, for display;
  - serves them only as an attachment download, with `nosniff`.
- **A copy is as trusted as the server it came from.** Its `control.lua` is that server's scenario Lua. Loading a
  downloaded copy in a Factorio client runs it in Factorio's sandbox, as joining the server does. Putting one back
  goes through stage B's checks again, on the hub and on the Agent.
- **The send connection** gets the same address and token checks as the other connections. It reads one line on
  each side, then flows one way only, and the receiver destroys the socket at the first byte past what it expects.
- **The disk can't be filled by a token holder.** Every copy is one the hub started, sized before the first byte, and
  checked against the budget and the free space.
- **Pacing is the Agent's.** The hub can't make the VM send faster than the Agent's constants.
- The other trust rules stand: the Agent's own state stays under `/srv/orrery-agent`, and no secret is in a copy, a
  route or a log line.

---

## Tests

`hub/test/save-copies.test.ts`, the whole hub with `test/fake-agent.ts` (extended to answer `saveCopy` and open a
send connection) and a temporary root:

- **Triggers:**
  - a pushed plain named save starts a scheduled copy;
  - a second one within 5 h 30 min (hub clock, fake timers) doesn't;
  - one at 5 h 30 min does;
  - a pre-update save named in `updateDone` is copied with reason `update`, and a pre-restore save after
    `restoreResult` with reason `restore`;
  - a by-hand copy is refused 409 when already on the hub;
  - a waiting scheduled job is replaced by a newer save;
  - jobs run in order, one at a time.
- **The transfer:**
  - a whole file arrives, is renamed `<id>.zip` and matches;
  - a cut at 10 MB resumes from the partial file's length;
  - a resume after a hub restart rehashes the partial file and finishes;
  - a changed file (another sha256 on a retry) restarts at 0;
  - a hash mismatch at the end leaves no file, and two in a row fail the job;
  - a save no longer listed fails at once;
  - three cuts fail the job.
- **The `agentSend` first line:**
  - from a wrong address, it is destroyed unread;
  - a wrong token, an unknown copy id, another Agent's copy id, and one before `saveCopySend` was sent are rejected;
  - a byte after the first line and before `send` destroys the socket;
  - a copy over the budget ends at `saveCopyEnd`, and no send connection is opened;
  - a second transfer while one runs, a fetch running, and two sends within 5 s are rejected;
  - one byte past `size` destroys the socket and keeps nothing past `size`;
  - 60 s with no byte destroys it;
  - the 4-socket count with a transfer running still admits a reconnect.
- **The budget:**
  - a save over `maxGB` is refused;
  - the free-space check, with a fake `statfs`;
  - pruning keeps 10 scheduled and 5 others, then fits `maxGB`, and never the newest of a bucket;
  - a copy being downloaded isn't pruned until the download ends;
  - `ENOSPC` mid-copy fails cleanly.
- **The sweep at start:** an orphan `.zip`, a done row without a file, an orphan `.partial`, and a running row kept.
- **Agent offline:** jobs wait; `agentUp` starts the next; a by-hand job fails after 7 days.
- **Routes:**
  - each route without a session is 401, and a Minecraft server is 404;
  - `:copy` not hex is 404;
  - Download has its headers and `<safe>` names (`../x.zip`, emoji, 300 characters), and streams a 50 MB file;
  - Delete; Put back calls `SaveUploads` with a linked file;
  - an Agent below `COPIES_FLOOR` is refused, and no request is sent.
- **Audit and Discord:**
  - the rows;
  - `saveCopyFailed` once per streak and `saveCopyOk` after it;
  - `saveCopiesStale` once per stale spell.
- **Live:** `saveCopyStep` at most once a second, and `saveCopies` on each change.

`hub/test/config.test.ts`: `saveCopies` false, the defaults, and each field's bounds.

`agent/test/send.test.ts`, against a fake hub port:

- `saveCopy` for a save not listed, a symlink swapped in, a file over 1 GiB, and a bad copy id are refused;
- the reply's size and sha256 are the file's;
- no send connection opens before `saveCopySend`, and `saveCopySend` for another copy id is refused;
- the send writes from `offset` to the end and half-closes;
- it reads nothing after the `send` line, and a byte from the hub then destroys the socket;
- `reject` ends the attempt with no retry of its own;
- the handle survives the file being replaced (rename over it) and still sends the hashed bytes;
- pacing: with fake timers, the bytes per second stay under each constant, online and idle;
- the handle closes at `saveCopyEnd` and after 60 idle minutes;
- refused while a fetch runs;
- through the fake hub's real `parseAgentLine`, with nothing in `invalid`.

`agent/test/wire.test.ts`: the three requests' checks, and `LIMITS` equal to the hub's.

`web/src/app/servers/save-copies.spec.ts`:

- the section renders the rows, the header line, the reasons and "Also on the server";
- the job row's progress, waiting and retry texts, with `role="progressbar"`;
- Download's link, Put back opening the upload sheet at Send, and Delete's confirmation;
- Copy to the hub on a saves row, disabled when already copied;
- the Agent-offline, older-Agent, older-hub (404), off and last-failure states.

**Dev loop** (local hub and Agent, the real 2.1.24 headless):

- copy the 43 MB test save, cut it at 10 MB, and see it resume and match;
- restart the hub mid-copy and see it finish;
- copy an autosave while Factorio rewrites it, and see the handle keep the old bytes;
- download it through Caddy, and load it in a client;
- put it back and restore it;
- measure the Agent's pacing against a player's ping in game.

---

## Release

After stage B ships. Stage B's note numbers its releases `hub-v2.17.0`, `web-v0.15.0` and `agent-v1.3.0`, but those
numbers are taken or have moved (production is at `hub-v2.17.0` and `web-v0.15.1`, and Settings ships as
`hub-v2.18.0` with `agent-v1.2.0`). So this note uses **placeholders**: the minors after stage B's, likely
`hub-v2.20.0`, the next web minor, and `agent-v1.4.0`. Fix the texts above and `COPIES_FLOOR` to the real tags when
cutting.

1. Build on its own branch from `main` after stage B is merged. Verify as `CLAUDE.md` says.
2. Release the hub and deploy it. Against an Agent below `COPIES_FLOOR`, no copy is attempted, and the Saves tab
   (once the web deploys) shows the deploy text. The `save_copies` table is created at start.
3. Release the dashboard and deploy it.
4. Release the Agent (`saveCopy`, `saveCopySend`, `saveCopyEnd`, the send connection) and deploy it from the Host page (Releases).
   The friend does nothing: no unit, polkit rule or port changes.
5. Smoke on production:
   - the first scheduled copy after play, with its time and the hub's free space;
   - a by-hand copy while someone plays, checking for lag;
   - restart the hub mid-copy and see it resume;
   - download a copy and open it in a client;
   - put an old copy back and restore it with Stop and Start, then restore the pre-restore save to go back;
   - stop the Agent and see the copies still downloadable, and the job waiting.

---

## Docs to update with the code

- `docs/protocol.md`: as in [Wire additions](#wire-additions).
- `CONTEXT.md`: the **Save copy** term, and the **Save** entry's new wording ([Glossary and ADRs](#glossary-and-adrs)).
- `docs/adr/0003-host-directory-layout.md`: the `save-copies/` line in the layout tree.
- `hub/CLAUDE.md`: rows for `save-copies.ts`, `agents.ts` (the fourth first line), `db.ts` (`save_copies`),
  `config.ts` (`saveCopies`), `web.ts` and `api.ts`.
- `agent/CLAUDE.md`: the modules table (`send.ts`, and `saves.ts`'s `open`) and the tests list.
- `web/CLAUDE.md`: the Saves tab's Copies on the hub section.
- `hub/config.example.json`: `saveCopies` on the Agent entry.
- Root `CLAUDE.md`: nothing (no unit or polkit change).
- `docs/ROADMAP.md`: a section for this work, linking this note.

---

## Decisions for the owner

1. **Before a game update: copy after, or block?** Recommended: copy the pre-update save after the update ends. Its
   content is from before the update, and the update never waits or fails over a transfer. The alternative: before
   the countdown, the hub asks for a named save, copies it, and starts the update only once the copy is done (or after
   10 minutes, going on without it, with a notice). That protects against the Host being lost during the update
   itself, at the cost of a slower update and a new way for it to be held up.
2. **Two buckets, or pins.** Recommended: two buckets (10 scheduled, 5 others), as above. Without them, 10 scheduled
   copies at one per 6 h of play would prune a pre-update or pre-restore copy within about 2.5 days. Pins ("Keep this
   copy", outside the counts but inside `maxGB`) are the other way, and could be added later.
3. **The defaults:** on for every Agent, 20 GB, 4 MiB/s while players are on and 16 MiB/s otherwise. The pacing needs
   the dev loop's numbers and the friend's view on his uplink.
4. **A copy whose header can't be read:** kept and marked (recommended), or dropped.
5. **The Host is the friend's.** These copies put his server's world on the owner's host. The world is the players'
   shared game, not the friend's own data, but tell him before turning this on.

---

## Out of scope

- Copies of Minecraft Backups (they live on the hub's own host already), and copies of the hub host itself to
  somewhere else.
- Uploading copies to cloud storage, or encrypting them at rest (the hub host's disk is the owner's).
- Copying Factorio's mods or config along with a save: a put-back restores the world only, and a game update brings
  back the mods.
- Copying every named save, or autosaves on a schedule.
- Discord commands for any of this.
- Choosing a copy's bucket, renaming copies, or downloading Saves that aren't copied (Copy to the hub, then Download).

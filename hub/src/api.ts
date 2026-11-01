/**
 * The HTTP API's types, for the dashboard to import type-only. Imports only pure type files (no Node types), so it
 * compiles on its own: `npm run typecheck` checks that with `tsconfig.api.json`.
 */
import type {
  AuditRow,
  BackupsAnswer,
  DeployPart,
  DeployRow,
  FactorioMod,
  Release,
  HistoryAnswer,
  HostSample,
  FeedEvent,
  Game,
  LogFile,
  PackOutcome,
  PackStepState,
  Period,
  PlaytimeAnswer,
  Rate,
  ServiceStatus,
  StatusAnswer,
  TpsAnswer,
} from './types.ts';

export type {
  Backup,
  BackupsAnswer,
  CheckStatus,
  DeployOutcome,
  DeployPart,
  DeployRow,
  FactorioMod,
  Game,
  HistoryAnswer,
  HostSample,
  HubEvent,
  InstallStep,
  LibraryAdd,
  Lifecycle,
  LogFile,
  MilestoneKind,
  Notice,
  PackFinished,
  PackOutcome,
  PackStep,
  PackStepState,
  Paused,
  Period,
  PlaytimeAnswer,
  Rate,
  Release,
  SaveKind,
  ServerState,
  ServiceStatus,
  ServiceVerb,
  Severity,
  StatusAnswer,
  Target,
  TargetEvent,
  TargetNotice,
  Tps,
  TpsAnswer,
  UptimeState,
} from './types.ts';

/** `GET /api/me`: the logged-in admin; `avatar` is their Discord avatar hash (null: none). */
export type Me = { id: string; username: string; avatar: string | null };

/** `GET /api/environment`, the one read without a session: which Environment this hub is, for the dashboard's badge. */
export type EnvironmentInfo = { environment: 'production' | 'staging' };

/**
 * `GET /api/integrations`: which integrations are switched on, whether the hub has the Pack `library` (systemd and
 * Minecraft), and whether New server is offered (`newServer`: the library and GitHub on).
 */
export type Integrations = {
  minecraft: boolean;
  discord: boolean;
  web: boolean;
  checks: boolean;
  host: boolean;
  systemd: boolean;
  github: boolean;
  agents: boolean;
  library: boolean;
  newServer: boolean;
};

/**
 * `GET /api/hosts` (with the host or agents integration): every Host, the hub's own first, then each Agent's (`id`:
 * the Agent's), each with its id and latest sample, null until the first (for the hub's own, a minute after the hub
 * starts; for an Agent's, its first `hostSample`). Each new sample is also a `sample` event on the stream, with the
 * host's id. `GET /api/host` is the hub's own alone, only with the host integration (kept for one release).
 */
export type HostNow = { id: string; sample: HostSample | null };

/**
 * `GET /api/hosts/:id/samples[?hours=1–2160]` (404 unknown id): the host's samples over the last `hours` (default
 * 24), oldest first. Up to 25 hours they are the raw minutes; a longer period is at most `HISTORY_POINTS` (1500,
 * `host.ts`) equal time buckets, each the average of its samples (`ts` too; a mount over the samples that have it).
 * `GET /api/host/samples` is the hub's own (kept for one release).
 */
export type HostHistory = HostSample[];



/**
 * A part's releases: the one `running` (the hub: `dev` from a plain checkout; the dashboard: null if unknown; a Mod:
 * `mod-v` + the version its hello reported, as is when that isn't a release, null if it never connected; an Agent:
 * `agentVersion` from its latest `agentHello`, null if it never connected), the `latest` published one (null: none),
 * and every published one, newest first.
 */
export type PartReleases = { running: string | null; latest: string | null; releases: Release[] };

/**
 * `GET /api/deploys[?before=id]` (only with the GitHub integration): what each part runs against what GitHub has
 * published (drafts and prereleases left out), each minecraft server's Mod, each Agent (`agent.hosts`, by its id and
 * name, with the factorio `server` it runs, from `agents[].server`; none without the agents integration), when GitHub
 * was last asked (`checkedAt`, null: not yet) and why that failed (`error`), `newerAfterDays`, and a batch (50) of the
 * deploy history, newest first, with whether `older` ones remain (`before` is a row's `id`). Changes come as
 * `deployStarted`/`deployFinished` notices.
 */
export type DeploysAnswer = {
  hub: PartReleases;
  web: PartReleases;
  mod: { latest: string | null; releases: Release[]; servers: { id: string; name: string; running: string | null }[] };
  agent: { latest: string | null; releases: Release[]; hosts: { id: string; name: string; server: string; running: string | null }[] };
  checkedAt: number | null;
  error: string | null;
  newerAfterDays: number;
  history: DeployRow[];
  older: boolean;
  /**
   * The servers a pack update or a game update runs on: no Mod or Agent deploy onto them, and no hub deploy,
   * meanwhile.
   */
  packing: string[];
};

/**
 * `POST /api/deploys`: deploys a published release (`server`: the Mod's server; `host`: the Agent's id, for an
 * `agent` release). Answers 202 with the history row's `id`; the outcome follows as a `deployFinished` notice. 404
 * for a tag GitHub didn't list, an unknown server or Agent, 409 when refused (another deploy runs, the tag is the one
 * running, a restore runs, below the first release that can deploy, a server with no folder, no Mod or a countdown
 * running; an Agent not connected, or an update, a restore or a countdown on its server), 502 if systemctl or the
 * download fails. Audited. `POST /api/deploys/check` asks GitHub again and answers like `GET /api/deploys`.
 */
export type DeployRequest = { part: DeployPart; tag: string; server?: string; host?: string };
export type DeployAnswer = { id: number };

/**
 * `GET /api/services/:id/logs`: its last 200 journal lines, oldest first (a service an Agent runs: the last 200 lines
 * of its log file, from the Agent). 404 for an unlisted id, 502 if journalctl fails or the Agent can't answer.
 */
export type ServiceLogs = { lines: string[] };

/**
 * The answer to `POST /api/services/:id/start`, `/stop` and `/restart` (no body; audited as the admin). The action
 * doesn't wait for systemd: the new state follows as `state` events. Stopping or restarting a service whose linked
 * server has players online first counts down in game (the server card's `restart`, cancelled like a restart): `at`
 * is when it will run, null if it ran at once. A service an Agent runs is acted on by that Agent (`serviceAct`). 404
 * for an unlisted id, 409 if a countdown is already running on the server, 502 if systemctl fails or the Agent can't
 * answer.
 */
export type ServiceActionAnswer = { at: number | null };

/**
 * What a server has: chat, the rate (`tps`) and the console for a Minecraft server with the Mod (a token configured)
 * and for a factorio server; quests for a Minecraft server with the Mod only; game updates (`update`, the Game tab)
 * for a factorio server only.
 */
export type Features = { chat: boolean; tps: boolean; quests: boolean; console: boolean; update: boolean };

/** A countdown restart (or, with `stop`, a countdown stop of its service) in progress: when it fires and who scheduled it. */
export type PendingRestart = { at: number; by: string; stop: boolean };

/**
 * `GET /api/servers`: one card per server. `tps` is null without the TPS feature. `lagging` is true while the server
 * is in a lag alert (the rule and `lagTps`/`lagMinutes` thresholds of Discord's lag notice; refetch on the `lag` and
 * `lagRecovered` notices). `service` is the systemd service it runs as: its id and active state (null until the hub
 * has read it); the whole field is null with no linked service or with systemd off (refetch on that service's
 * `state` events). `rate` is its game's: what `tps` is called and its full speed (TPS 20 or UPS 60).
 */
export type ServerCard = {
  id: string;
  name: string;
  game: Game;
  rate: Rate;
  online: boolean;
  hung: boolean;
  /** A factorio server is paused (nobody on, or an admin's pause): show "Paused", not its rate. A change comes as a `paused` event. */
  paused: boolean;
  tps: number | null;
  players: string[];
  /** Share of the last 24 h the server was up (0–1), null if unknown. */
  uptimeDay: number | null;
  restart: PendingRestart | null;
  lagging: boolean;
  service: { id: string; state: string | null } | null;
  features: Features;
  /**
   * Without packs null; else whether a pack update runs on it (refetch on `packUpdateStarted`/`packUpdateFinished`),
   * and the restore offer after one rolled back (see `PackState.rolledBack`).
   */
  packUpdate: { running: boolean; rolledBack: PackRollback | null } | null;
};

/**
 * `GET /api/servers/:id`. `tps` is null without the TPS feature; `top` is the 10 most-played per period; `service`
 * is the service it runs as, if linked.
 */
export type ServerDetail = {
  card: ServerCard;
  service: ServiceStatus | null;
  status: StatusAnswer;
  tps: TpsAnswer | null;
  top: Record<Period, { player: string; ms: number }[]>;
  backups: BackupsAnswer;
  /** Whether the server can have a pack: a folder, a linked service and a Mod token. Only then are there pack routes. */
  pack: boolean;
  /** Whether the server's logs can be read (`GET /api/servers/:id/logs`): it has a folder, or an Agent runs it. */
  logs: boolean;
};

/**
 * `GET /api/servers/:id/logs`: the server folder's readable logs, newest first: the files directly in `logs/`
 * (`*.log`, `*.log.gz`) and its crash reports (`crash-reports/*.txt`, `hs_err_pid*.log`). Symlinks and folders are
 * left out. A server an Agent runs: the files the Agent serves (`factorio-current.log`, `factorio-previous.log`,
 * `agent.log`), newest first, and no crash reports; 502 if the Agent can't answer. 404 for an unknown server or one
 * with neither a folder nor an Agent. Not audited.
 */
export type ServerLogFiles = LogFile[];

/**
 * `GET /api/servers/:id/logs/:name`: the last 1000 lines of one listed file, oldest first, a `.gz` decompressed (the
 * shape of `ServiceLogs`). The name must be one the listing holds right now: anything else (`..`, a slash, a symlink)
 * is 404, as is an unknown server or one with neither a folder nor an Agent. 502 if the file can't be read (e.g. a
 * broken `.gz`) or the Agent can't answer.
 */
export type ServerLog = { lines: string[] };

/** `GET /api/servers/:id/players/:name`: playtime and last seen; 404 for a name never seen on the server. */
export type PlayerAnswer = PlaytimeAnswer;

/**
 * `GET /api/servers/:id/history[?hours=1–2160]`: the last `hours` (default 24), see `HistoryAnswer`. `asOf` is the
 * newest event id when it was read: stream events up to it are already counted in. 404 unknown, 400 bad hours.
 */
export type ServerHistory = HistoryAnswer & { asOf: number };

/**
 * `GET /api/audit[?server=id][&actor=who][&before=id]`: a batch (200) of entries, newest first, and whether `older`
 * ones remain. `before` is an entry's `id`: only entries strictly older than it come back. 404 unknown server, 400 bad
 * `before`.
 */
export type AuditLog = { entries: AuditRow[]; older: boolean };

/**
 * The `data` of each `GET /api/events` message (JSON); the message's SSE `id` is its event id. A server's events
 * have `serverId`; the host's, a service's and a check's have `target` and `id` instead. `tps` events come from
 * heartbeats when TPS moved by 0.1 or more, and `paused` ones when a factorio server's heartbeat changed its `paused`;
 * a replay holds only each online server's latest of each. `at` is when the hub saw
 * the event (epoch ms), the same in a replay. A `say` (chat sent into the game) has its `source`: `discord` or `dashboard`.
 */
export type LiveEvent = FeedEvent;

/**
 * Every request but GET/HEAD — the actions below, logout too — must send `Origin` (the dashboard's) and
 * `content-type: application/json`, even with no body (else 403/415). Actions answer 404 for an unknown server,
 * 409 if it is offline, 400 for bad input and 502 if it doesn't answer.
 */
/** `POST /api/servers/:id/chat`: said in game as the admin (their Minecraft name if linked). 204. */
export type ChatRequest = { message: string };

/**
 * `POST /api/servers/:id/command`: a console command, answered with `CommandOutput`; later output comes as `console`
 * events. 400 for an empty one, and for a factorio server's over 256 characters (its Agent runs no longer one; the
 * answer's text says so).
 */
export type CommandRequest = { command: string };

/** `POST /api/servers/:id/restart`: a countdown restart in 0–60 whole minutes. 204; cancel with `POST …/restart/cancel`. */
export type RestartRequest = { minutes: number };

/**
 * `POST /api/servers/:id/restore` (only with systemd): puts the named backup (one of the server's listed ones) back over
 * its world with `deploy/restore-backup.sh`, keeping the current world as a pre-restore copy; answered with the
 * script's output (`CommandOutput`: its next steps). A factorio server's Agent instead copies the named save as the
 * newest, which its next start loads (nothing is overwritten). Only while the server's linked service is stopped
 * (inactive or failed), else 409, as without a linked service or with a restore already running; 404 for an unknown
 * server or backup; 502 with the script's error output (or the Agent's error) if it fails. Every attempt is audited.
 */
export type RestoreRequest = { name: string };

/**
 * The answer to a command, to `POST /api/servers/:id/backup` (a Mod's `backup start` output; a factorio server's save
 * has none) and to a restore (the script's output; an Agent's restore, one line).
 */
export type CommandOutput = { output: string[] };

/**
 * Packs (only for a server with a folder, a linked service and a Mod token; others 404). Every path is relative to the
 * server's folder. Actions are audited as the admin; `PackRefused` answers 400 (bad input), 404 or 409 (not now; Extras and Config edits change
 * only while no update runs).
 */
/** The installed pack, as its library entry recorded it: `source` is its URL, or the uploaded file's name; `how` it arrived. */
export type InstalledPack = {
  name: string;
  version: string;
  source: string;
  sha256: string;
  by: string;
  at: number;
  how: 'adopted' | 'updated' | 'installed';
};
/** How a file differs from what the last apply put on the server. */
export type PackChange = 'added' | 'replaced' | 'removed';
/**
 * A file the hub keeps for the server and lays over the pack on every update: at a new path, or replacing the pack's
 * file there (`replaces`). `removed` ones stay, struck through, until an apply. `change`: against the last apply.
 */
export type Extra = {
  id: number;
  target: string;
  sha256: string;
  label: string;
  note: string;
  by: string;
  at: number;
  removed: boolean;
  replaces: boolean;
  change: PackChange | null;
};
/**
 * A find-and-replace in one file, applied after the pack, the Extras and the Mod: `find` is a JavaScript regex (`gm`
 * flags), `replace` may use `$1`. `failedOn`: the version an update failed on because it matched nothing.
 */
export type ConfigEdit = { id: number; path: string; find: string; replace: string; note: string; by: string; at: number; failedOn: string | null };
/** A file the next apply changes: an Extra, or a file whose Config edits changed. */
export type PendingChange = { path: string; kind: 'extra' | 'edit'; change: PackChange };
/**
 * A pack update in the history: `changes` lists what an apply onto the same version changed (null: a version
 * update); `step` the one it was at; `backup` the pre-update backup's name; `log` its last lines (or why it failed).
 */
export type PackUpdateRow = {
  id: number;
  from: string;
  to: string;
  changes: string[] | null;
  by: string;
  started: number;
  finished: number | null;
  outcome: PackOutcome;
  step: PackStepState['step'];
  backup: string | null;
  log: string;
};
/** The update running now: where to (`name`, `version`), who started it, and every step in order. `cancellable`: in Prepare or the Stop countdown. */
export type RunningPackUpdate = {
  id: number;
  name: string;
  version: string;
  by: string;
  started: number;
  steps: PackStepState[];
  cancellable: boolean;
};
/** After an update rolled back: the version it tried, and the pre-update backup to restore (null: none recorded). */
export type PackRollback = { to: string; backup: string | null };
/**
 * `GET /api/servers/:id/pack`: the installed pack (null until adopted), the Kept paths (`server`: its `keep` list;
 * `builtIn`), the Extras, Config edits and pending changes, the history (newest first), the running update, the Mod's
 * jar in `mods/` (null: none), why an update can't start now (`blocked`, null: it can), and the rollback offer.
 */
export type PackState = {
  installed: InstalledPack | null;
  kept: { server: string[]; builtIn: string[] };
  extras: Extra[];
  edits: ConfigEdit[];
  pending: PendingChange[];
  history: PackUpdateRow[];
  running: RunningPackUpdate | null;
  mod: string | null;
  blocked: string | null;
  rolledBack: PackRollback | null;
  /** The files the installed pack itself ships (Kept paths left out), sorted: an Extra at one of them replaces it. */
  packFiles: string[];
  runtime: PackRuntime;
};
/**
 * The Java the server runs on: `name`, the runtime its link (`<root>/java/<server>`) points at, null for the host's own
 * `java`; `pending` until the server's next start after a change. `unitLines`: the two lines its unit needs before the
 * link means anything (null when it names the link already), shown instead of the selector.
 */
export type PackRuntime = { name: string | null; pending: boolean; unitLines: string[] | null };
/** `PUT /api/servers/:id/pack/runtime` (answers `PackState`): a runtime's name, or null for the host's own `java`. 404 unknown runtime. */
export type PackRuntimeRequest = { runtime: string | null };
/**
 * `POST /api/uploads` (`UploadRequest`, `size` at most 4 GiB) starts a chunked upload. `PUT /api/uploads/:upload?offset=<n>`
 * appends a raw `application/octet-stream` body of at most 64 MiB (the one exception to the JSON rule; Origin still
 * checked), only at `offset` = the bytes received so far: otherwise 409 with `UploadProgress`. `GET /api/uploads/:upload`
 * answers `UploadProgress`. Once `received` is `size`, `upload` names it in a source or an Extra, once; uploads are dropped
 * an hour after their last chunk, and cleared when the hub restarts.
 */
export type UploadRequest = { fileName: string; size: number };
export type UploadAnswer = { upload: string };
export type UploadProgress = { received: number };
/** A pack version from the library (`LibraryPack.id`): Compare, Adopt and updates never download anything. 404: no such entry. */
export type PackSource = { library: number };
/** A file in the Adopt report, with its size on the server. */
export type ReportFile = { path: string; size: number };
/**
 * `POST /api/servers/:id/pack/compare` (a `PackSource`; 409 once adopted): how the server
 * folder compares with the pack. `matching` files are the same; `mod` is the Mod's jar; `notInPack` files under
 * `mods/` and `config/` the pack lacks; `different` pack files changed on the server. Kept paths are left out. Held
 * for an hour for `POST …/pack/adopt`.
 */
export type CompareReport = { name: string; version: string; matching: number; mod: string[]; notInPack: ReportFile[]; different: ReportFile[] };
/** `POST /api/servers/:id/pack/adopt`: the report's paths to keep as Extras. Answers `PackState`; changes nothing on disk. */
export type AdoptRequest = { keep: string[] };
/** `POST /api/servers/:id/pack/extras` (answers `PackState`): an upload put at `target`. `PUT …/extras/:id` takes any of upload, label and note. */
export type ExtraRequest = { upload: string; target: string; label?: string; note?: string };
export type ExtraUpdate = { upload?: string; label?: string; note?: string };
/** `POST /api/servers/:id/pack/edits` and `PUT …/edits/:id` (answers `PackState`). An invalid regex is 400. */
export type EditRequest = { path: string; find: string; replace: string; note?: string };
/** `POST /api/servers/:id/pack/edits/preview`: how many lines of the file on the server now `find` matches in (404: no such file). */
export type EditPreviewRequest = { path: string; find: string };
export type EditPreview = { matches: number };
/**
 * `POST /api/servers/:id/pack/update`: a new pack, or `{ pending: true }` to apply the changes pending onto the
 * installed one. Answers 202 with the history row's `id`; steps follow as `packUpdateStep` notices, the end as
 * `packUpdateFinished`. 409 while offline, without a pack, with nothing to change, or while an update, a restore,
 * a Mod deploy or a countdown runs on the server. `POST …/pack/update/cancel`: only in Prepare or the Stop countdown (else 409).
 */
export type PackUpdateRequest = PackSource | { pending: true };
export type PackUpdateAnswer = { id: number };

/**
 * The Pack library (only with systemd and Minecraft): one per Environment. A pack version, by name and version, with
 * its Minecraft version and loader, its zip's size and sha256, where it came from (a URL, or the uploaded file's
 * name), who added it and when, and the servers using it (`usedBy`: ids, whose pack is it or whose running update installs it).
 */
export type LibraryPack = {
  id: number;
  name: string;
  version: string;
  mc: string;
  loader: string;
  sha256: string;
  size: number;
  source: string;
  by: string;
  at: number;
  usedBy: string[];
};
/** The add running now (one at a time): `add` matches its `libraryAdd` events, `detail` is its latest progress. */
export type RunningLibraryAdd = { add: number; kind: 'pack' | 'runtime'; name: string; version: string; by: string; started: number; detail: string };
/**
 * A Java runtime (a Temurin JDK, in `<root>/runtimes/<name>/`): `name` is `temurin-<build>` ("temurin-21.0.8+9"),
 * `label` "Temurin 21.0.8+9", `feature` its Java version, `size` its download's, and the servers whose Java link
 * points at it.
 */
export type LibraryRuntime = { name: string; label: string; feature: number; size: number; sha256: string; by: string; at: number; usedBy: string[] };
/** `GET /api/library`: the packs, newest first, and the running add. */
export type LibraryState = { packs: LibraryPack[]; runtimes: LibraryRuntime[]; running: RunningLibraryAdd | null };
/**
 * `POST /api/library/runtimes`: adds the latest GA Temurin JDK of a Java version (8, 17, 21 or 25) for this host from
 * Adoptium, in the background like a pack add (one add of either kind at a time; its `libraryAdd` events have `id`
 * `runtimes`, name `Temurin`, version the Java version). It's checked against Adoptium's sha256 and counted as
 * installed only once `bin/java -version` runs here; the same build again finishes ok as "already installed".
 * `DELETE /api/library/runtimes/:name`: 404 unknown, 409 while a server's Java link points at it (naming them).
 */
export type RuntimeAddRequest = { feature: 8 | 17 | 21 | 25 };
/**
 * `POST /api/library/packs`: adds a pack version from an `https:` URL or a finished upload, in the background. `mc`
 * and `loader` (only `forge`) left blank are read from the zip's Forge jar (`minecraft_server.<mc>.jar` gives only
 * `mc`); the add fails if they can't be. Name, version and `mc`: at most 100 characters. Answers 202 with the add's
 * number; progress and the end follow as `libraryAdd` events (`target` `library`). 409 while an add runs, and for an
 * upload whose file, or name and version, is in the library already (a URL's only once downloaded: an add of the same
 * file under the same name and version finishes ok, saying so; the other duplicates fail). `POST /api/library/cancel`
 * stops the running add (409 when none, or once it is being stored); it leaves nothing behind. `DELETE
 * /api/library/packs/:id` deletes one (404 unknown, 409 while used, naming the servers). All audited.
 */
export type LibraryAddRequest = ({ url: string } | { upload: string }) & { name: string; version: string; mc?: string; loader?: string };
export type LibraryAddAnswer = { add: number };
/**
 * `GET /api/library/packs/:id/scripts`: a pack's start scripts (its content root's `*.sh`), each with whether it loops
 * (`while true`) and whether it sets the heap (`-Xmx`/`-Xms`: New server refuses one that doesn't).
 */
export type StartScript = { name: string; loops: boolean; memory: boolean };
export type StartScripts = { scripts: StartScript[] };

/**
 * `POST /api/servers` (only with `Integrations.newServer`): installs a library pack into `<root>/servers/<id>` as a
 * Pending server, in the background. `memory` is a heap size like `6G` (a Config edit on the start script's `-Xmx`/`-Xms`);
 * `runtime` a library runtime's name, null for system java; `removeLoop` adds the Config edit that takes the start
 * script's `while true` loop out. Refused before anything is written: 400 bad input (an id not `^[a-z][a-z0-9-]{0,31}$`,
 * a port outside 1–65535, no EULA, a bad memory or an unknown start script), 404 an unknown pack or runtime, 409 an id,
 * game port or unit already taken, a pack whose Minecraft version has no Mod build, or while an install or a library
 * add runs. Answers 202; its steps follow as `install` events (`target` `install`, `id` the server's). Audited.
 */
export type NewServerRequest = {
  id: string;
  name: string;
  gamePort: number;
  memory: string;
  library: number;
  startScript: string;
  runtime: string | null;
  eula: boolean;
  removeLoop: boolean;
};
export type NewServerAnswer = { id: string };
/**
 * A Pending server: installed, waiting for its owner to run `command` (`add-server.sh`) as root. `installScript`: the
 * line that installs the root copy of the script first, null when it is there already.
 */
export type PendingServer = {
  id: string;
  name: string;
  dir: string;
  gamePort: number;
  runtime: string | null;
  by: string;
  at: number;
  command: string;
  installScript: string | null;
};
/** The install running now: its server's id and name, who started it, and its latest step. */
export type RunningInstall = { id: string; name: string; by: string; started: number; step: string; detail: string };
/**
 * `GET /api/servers/pending`: the Pending servers, oldest first, and the running install. `DELETE
 * /api/servers/pending/:id` discards one, folder, Java link and all (404 unknown, 409 once it is in config). Audited.
 */
export type PendingServers = { pending: PendingServer[]; installing: RunningInstall | null };

/**
 * Game updates (a factorio server only; others 404): moving it to another Factorio version or set of mods, with the
 * Pack update's steps (`PackStepState`, the `packUpdate*` notices) and history rows (`PackUpdateRow`: `from` and `to`
 * like "2.1.24 · 5 mods", the mod changes in `changes`). The routes are registered before the online check, so they
 * answer for a stopped server too. Actions are audited as the admin.
 */
/**
 * `GET /api/servers/:id/game`: what the server runs (`installed`, as its Agent last reported it: the Factorio version
 * and every enabled mod, `base` and the game's own included; null until it has), the history (newest first), the
 * running update, and why an update can't start now (`blocked`, null: it can).
 */
export type GameState = {
  installed: { factorio: string; mods: FactorioMod[] } | null;
  history: PackUpdateRow[];
  running: RunningGameUpdate | null;
  blocked: string | null;
};
/** The game update running now: from and to (as in its history row), who started it, every step in order; `cancellable` before the swap. */
export type RunningGameUpdate = { id: number; from: string; to: string; by: string; started: number; steps: PackStepState[]; cancellable: boolean };
/** A mod picked for a game update by its portal name: a version, or null for the newest that fits the Factorio version. */
export type GameModPick = { name: string; version: string | null };
/**
 * `POST /api/servers/:id/game/catalog` and `POST …/game/update`: the Factorio version to run and the portal mods to
 * have (the game's own mods, like `base`, come with it). A mod left out is removed.
 */
export type GameUpdateRequest = { factorio: string; mods: GameModPick[] };
/** A Factorio release on offer: the latest headless one of each channel; one on both is listed once, as stable. */
export type FactorioRelease = { version: string; channel: 'stable' | 'experimental' };
/**
 * A mod as the catalog resolved it: its title, the version it picked, every release that fits the Factorio version
 * (newest first), and the mod whose required dependency added it (`requiredBy`, null: picked).
 */
export type CatalogMod = { name: string; title: string; version: string; releases: string[]; requiredBy: string | null };
/** A dependency the catalog can't meet: the mod that has it, the dependency as the portal writes it ("flib >= 0.16"), and why. */
export type UnresolvedDependency = { mod: string; dependency: string; reason: string };
/**
 * The answer to `POST /api/servers/:id/game/catalog`: the Factorio releases on offer (one on both channels listed
 * once, as stable), the picked mods with every
 * required dependency resolved transitively (honouring `base` limits and `!` incompatibilities; optional ones left
 * out), what it can't resolve (an update can't start while any remain) and what the update would change ("Added:
 * flib 0.16.2"). 404 for a picked mod the portal doesn't have, 502 if the portal can't be read.
 */
export type GameCatalog = { versions: FactorioRelease[]; mods: CatalogMod[]; unresolved: UnresolvedDependency[]; changes: string[] };
/**
 * `POST /api/servers/:id/game/update` (a `GameUpdateRequest`): starts a game update, answered 202 with its history
 * row's `id`; steps follow as `packUpdateStep` notices, the end as `packUpdateFinished`. 400 for bad input, 409 with
 * unresolved dependencies, nothing to change, its Agent not connected, or while an update, a restore, an Agent deploy
 * or a countdown runs on the server. `POST …/game/update/cancel`: only before the swap (else 409).
 */
export type GameUpdateAnswer = { id: number };
/** How the mod browser sorts: most downloaded first, newest release first, or by name (the title it shows, case aside). */
export type PortalSort = 'downloads' | 'updated' | 'name';
/** A portal category: its id (`mod-packs`) and title ("Mod packs"). */
export type PortalCategory = { id: string; title: string };
/**
 * A mod on the portal as the browser shows it: name, title, owner, summary (plain text, cut), downloads, its newest
 * release for the line (`version`, `updated` epoch ms or null), category id or null, whether it needs Space Age, and
 * its portal page (built by the hub). Every string is the portal's, checked and cut by the hub: show it as text.
 */
export type PortalListing = {
  name: string;
  title: string;
  owner: string;
  summary: string;
  downloads: number;
  version: string;
  updated: number | null;
  category: string | null;
  spaceAge: boolean;
  page: string;
};
/**
 * `GET /api/servers/:id/game/mods?factorio=&q=&category=&sort=&page=`: one page (24) of the portal's mods for the
 * Factorio version's line, deprecated ones left out, with how many match and the categories to filter by. 400 for a
 * bad parameter, 502 if the portal can't be read. `GET …/game/mods/:name/thumbnail`: the mod's thumbnail, a PNG
 * (404 when it has none).
 */
export type ModBrowse = { line: string; total: number; mods: PortalListing[]; categories: PortalCategory[] };
/**
 * `POST /api/servers/:id/game/check`: the Import mod list's question, before anything is picked: does the portal have
 * these mods (by name, at most 500, none the game's own or given twice) for the Factorio version's line?
 */
export type ModCheckRequest = { factorio: string; names: string[] };
/**
 * One name's answer: `fits` (the portal has a release for the line: `latest` is the newest, `title` its title),
 * `noRelease` (on the portal, none for the line), `missing` (the portal has no such mod) or `unchecked` (not in the
 * line's list, and past the hub's cap on reading mods one by one: add it by name to find out). Titles are the portal's,
 * checked and cut: show them as text.
 */
export type ModCheck = { name: string; found: 'fits' | 'noRelease' | 'missing' | 'unchecked'; title: string | null; latest: string | null };
/** The answer to `POST …/game/check`: the line asked about and each name's `ModCheck`, in the order asked. 400 for a bad body, 502 if the portal can't be read. */
export type ModCheckAnswer = { line: string; mods: ModCheck[] };

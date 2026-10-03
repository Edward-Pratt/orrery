/**
 * The HTTP API's types, for the dashboard to import type-only. Imports only pure type files (no Node types), so it
 * compiles on its own: `npm run typecheck` checks that with `tsconfig.api.json`.
 */
import type {
  AuditRow,
  BackupsAnswer,
  DeployPart,
  DeployRow,
  Release,
  HistoryAnswer,
  HostSample,
  FeedEvent,
  PackOutcome,
  PackStepState,
  Period,
  PlaytimeAnswer,
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
  HistoryAnswer,
  HostSample,
  HubEvent,
  Lifecycle,
  Notice,
  PackFinished,
  PackOutcome,
  PackStep,
  PackStepState,
  Period,
  PlaytimeAnswer,
  Release,
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

/** `GET /api/integrations`: which integrations are switched on. */
export type Integrations = { minecraft: boolean; discord: boolean; web: boolean; checks: boolean; host: boolean; systemd: boolean; github: boolean };

/**
 * `GET /api/host` (only with the host integration): the host's id and its latest sample, null until the first (a
 * minute after the hub starts). Each new sample is also a `sample` event on the stream.
 */
export type HostNow = { id: string; sample: HostSample | null };

/**
 * `GET /api/host/samples[?hours=1–2160]`: the host's samples over the last `hours` (default 24), oldest first. Up to
 * 25 hours they are the raw minutes; a longer period is at most `HISTORY_POINTS` (1500, `host.ts`) equal time buckets,
 * each the average of its samples (`ts` too; a mount over the samples that have it).
 */
export type HostHistory = HostSample[];



/**
 * A part's releases: the one `running` (the hub: `dev` from a plain checkout; the dashboard: null if unknown; a Mod:
 * `mod-v` + the version its hello reported, as is when that isn't a release, null if it never connected), the
 * `latest` published one (null: none), and every published one, newest first.
 */
export type PartReleases = { running: string | null; latest: string | null; releases: Release[] };

/**
 * `GET /api/deploys[?before=id]` (only with the GitHub integration): what each part runs against what GitHub has
 * published (drafts and prereleases left out), each server's Mod, when GitHub was last asked (`checkedAt`, null: not
 * yet) and why that failed (`error`), `newerAfterDays`, and a batch (50) of the deploy history, newest first, with
 * whether `older` ones remain (`before` is a row's `id`). Changes come as `deployStarted`/`deployFinished` notices.
 */
export type DeploysAnswer = {
  hub: PartReleases;
  web: PartReleases;
  mod: { latest: string | null; releases: Release[]; servers: { id: string; name: string; running: string | null }[] };
  checkedAt: number | null;
  error: string | null;
  newerAfterDays: number;
  history: DeployRow[];
  older: boolean;
  /** The servers a pack update runs on: no Mod deploy onto them, and no hub deploy, meanwhile. */
  packing: string[];
};

/**
 * `POST /api/deploys`: deploys a published release (`server`: the Mod's server). Answers 202 with the history row's
 * `id`; the outcome follows as a `deployFinished` notice. 404 for a tag GitHub didn't list or an unknown server, 409
 * when refused (another deploy runs, the tag is the one running, a restore runs, below the first release that can
 * deploy, a server with no folder, no Mod or a countdown running), 502 if systemctl or the download fails. Audited.
 * `POST /api/deploys/check` asks GitHub again and answers like `GET /api/deploys`.
 */
export type DeployRequest = { part: DeployPart; tag: string; server?: string };
export type DeployAnswer = { id: number };

/** `GET /api/services/:id/logs`: its last 200 journal lines, oldest first. 404 for an unlisted id, 502 if journalctl fails. */
export type ServiceLogs = { lines: string[] };

/**
 * The answer to `POST /api/services/:id/start`, `/stop` and `/restart` (no body; audited as the admin). The action
 * doesn't wait for systemd: the new state follows as `state` events. Stopping or restarting a service whose linked
 * server has players online first counts down in game (the server card's `restart`, cancelled like a restart): `at`
 * is when it will run, null if it ran at once. 404 for an unlisted id, 409 if a countdown is already running on the
 * server, 502 if systemctl fails.
 */
export type ServiceActionAnswer = { at: number | null };

/** What a server has; chat, TPS and quests only for a Minecraft server with the mod (a token configured). */
export type Features = { chat: boolean; tps: boolean; quests: boolean };

/** A countdown restart (or, with `stop`, a countdown stop of its service) in progress: when it fires and who scheduled it. */
export type PendingRestart = { at: number; by: string; stop: boolean };

/**
 * `GET /api/servers`: one card per server. `tps` is null without the TPS feature. `lagging` is true while the server
 * is in a lag alert (the rule and `lagTps`/`lagMinutes` thresholds of Discord's lag notice; refetch on the `lag` and
 * `lagRecovered` notices). `service` is the systemd service it runs as: its id and active state (null until the hub
 * has read it); the whole field is null with no linked service or with systemd off (refetch on that service's
 * `state` events).
 */
export type ServerCard = {
  id: string;
  name: string;
  online: boolean;
  hung: boolean;
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
};

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
 * heartbeats when TPS moved by 0.1 or more; a replay holds only each online server's latest. `at` is when the hub saw
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

/** `POST /api/servers/:id/command`: a console command, answered with `CommandOutput`; later output comes as `console` events. */
export type CommandRequest = { command: string };

/** `POST /api/servers/:id/restart`: a countdown restart in 0–60 whole minutes. 204; cancel with `POST …/restart/cancel`. */
export type RestartRequest = { minutes: number };

/**
 * `POST /api/servers/:id/restore` (only with systemd): puts the named backup (one of the server's listed ones) back over
 * its world with `deploy/restore-backup.sh`, keeping the current world as a pre-restore copy; answered with the
 * script's output (`CommandOutput`: its next steps). Only while the server's linked service is stopped (inactive or
 * failed), else 409, as without a linked service or with a restore already running; 404 for an unknown server or
 * backup; 502 with the script's error output if it fails. Every attempt is audited.
 */
export type RestoreRequest = { name: string };

/** The answer to a command, to `POST /api/servers/:id/backup` and to a restore. */
export type CommandOutput = { output: string[] };

/**
 * Packs (only for a server with a folder, a linked service and a Mod token; others 404). Every path is relative to the
 * server's folder. Actions are audited as the admin; `PackRefused` answers 400 (bad input), 404 or 409 (not now; Extras and Config edits change
 * only while no update runs).
 */
/** The installed pack: `source` is its URL, or the uploaded file's name; `how` it arrived. */
export type InstalledPack = {
  name: string;
  version: string;
  source: string;
  sha256: string;
  by: string;
  at: number;
  how: 'adopted' | 'updated';
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
};
/**
 * `POST /api/servers/:id/pack/uploads`: the raw file as the body (`application/zip`, `application/java-archive` or
 * `application/octet-stream`, the one exception to the JSON rule; Origin still checked), its name in `x-file-name`;
 * at most 4 GiB. `upload` names it in a source or an Extra, once; unused ones are cleared when the hub restarts.
 */
export type UploadAnswer = { upload: string; fileName: string; size: number };
/** A pack zip: an `https:` URL the hub downloads, or an upload. */
export type PackSource = { url: string; name: string; version: string } | { upload: string; name: string; version: string };
/** A file in the Adopt report, with its size on the server. */
export type ReportFile = { path: string; size: number };
/**
 * `POST /api/servers/:id/pack/compare` (a `PackSource`; 409 once adopted, 502 if the download fails): how the server
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

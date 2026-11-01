/**
 * The hub's plain data types: the wire messages, its events, audit entries and stats answers. Pure types that import
 * nothing, so the dashboard can type-check the API types (`api.ts`) without the hub's runtime or Node types. The
 * modules that own them re-export them (the wire messages from `protocol.ts`, which validates against them).
 */
export type Hello = { type: 'hello'; protocol: number; serverId: string; token: string; modVersion: string };

/**
 * A game connection's messages to the hub: a Mod's, or an Agent's for its Factorio server (`milestone` and
 * `heartbeat.paused` only from an Agent; it sends no `achievement`, `quest` or `cmdLate`).
 */

export type ModMsg =
  | { type: 'started' }
  | { type: 'stopping' }
  | { type: 'heartbeat'; tps: number; players: string[]; dims?: DimTime[]; paused?: boolean }
  | { type: 'chat'; player: string; message: string }
  | { type: 'join'; player: string }
  | { type: 'leave'; player: string }
  | { type: 'death'; player: string; message: string }
  | { type: 'achievement'; player: string; achievement: string }
  | { type: 'cmdResult'; id: string; output: string[] }
  | { type: 'cmdLate'; id: string; output: string[] }
  | { type: 'quest'; player: string; quests: QuestDone[] }
  | { type: 'link'; player: string; uuid: string; code: string }
  | { type: 'unlink'; player: string }
  | { type: 'backup'; ok: boolean; detail: string }
  | { type: 'milestone'; kind: MilestoneKind; text: string; player?: string; force?: string };

/** What a Factorio `milestone` is: a research finished, or a force's first rocket, space platform or landing on a planet. */
export type MilestoneKind = 'research' | 'rocket' | 'platform' | 'landing';

/** A dimension's mean tick time. */
export type DimTime = { id: number; name: string; ms: number };
/** A completed quest. */
export type QuestDone = { name: string; main: boolean };

export type HubMsg =
  | { type: 'welcome' }
  | { type: 'reject'; reason: string }
  | { type: 'say'; author: string; message: string; source: ChatSource }
  | { type: 'cmd'; id: string; command: string }
  | { type: 'linkResult'; player: string; ok: boolean; message: string }
  /** To an Agent's game connection only: a system line in game (countdowns); a Mod gets `cmd` `say …` instead. */
  | { type: 'notice'; message: string }
  /** To an Agent's game connection only: make a named save, answered with `backup`. */
  | { type: 'save' };

/** The first line of an Agent connection, on the Agent port. `protocol` is the same number as a Mod's hello. */
export type AgentHello = { type: 'agentHello'; protocol: number; agentId: string; token: string; agentVersion: string };

/**
 * An Agent connection's messages to the hub. `serviceState` is its unit's systemd ActiveState (`active`), SubState
 * (`sub`), when that last changed (`since`, epoch ms) and Result (`result`, e.g. `success`, `exit-code`).
 * `updateStep` and `updateDone` carry the id of the `update` request that started the update. `events` says whether
 * the Agent forwards its server's game events: off (`reason`: why) until Factorio's next start, or on again. `reply`
 * answers a request by its `id`: `error` says why when not `ok`, and `data` is the request's `AgentReplyData`, if it
 * has any.
 */
export type AgentMsg =
  | { type: 'ping' }
  | { type: 'bye' }
  | { type: 'hostSample'; sample: HostSample }
  | { type: 'serviceState'; unit: string; active: string; sub: string; since: number; result: string }
  | { type: 'saves'; saves: Save[]; free: number }
  | { type: 'installed'; factorio: string; mods: FactorioMod[] }
  | ({ type: 'updateStep'; id: string } & PackStepState)
  | { type: 'updateDone'; id: string; outcome: PackFinished; from: string; to: string; backup?: string }
  | { type: 'deployResult'; tag: string; outcome: Exclude<DeployOutcome, 'running'>; log: string }
  | { type: 'events'; on: boolean; reason?: string }
  | { type: 'reply'; id: string; ok: boolean; error?: string; data?: unknown };

/**
 * The hub's requests to an Agent, each answered by a `reply` with its `id` (30 s unless noted). `serviceAct` runs
 * `systemctl <action> --no-block` on its own unit; `journal` is the last 200 lines of a unit's log file (`unit`: the
 * server's unit or the Agent's own); `logs` lists the log files it serves and `log` is the last 1000 lines of one;
 * `restore` copies a listed save as the newest while the unit is stopped (10 min); `update` starts a game update (the reply
 * means accepted; its id is the update's), `updateResume` continues the running one after the hub's stop and
 * `updateCancel` cancels it before the swap; `deploy` starts the Agent's own deploy of a release (the reply means
 * started).
 */
export type AgentRequest =
  | { type: 'serviceAct'; id: string; action: ServiceVerb }
  | { type: 'journal'; id: string; unit: string }
  | { type: 'logs'; id: string }
  | { type: 'log'; id: string; name: string }
  | { type: 'restore'; id: string; name: string }
  | { type: 'update'; id: string; factorio: FactorioDownload; mods: FactorioModDownload[] }
  | { type: 'updateResume'; id: string }
  | { type: 'updateCancel'; id: string }
  | { type: 'deploy'; id: string; tag: string };
/** Everything the hub sends on an Agent connection: the handshake's answer, then requests. */
export type HubAgentMsg = Extract<HubMsg, { type: 'welcome' | 'reject' }> | AgentRequest;
/** What an `ok` reply's `data` holds, for the requests that answer with data (the others send none). */
export type AgentReplyData = {
  journal: { lines: string[] };
  logs: { files: LogFile[] };
  log: { lines: string[] };
};

/** A Factorio mod from the mod portal (or one that comes with the game, like `base`), at one version. */
export type FactorioMod = { name: string; version: string };
/** A Factorio release for a game update: its version, the headless download and that file's sha256. */
export type FactorioDownload = { version: string; url: string; sha256: string };
/** A mod for a game update: the release's download (a resolved link, no credentials) and its sha1. */
export type FactorioModDownload = FactorioMod & { sha1: string; url: string };

/**
 * What kind of save a Factorio server's file is: `named`, one the Agent made (`orrery-<time>.zip`, pre-update ones
 * too); `auto`, Factorio's own `_autosave*.zip`; `world`, anything else (the setup's world, a restored copy).
 */
export type SaveKind = 'named' | 'auto' | 'world';
/** A save as an Agent lists it: `mtime` in epoch ms; `current` marks the file Factorio last loaded (it saves into it on every stop). */
export type Save = { name: string; size: number; mtime: number; kind: SaveKind; current: boolean };

/** Where a chat line sent into the game came from. */
export type ChatSource = 'discord' | 'dashboard';

/** A Backup, or a factorio server's save (only those have a `kind`, and `current` on the world Factorio last loaded). */
export type Backup = { name: string; size: number; mtimeMs: number; kind?: SaveKind; current?: boolean };
export type BackupStats = { count: number; total: number; free: number | null; growth: number | null };
/** A log file or crash report in a server folder: its name (no folder), size in bytes and modified time (epoch ms). */
export type LogFile = { name: string; size: number; modified: number };

/** The daily summary, as `Stats.summary` answers it. */
export type Summary = {
  day: string;
  uptime: number | null;
  peak: number | null;
  unique: number;
  totalMs: number;
  top: { player: string; ms: number }[];
  starts: number;
  crashes: number;
  /** Only for servers with a Backup folder. */
  backups?: BackupStats;
};

/** Which game a server runs: it decides what the server offers, its rate and its wording. */
export type Game = 'minecraft' | 'factorio';
/** How fast a game runs at full speed: Minecraft's ticks per second, Factorio's updates per second. */
export type Rate = { label: 'TPS' | 'UPS'; max: 20 | 60 };

export type ServerState = {
  id: string;
  name: string;
  game: Game;
  online: boolean;
  hung: boolean;
  /** A factorio server paused (auto-pause with nobody on, or an admin's pause): its rate means nothing then. */
  paused: boolean;
  tps: number | null;
  players: string[];
  /** Slowest dimensions from the latest heartbeat (empty with an older mod). */
  dims: DimTime[];
};

/**
 * A server's lifecycle events. `lost`: its Agent left (a planned exit, or lost): silent, recorded as unknown, and
 * its players and rate cleared.
 */
export type Lifecycle = 'connected' | 'started' | 'stopped' | 'crashed' | 'hung' | 'recovered' | 'offline' | 'lost';
export type GameMsg = Extract<
  ModMsg,
  { type: 'chat' | 'join' | 'leave' | 'death' | 'achievement' | 'quest' | 'link' | 'unlink' | 'backup' | 'milestone' }
>;
/** How much a notice matters; frontends pick colours from it. */
export type Severity = 'problem' | 'warning' | 'good' | 'info';
/** Something a hub-core module wants people to know about a server. Never sent by a mod. */
export type Notice = { severity: Severity } & (
  | { kind: 'restartScheduled'; ms: number; by: string; stop?: true }
  | { kind: 'restartNow'; stop?: true }
  | { kind: 'restartCancelled'; by: string }
  | { kind: 'restartCancelledDown' }
  | { kind: 'restartFailed'; error: string }
  | { kind: 'lag'; tps: number; label: Rate['label']; worst: DimTime | null }
  | { kind: 'lagRecovered'; tps: number; label: Rate['label'] }
  | { kind: 'backupOverdue'; hours: number; newest: string }
  | { kind: 'backupsMissing' }
  | { kind: 'lowDisk'; free: number; minFreeGB: number }
  | { kind: 'backupFinished'; detail: string }
  | { kind: 'backupFailed'; detail: string }
  | { kind: 'packUpdateStarted'; from: string; to: string; by: string }
  | ({ kind: 'packUpdateStep'; cancellable: boolean } & PackStepState)
  | { kind: 'packUpdateFinished'; outcome: PackFinished; from: string; to: string; ms: number; backup?: string }
);
/** A pack update's steps, in order; `rollback` only when the health gate saw no hello. */
export type PackStep = 'prepare' | 'backup' | 'stop' | 'swap' | 'gate' | 'rollback';
/** Where a pack update's step is, with its live detail or result ("Staged: 2,318 files"). */
export type PackStepState = { step: PackStep; state: 'waiting' | 'running' | 'done' | 'failed'; detail: string };
/** `failed before swap`: stopped, then failed before any file moved (the old pack starts again); `failed`: not back even after a rollback. */
export type PackOutcome = 'running' | 'ok' | 'rolled back' | 'failed in staging' | 'failed before swap' | 'failed' | 'cancelled';
export type PackFinished = Exclude<PackOutcome, 'running'>;
/**
 * What a hub-core module posts for people to see. `count` exceeds `quests.length` for a batched roll-up; a summary
 * carries the server's name for its heading.
 */
export type Announcement =
  | { type: 'questBatch'; player: string; quests: QuestDone[]; count: number }
  | { type: 'linked'; player: string; discordId: string }
  | { type: 'summary'; name: string; summary: Summary };
/**
 * Chat sent into the game (`say`; `avatar` is the admin's Discord avatar URL, on dashboard lines only, and never sent
 * to the mod), and a command's output (`late`: output that came after the result).
 */
export type HubOutput =
  | (Extract<HubMsg, { type: 'say' }> & { avatar?: string })
  | { type: 'console'; command: string; by: string; output: string[]; late?: true };
export type HubEvent = { serverId: string } & (
  | GameMsg
  | { type: Lifecycle }
  | ({ type: 'notice' } & Notice)
  | Announcement
  | HubOutput
  | Tps
  | Paused
);
/** A server's TPS, from heartbeats, only when it moved by 0.1 or more. The live feed keeps just the latest. */
export type Tps = { type: 'tps'; tps: number };
/**
 * A factorio server's heartbeat changed its `paused` (a Mod's never does): the dashboard fetches its card again. The
 * live feed keeps just the latest.
 */
export type Paused = { type: 'paused'; paused: boolean };

/**
 * `GET /api/checks` (only with the checks integration): each check's current state. `up` and the rest are null
 * until its first answer; `ms` is how long that took, `error` why it was down ("HTTP 503", "timed out", ECONNREFUSED).
 * `service` is the id of its linked service, if any.
 */
export type CheckStatus = {
  id: string;
  url: string;
  up: boolean | null;
  ms: number | null;
  error: string | null;
  checkedAt: number | null;
  service: string | null;
};

/**
 * `GET /api/services` (only with the systemd integration): each listed unit's systemd ActiveState (`state`: active,
 * inactive, failed, activating…) and SubState (`sub`), null until first read, and the ids of the checks linked to
 * it. Changes come as `state` events on the stream; a failure is also a notice.
 */
export type ServiceStatus = { id: string; unit: string; state: string | null; sub: string | null; checks: string[] };

/** What `POST /api/services/:id/<verb>` does to a service. */
export type ServiceVerb = 'start' | 'stop' | 'restart';

/**
 * What an event that isn't about a server is about; its `id` is that thing's config id (a Host's: the hub's own, or
 * its Agent's; a deploy's: its target, the environment or, for a Mod, the server id, for an Agent, its id; the
 * library's: `packs`).
 */
export type Target = 'host' | 'service' | 'check' | 'deploy' | 'library' | 'install';
/** Something a hub-core module wants people to know about the host, a service, a check or a deploy. */
export type TargetNotice = { severity: Severity } & (
  | { kind: 'checkDown'; url: string; error: string }
  | { kind: 'checkUp'; url: string; ms: number }
  | { kind: 'memoryHigh'; percent: number; minutes: number }
  | { kind: 'memoryOk'; percent: number }
  | { kind: 'diskLow'; mount: string; free: number; minFreeGB: number }
  | { kind: 'diskOk'; mount: string; free: number }
  | { kind: 'serviceFailed'; unit: string }
  /** About a Host (`id`: the Agent's): its Agent went silent or closed without `bye`, then came back. */
  | { kind: 'agentLost'; name: string }
  | { kind: 'agentBack'; name: string }
  /** About a Host (`id`: the Agent's): its Agent turned its server's game events off (`reason`, the Agent's words), then on again. */
  | { kind: 'eventsOff'; name: string; reason: string }
  | { kind: 'eventsOn'; name: string }
  | { kind: 'deployStarted'; part: DeployPart; from: string | null; to: string; by: string }
  | { kind: 'deployFinished'; part: DeployPart; from: string | null; to: string; outcome: DeployOutcome }
);
/** What a deploy puts in place: the hub, the dashboard (`web`), a server's Mod or a Host's Agent. */
export type DeployPart = 'hub' | 'web' | 'mod' | 'agent';
export type DeployOutcome = 'running' | 'ok' | 'failed' | 'rolled back';
/**
 * A deploy in the history: `target` is the environment, the server id for a Mod, or the Agent's id; `from` the release it replaced
 * (null: unknown); `log` the last lines of what it did (or why it failed).
 */
export type DeployRow = {
  id: number;
  part: DeployPart;
  target: string;
  from: string | null;
  to: string;
  by: string;
  started: number;
  finished: number | null;
  outcome: DeployOutcome;
  log: string;
};
/** A published GitHub release of one part: its tag (`hub-v1.2.3`), when it was published, its assets' names. */
export type Release = { tag: string; publishedAt: number; assets: string[] };
/**
 * One minute of a host: the share of CPU time busy since the previous sample (0–1), the 1/5/15-minute load averages,
 * and memory and each watched mount's disk in bytes.
 */
export type HostSample = {
  ts: number;
  cpu: number;
  load: number[];
  memory: { used: number; total: number };
  disks: { mount: string; free: number; total: number }[];
};
/**
 * An event about the host, a service or a check: a notice, a host's `sample` or a check's `checked` result after
 * each request (the live feed keeps only the latest of each), or a service's new systemd `state` (ActiveState, e.g. active, failed) and `sub` (SubState, e.g. running, dead).
 */
export type TargetEvent = { target: Target; id: string } & (
  | ({ type: 'notice' } & TargetNotice)
  | { type: 'sample'; sample: HostSample }
  | { type: 'state'; state: string; sub: string }
  | { type: 'checked'; status: CheckStatus }
  | LibraryAdd
  | InstallStep
);
/**
 * A library add (`target` `library`, `id` `packs`): its progress (`detail`: "Downloading 412 MB of 1,024 MB"; the live
 * feed keeps only the latest), then once `finished`, with why it `failed` (`reason`). `add` numbers the adds of a hub run.
 */
export type LibraryAdd = { type: 'libraryAdd'; add: number; name: string; version: string; by: string } & (
  | { phase: 'progress'; detail: string }
  | { phase: 'finished'; outcome: 'ok' | 'cancelled' | 'failed'; reason: string }
);
/**
 * A New server install (`target` `install`, `id` the new server's): each step as it starts (`unpack`, `write`, `mod`),
 * then `done` or `failed` (`detail`: why). `name` is the server's name, `by` the admin's.
 */
export type InstallStep = { type: 'install'; step: 'unpack' | 'write' | 'mod' | 'done' | 'failed'; detail: string; name: string; by: string };
/** Everything on the live stream: server events and the rest. */
export type LiveEvent = HubEvent | TargetEvent;
/** A live event as the feed keeps it: `at` is when it entered the feed (epoch ms, the hub's clock). */
export type FeedEvent = LiveEvent & { at: number };

/** An action taken on a server, for the audit log. `actor` is e.g. "discord:alice (123)", or "hub:daily" for the hub itself. */
export type AuditEntry = { actor: string; action: string; target: string; details: string };
/** An audit entry as stored: `id` is its cursor for paging back. */
export type AuditRow = AuditEntry & { id: number; ts: number };

export type TpsStats = { avg: number; min: number } | null;

export type StatusAnswer = { state: ServerState; uptimeDay: number | null; uptimeWeek: number | null };
export type TpsAnswer = { state: ServerState; lastHour: { ts: number; tps: number }[]; hour: TpsStats; day: TpsStats };
export type PlaytimeAnswer =
  | { found: true; player: string; totalMs: number; weekMs: number; lastSeen: { online: true } | number | null }
  | { found: false; reason: 'noInput' | 'notLinked' };
/**
 * A Server with no Backup source (neither a Backup folder nor an Agent) has no Backup answers at all, rather than an
 * empty list. A factorio server's Backups are the saves its Agent last pushed (none, and `free` null, before its first).
 */
export type BackupsAnswer =
  | { configured: false }
  | {
      configured: true;
      backups: Backup[];
      free: number | null;
      /** Bytes per day. */
      growth: number | null;
      /** The free space (bytes) under which the hub warns: the server's `backupMinFreeGB`. */
      minFree: number;
    };
/** A server's state over time: up, down (stopped, crashed, offline), hung, or unknown (the hub wasn't running). */
export type UptimeState = 'up' | 'down' | 'hung' | 'unknown';
/**
 * A server's history over a period, each series oldest first. `tps` is its samples (averaged into time buckets over
 * 25 hours), null without the mod; `players` and `uptime` are step series: a point wherever the value changes, the
 * first at the period's start (uptime: if known), `players` ending with the live count.
 */
export type HistoryAnswer = {
  tps: { ts: number; tps: number }[] | null;
  players: { ts: number; count: number }[];
  uptime: { ts: number; state: UptimeState }[];
};
/** `/top` periods: the last 24 hours, the last 7 days, all time. */
export type Period = 'day' | 'week' | 'all';

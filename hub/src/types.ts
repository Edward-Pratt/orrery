/**
 * The hub's plain data types: the wire messages, its events, audit entries and stats answers. Pure types that import
 * nothing, so the dashboard can type-check the API types (`api.ts`) without the hub's runtime or Node types. The
 * modules that own them re-export them (the wire messages from `protocol.ts`, which validates against them).
 */
export type Hello = { type: 'hello'; protocol: number; serverId: string; token: string; modVersion: string };

export type ModMsg =
  | { type: 'started' }
  | { type: 'stopping' }
  | { type: 'heartbeat'; tps: number; players: string[]; dims?: DimTime[] }
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
  | { type: 'backup'; ok: boolean; detail: string };

/** A dimension's mean tick time. */
export type DimTime = { id: number; name: string; ms: number };
/** A completed quest. */
export type QuestDone = { name: string; main: boolean };

export type HubMsg =
  | { type: 'welcome' }
  | { type: 'reject'; reason: string }
  | { type: 'say'; author: string; message: string; source: ChatSource }
  | { type: 'cmd'; id: string; command: string }
  | { type: 'linkResult'; player: string; ok: boolean; message: string };

/** Where a chat line sent into the game came from. */
export type ChatSource = 'discord' | 'dashboard';

export type Backup = { name: string; size: number; mtimeMs: number };
export type BackupStats = { count: number; total: number; free: number | null; growth: number | null };

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

export type ServerState = {
  id: string;
  name: string;
  online: boolean;
  hung: boolean;
  tps: number | null;
  players: string[];
  /** Slowest dimensions from the latest heartbeat (empty with an older mod). */
  dims: DimTime[];
};

export type Lifecycle = 'connected' | 'started' | 'stopped' | 'crashed' | 'hung' | 'recovered' | 'offline';
export type GameMsg = Extract<
  ModMsg,
  { type: 'chat' | 'join' | 'leave' | 'death' | 'achievement' | 'quest' | 'link' | 'unlink' | 'backup' }
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
  | { kind: 'lag'; tps: number; worst: DimTime | null }
  | { kind: 'lagRecovered'; tps: number }
  | { kind: 'backupOverdue'; hours: number; newest: string }
  | { kind: 'backupsMissing' }
  | { kind: 'lowDisk'; free: number; minFreeGB: number }
  | { kind: 'backupFinished'; detail: string }
  | { kind: 'backupFailed'; detail: string }
);
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
);
/** A server's TPS, from heartbeats, only when it moved by 0.1 or more. The live feed keeps just the latest. */
export type Tps = { type: 'tps'; tps: number };

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

/** What an event that isn't about a server is about; its `id` is that thing's config id. */
export type Target = 'host' | 'service' | 'check';
/** Something a hub-core module wants people to know about the host, a service or a check. */
export type TargetNotice = { severity: Severity } & (
  | { kind: 'checkDown'; url: string; error: string }
  | { kind: 'checkUp'; url: string; ms: number }
  | { kind: 'memoryHigh'; percent: number; minutes: number }
  | { kind: 'memoryOk'; percent: number }
  | { kind: 'diskLow'; mount: string; free: number; minFreeGB: number }
  | { kind: 'diskOk'; mount: string; free: number }
  | { kind: 'serviceFailed'; unit: string }
);
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
);
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
/** A Server without a Backup folder has no Backup answers at all, rather than an empty list. */
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

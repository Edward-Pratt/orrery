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
  | { type: 'say'; author: string; message: string }
  | { type: 'cmd'; id: string; command: string }
  | { type: 'linkResult'; player: string; ok: boolean; message: string };

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
  | { kind: 'restartScheduled'; ms: number; by: string }
  | { kind: 'restartNow' }
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
/** Chat sent into the game (`say`), and a command's output (`late`: output that came after the result). */
export type HubOutput =
  | Extract<HubMsg, { type: 'say' }>
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

/** An action taken on a server, for the audit log. `actor` is e.g. "discord:alice (123)", or "hub:daily" for the hub itself. */
export type AuditEntry = { actor: string; action: string; target: string; details: string };

export type TpsStats = { avg: number; min: number } | null;

export type StatusAnswer = { state: ServerState; uptimeDay: number | null; uptimeWeek: number | null };
export type TpsAnswer = { state: ServerState; lastHour: { ts: number; tps: number }[]; hour: TpsStats; day: TpsStats };
export type PlaytimeAnswer =
  | { found: true; player: string; totalMs: number; weekMs: number; lastSeen: { online: true } | number | null }
  | { found: false; reason: 'noInput' | 'notLinked' };
/** A Server without a Backup folder has no Backup answers at all, rather than an empty list. */
export type BackupsAnswer =
  | { configured: false }
  | { configured: true; backups: Backup[]; free: number | null; /** Bytes per day. */ growth: number | null };
/** `/top` periods: the last 24 hours, the last 7 days, all time. */
export type Period = 'day' | 'week' | 'all';

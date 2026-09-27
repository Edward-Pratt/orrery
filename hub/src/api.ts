/**
 * The HTTP API's types, for the dashboard to import type-only. Imports only pure type files (no Node types), so it
 * compiles on its own: `npm run typecheck` checks that with `tsconfig.api.json`.
 */
import type {
  AuditEntry,
  BackupsAnswer,
  HistoryAnswer,
  HostSample,
  LiveEvent as AnyLiveEvent,
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
  HistoryAnswer,
  HostSample,
  HubEvent,
  Lifecycle,
  Notice,
  Period,
  PlaytimeAnswer,
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

/** `GET /api/me`: the logged-in admin. */
export type Me = { id: string; username: string };

/** `GET /api/integrations`: which integrations are switched on. */
export type Integrations = { minecraft: boolean; discord: boolean; web: boolean; checks: boolean; host: boolean; systemd: boolean };

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

/** `GET /api/servers`: one card per server. `tps` is null without the TPS feature. */
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
  features: Features;
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
};

/** `GET /api/servers/:id/players/:name`: playtime and last seen; 404 for a name never seen on the server. */
export type PlayerAnswer = PlaytimeAnswer;

/**
 * `GET /api/servers/:id/history[?hours=1–2160]`: the last `hours` (default 24), see `HistoryAnswer`. `asOf` is the
 * newest event id when it was read: stream events up to it are already counted in. 404 unknown, 400 bad hours.
 */
export type ServerHistory = HistoryAnswer & { asOf: number };

/** `GET /api/audit[?server=id]`: newest first. */
export type AuditLog = (AuditEntry & { ts: number })[];

/**
 * The `data` of each `GET /api/events` message (JSON); the message's SSE `id` is its event id. A server's events
 * have `serverId`; the host's, a service's and a check's have `target` and `id` instead. `tps` events come from
 * heartbeats when TPS moved by 0.1 or more; a replay holds only each online server's latest.
 */
export type LiveEvent = AnyLiveEvent;

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

/** The answer to a command and to `POST /api/servers/:id/backup`. */
export type CommandOutput = { output: string[] };

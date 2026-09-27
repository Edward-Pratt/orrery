/**
 * The HTTP API's types, for the dashboard to import type-only. Imports only pure type files (no Node types), so it
 * compiles on its own: `npm run typecheck` checks that with `tsconfig.api.json`.
 */
import type { AuditEntry, BackupsAnswer, LiveEvent as AnyLiveEvent, Period, PlaytimeAnswer, StatusAnswer, TpsAnswer } from './types.ts';

export type {
  Backup,
  BackupsAnswer,
  HubEvent,
  Lifecycle,
  Notice,
  Period,
  PlaytimeAnswer,
  ServerState,
  Severity,
  StatusAnswer,
  Target,
  TargetEvent,
  TargetNotice,
  Tps,
  TpsAnswer,
} from './types.ts';

/** `GET /api/me`: the logged-in admin. */
export type Me = { id: string; username: string };

/** `GET /api/integrations`: which integrations are switched on. */
export type Integrations = { minecraft: boolean; discord: boolean; web: boolean };

/** What a server has; chat, TPS and quests only for a Minecraft server with the mod (a token configured). */
export type Features = { chat: boolean; tps: boolean; quests: boolean };

/** A countdown restart in progress: when it fires and who scheduled it. */
export type PendingRestart = { at: number; by: string };

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

/** `GET /api/servers/:id`. `tps` is null without the TPS feature; `top` is the 10 most-played per period. */
export type ServerDetail = {
  card: ServerCard;
  status: StatusAnswer;
  tps: TpsAnswer | null;
  top: Record<Period, { player: string; ms: number }[]>;
  backups: BackupsAnswer;
};

/** `GET /api/servers/:id/players/:name`: playtime and last seen; 404 for a name never seen on the server. */
export type PlayerAnswer = PlaytimeAnswer;

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

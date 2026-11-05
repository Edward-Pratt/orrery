// The HTTP API's types for the reads without a session (`web/web-public.ts`), re-exported by `api.ts`. Imports only
// `types.ts`, as `api.ts` does.

import type { Game } from './types.ts';

/** `GET /api/environment`, read without a session: which Environment this hub is, for the dashboard's badge. */
export type EnvironmentInfo = { environment: 'production' | 'staging' };

/**
 * `GET /api/public/status`, read without a session, for the Status page: only the servers listed in
 * `integrations.web.status`, in that order (without it the route doesn't exist: 401 without a session, like any
 * unknown path). Field by field, never a spread card: no id, no address, no Discord name.
 */
export type PublicStatus = { servers: PublicServer[] };
/** `hung`: connected but not answering; `paused`: a factorio server paused with nobody on. */
export type PublicState = 'up' | 'paused' | 'hung' | 'down';
export type PublicServer = {
  name: string;
  game: Game;
  state: PublicState;
  /** The names online, as they play (never a linked Discord name). */
  players: string[];
  /** Share of the last 7 and 30 days the server was up (0–1), null while unknown. */
  uptimeWeek: number | null;
  uptimeMonth: number | null;
};

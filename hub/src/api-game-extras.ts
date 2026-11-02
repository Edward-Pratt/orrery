// The HTTP API's types for a factorio server's portal mod updates and its players' moderation, re-exported by `api.ts`.
// Imports only `types.ts`, as `api.ts` does.
//
// The API types of portal mod updates (`ModUpdate`, `ModUpdatesState`) and moderation (`ModerationState`,
// `ModerateRequest`, `ModerateAnswer`, and `types.ts`'s `Ban`, `ModerateAction`, `ModerateOutcome`, `PlayerLists`
// re-exported), re-exported by `api.ts`; imports only `types.ts`.
import type { ModerateAction, ModerateOutcome, PlayerLists } from './types.ts';

export type { Ban, ModerateAction, ModerateOutcome, PlayerLists } from './types.ts';

/** An installed portal mod with a newer release that fits the server's Factorio: from the version it runs, to the newest that fits. */
export type ModUpdate = { name: string; title: string; from: string; to: string };
/**
 * `GET /api/servers/:id/game/updates`: the portal mod updates of what a factorio server runs (`factorio`, null
 * before its Agent's first report), as the hub last read the mod portal (`checked`, epoch ms). `later`: a newer
 * release that needs a newer Factorio. `gone`: no release for this Factorio line on the portal any more. `unchecked`:
 * past the hub's cap on portal reads. `error`: why the last read failed (the lists are then the last good ones).
 * Titles are the portal's, checked and cut: show them as text.
 */
export type ModUpdatesState = {
  factorio: string | null;
  checked: number | null;
  updates: ModUpdate[];
  later: { name: string; title: string; latest: string }[];
  gone: string[];
  unchecked: string[];
  error: string | null;
};

/**
 * `GET /api/servers/:id/moderation`: who is online (the latest heartbeat), the bans and admins (null while its Agent
 * is older or away, or didn't answer), and why actions are refused now (`blocked`).
 */
export type ModerationState = { online: string[]; lists: PlayerLists | null; blocked: string | null };
/** `POST /api/servers/:id/moderation`. `reason` only for a kick or a ban. 400 bad input, 409 blocked or busy, 429 too many, 502 the Agent. */
export type ModerateRequest = { action: ModerateAction; player: string; reason?: string };
/** How the action ended, and the lists read again after it. */
export type ModerateAnswer = { outcome: ModerateOutcome; lists: PlayerLists };

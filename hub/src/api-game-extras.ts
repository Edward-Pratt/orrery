// The HTTP API's types for a factorio server's portal mod updates and its players' moderation, re-exported by `api.ts`.
// Imports only `types.ts`, as `api.ts` does.

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

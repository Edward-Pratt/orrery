// What every web route reads from a request: its JSON body (`jsonBody`), the logged-in user the session check set
// (`SessionUser`: `Me`, their Discord id and their grants), and how they are named: `actor`, the audit's
// `web:<username> (<id>)`, and `usersActor`, the same with their id and grants for `Users`' and `Roles`' checks; and
// a history period's `hours` query (`hoursOf`, 1 to 2160, default 24; `BAD_HOURS` the 400's text when it isn't).

import type { Context } from 'hono';
import type { Me } from '../api.ts';
import type { Grant } from '../users/permissions.ts';
import type { Actor } from '../users/users.ts';

/** The logged-in user as routes see them; `GET /api/me` answers the `Me` part only. */
export type SessionUser = Me & { discordId: string | null; grants: readonly Grant[] };

/** A request's JSON object body; empty if it has none (or isn't an object). */
export async function jsonBody(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  const body = await req.json().catch(() => undefined);
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** The audit's name for a dashboard user. */
export const actor = (user: Pick<Me, 'id' | 'username'>): string => `web:${user.username} (${user.id})`;

/** A dashboard user as `Users` checks them: no one changes a user above their own level. */
export const usersActor = (user: SessionUser): Actor => ({ label: actor(user), userId: user.id, grants: user.grants });

const MAX_HOURS = 90 * 24;

/** A history period's `hours` query (default 24); undefined unless a whole number from 1 to 2160. */
export function hoursOf(c: Context): number | undefined {
  const hours = Number(c.req.query('hours') ?? 24);
  return Number.isInteger(hours) && hours >= 1 && hours <= MAX_HOURS ? hours : undefined;
}
export const BAD_HOURS = `Give hours from 1 to ${MAX_HOURS}`;

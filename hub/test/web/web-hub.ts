// The web API's test hub, shared by `test/start.test.ts` and `test/web/`: `config` (one minecraft server, `gtnh`, in a
// temporary folder), `WEB` (the web integration on port 0), `webHub` (a hub with only the web integration: its
// `HubHandle.web`, the app and its `Users`), and logging in through `app.request`, with no port: `loginAs` makes a
// user through `Users` (an owner by default, `alex` with `ADMIN.id` as their Discord id) and logs them in through
// their invite, or with `POST /api/login` once they have a password (`PASSWORD`, every test user's), answering their
// cookie, id and audit actor; `ACTOR` is the last login's actor (ids are random, so it is set then), `loginCookie`
// the cookie alone. `dashboard(cookie)` is the headers of a write from the dashboard.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Config } from '../../src/config.ts';
import { startHub, type HubHandle } from '../../src/start.ts';
import { OWNER_GRANTS } from '../../src/users/permissions.ts';

export function config(t: TestContext, integrations: Config['integrations']): Config {
  const dir = mkdtempSync(join(tmpdir(), 'hub-start-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    environment: 'production',
    dbPath: join(dir, 'hub.db'),
    healthcheckUrl: 'https://example.invalid/ping',
    servers: [
      { id: 'gtnh', name: 'GTNH', game: 'minecraft', backupMinFreeGB: 10, lag: { tps: 15, minutes: 2, enabled: true }, quests: 'batched' },
    ],
    integrations,
  };
}

export const WEB = { listenPort: 0, publicUrl: 'https://dash.orrery.run', sessionDays: 7 };
/** The test owner; `id` is their Discord id, so dashboard chat goes in game under the name it linked. */
export const ADMIN = { id: '5'.repeat(18), username: 'alex' };
export const PASSWORD = 'correct horse battery staple';
/** Who makes the test users: the CLI's actor. */
const CLI = { label: 'cli:test', userId: null, grants: OWNER_GRANTS };

/** A hub's web API and its users, as `HubHandle.web` holds them. */
export type Web = NonNullable<HubHandle['web']>;

/** A hub with only the web integration: no bot is started. */
export async function webHub(t: TestContext): Promise<Web> {
  const handle = await startHub(config(t, { web: WEB }), {
    startFrontend: () => assert.fail('Discord is off'),
    get: async () => ({ ok: true, status: 200 }),
  });
  t.after(() => handle.close());
  assert.ok(handle.web);
  return handle.web;
}

/** The `name=value` pairs a response sets, as a Cookie header. */
export const cookies = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

/** The headers of a write from the dashboard: its origin, JSON, and the session cookie when given. */
export const dashboard = (cookie?: string): Record<string, string> => ({ ...(cookie && { cookie }), origin: WEB.publicUrl, 'content-type': 'application/json' });

/** The audit actor of the user `loginAs` last logged in. */
export let ACTOR = '';

/** Makes the user (an owner unless `grants` says otherwise) if new, and logs them in: their cookie, id and actor. */
export async function loginAs(web: Web, opts: { username?: string; grants?: unknown[]; discordId?: string } = {}) {
  const { username = ADMIN.username, grants = [{ roleId: 'owner' }], discordId = username === ADMIN.username ? ADMIN.id : undefined } = opts;
  const existing = web.users.list().find((u) => u.username === username);
  const post = (path: string, body: object) => web.app.request(path, { method: 'POST', headers: dashboard(), body: JSON.stringify(body) });
  let id: string;
  let res: Response;
  if (existing?.hasPassword) {
    id = existing.id;
    res = await post('/api/login', { username, password: PASSWORD });
  } else {
    const invite = existing ? web.users.reset(existing.id, CLI) : web.users.invite({ username, grants, discordId }, CLI);
    id = invite.id;
    res = await post(`/api/invites/${invite.token}`, { password: PASSWORD });
  }
  assert.equal(res.status, 204, await res.clone().text());
  ACTOR = `web:${username} (${id})`;
  return { cookie: cookies(res).split('; ').find((c) => c.startsWith('session='))!, id, actor: ACTOR };
}

export async function loginCookie(web: Web): Promise<string> {
  return (await loginAs(web)).cookie;
}

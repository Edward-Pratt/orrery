// The web API's test hub, shared by `test/start.test.ts` and `test/web/`: `config` (one minecraft server, `gtnh`, in a
// temporary folder), `WEB` (the web integration on port 0), a fake Discord OAuth (`fakeOAuth`: code `admin` logs in
// `ADMIN`, `player` logs in `PLAYER`, who lacks the admin role), `webHub` (a hub with only the web integration), and
// the login steps (`startLogin`, `login`, `loginCookie`) through `app.request`, with no port.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Config } from '../../src/config.ts';
import { startHub } from '../../src/start.ts';
import type { OAuth, WebApi } from '../../src/web/web.ts';

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

export const WEB = {
  listenPort: 0,
  publicUrl: 'https://dash.orrery.run',
  clientId: '4'.repeat(18),
  guildId: '7'.repeat(18),
  adminRoleId: '8'.repeat(18),
  sessionDays: 7,
};
export const ADMIN = { id: '5'.repeat(18), username: 'alex', avatar: 'a1b2c3', roles: ['9'.repeat(18), WEB.adminRoleId] };
export const PLAYER = { id: '6'.repeat(18), username: 'sam', avatar: null, roles: ['9'.repeat(18)] };

/** A fake Discord OAuth backend: code `admin`/`player` logs in that member; records every call. */
export function fakeOAuth() {
  const calls: string[] = [];
  const oauth: OAuth = {
    token: async (code, redirectUri) => {
      calls.push(`token ${code}`);
      assert.equal(redirectUri, 'https://dash.orrery.run/api/callback');
      return `access-${code}`;
    },
    member: async (accessToken, guildId) => {
      calls.push(`member ${accessToken}`);
      assert.equal(guildId, WEB.guildId);
      return { admin: ADMIN, player: PLAYER }[accessToken.slice('access-'.length)];
    },
  };
  return { oauth, calls };
}

/** A hub with only the web integration: no bot is started. */
export async function webHub(t: TestContext, oauth: OAuth) {
  const handle = await startHub(config(t, { web: WEB }), {
    startFrontend: () => assert.fail('Discord is off'),
    get: async () => ({ ok: true, status: 200 }),
    oauth,
  });
  t.after(() => handle.close());
  assert.ok(handle.web);
  return handle.web.app;
}

/** The `name=value` pairs a response sets, as a Cookie header. */
export const cookies = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

/** Starts a login and returns Discord's authorize URL and the state cookie. */
export async function startLogin(app: WebApi) {
  const res = await app.request('/api/login');
  assert.equal(res.status, 302);
  return { authorize: new URL(res.headers.get('location')!), cookie: cookies(res) };
}

export async function login(app: WebApi, code: string) {
  const { authorize, cookie } = await startLogin(app);
  const state = authorize.searchParams.get('state');
  return app.request(`/api/callback?code=${code}&state=${state}`, { headers: { cookie } });
}

export async function loginCookie(app: WebApi) {
  const res = await login(app, 'admin');
  assert.equal(res.status, 302);
  return cookies(res).split('; ').find((c) => c.startsWith('session='))!;
}

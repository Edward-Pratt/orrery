// The web login and sessions (`src/web/auth.ts`) on a whole hub through `app.request`: a login by username and
// password, the one 401 for every failure, `LoginLimit`'s lock by name and address (the last `X-Forwarded-For`
// entry) and the cap on password checks at once, CSRF on the login, invites, the session read afresh (disabled,
// a changed grant, a Discord login's leftover row), `GET /api/me`'s shape, expiry, logging out, out everywhere and a
// password change.

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { InviteInfo, Me, RoleView } from '../../src/api.ts';
import { startHub } from '../../src/start.ts';
import { hashToken } from '../../src/users/store.ts';
import { OWNER_GRANTS, PERMISSIONS } from '../../src/users/permissions.ts';
import { MAX_VERIFYING } from '../../src/web/auth.ts';
import { config, cookies, dashboard, loginAs, PASSWORD, WEB, webHub, type Web } from './web-hub.ts';

const OWNER = { label: 'cli:test', userId: null, grants: OWNER_GRANTS };
const WRONG = 'wrong password, sorry';

/** A login from `address` (behind an earlier, spoofable entry: only Caddy's, the last, counts). */
const login = (web: Web, username: unknown, password: unknown, address = '10.0.0.1', headers = dashboard()) =>
  web.app.request('/api/login', { method: 'POST', headers: { ...headers, 'x-forwarded-for': `203.0.113.9, ${address}` }, body: JSON.stringify({ username, password }) });
const status = async (web: Web, cookie: string, path = '/api/me') => (await web.app.request(path, { headers: { cookie } })).status;
const roleId = async (web: Web, cookie: string, name: string) =>
  ((await (await web.app.request('/api/roles', { headers: { cookie } })).json()) as RoleView[]).find((r) => r.name === name)!.id;

test('a user logs in by username (any case) and password: a session cookie, and /api/me says who and what they may do', async (t) => {
  const web = await webHub(t);
  const { id } = await loginAs(web);
  const res = await login(web, 'ALEX', PASSWORD);
  assert.equal(res.status, 204);
  const session = res.headers.getSetCookie().find((c) => c.startsWith('session='))!;
  for (const flag of [/HttpOnly/, /Secure/, /SameSite=Lax/, /Path=\/api/]) assert.match(session, flag);
  const me = await web.app.request('/api/me', { headers: { cookie: session.split(';')[0]! } });
  const all = PERMISSIONS.map((p) => ({ permission: p.name, servers: null }));
  assert.deepEqual(await me.json(), { id, username: 'alex', owner: true, permissions: all } satisfies Me);
});

test('every failed login gets the same 401: unknown name, wrong password, no password yet, disabled, a bad body', async (t) => {
  const web = await webHub(t);
  await loginAs(web);
  web.users.invite({ username: 'sam', grants: [] }, OWNER); // invited, the link not used
  const dan = await loginAs(web, { username: 'dan', grants: [] });
  web.users.disable(dan.id, OWNER);
  const tries: [unknown, unknown][] = [['nobody', PASSWORD], ['alex', WRONG], ['sam', PASSWORD], ['dan', PASSWORD], [7, PASSWORD], ['alex', undefined]];
  for (const [i, [username, password]] of tries.entries()) {
    const res = await login(web, username, password, `10.0.0.${i}`);
    assert.equal(res.status, 401, JSON.stringify(username));
    assert.equal(await res.text(), 'Wrong username or password');
    assert.deepEqual(res.headers.getSetCookie(), []);
  }
});

test("five failures lock the name from that address, Caddy's entry, for 15 min (429, Retry-After); not from elsewhere; a success forgives", async (t) => {
  const web = await webHub(t);
  await loginAs(web);
  for (let i = 0; i < 4; i++) assert.equal((await login(web, 'alex', WRONG)).status, 401);
  assert.equal((await login(web, 'alex', PASSWORD)).status, 204); // forgives the pair
  for (let i = 0; i < 5; i++) assert.equal((await login(web, 'alex', WRONG)).status, 401);
  const locked = await login(web, 'alex', PASSWORD);
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 890 && Number(locked.headers.get('retry-after')) <= 900);
  assert.equal(await locked.text(), 'Too many tries: wait 15 min and try again');
  assert.equal((await login(web, 'alex', PASSWORD, '10.0.0.2')).status, 204); // the owner, from elsewhere
  assert.equal((await login(web, 'alex', PASSWORD, '203.0.113.9')).status, 204); // the spoofable first entry isn't the address
});

test(`at most ${MAX_VERIFYING} password checks run at once: the rest are 429 at once, and not counted`, async (t) => {
  const web = await webHub(t);
  await loginAs(web);
  const answers = await Promise.all(Array.from({ length: 6 }, () => login(web, 'alex', WRONG)));
  const busy = answers.filter((r) => r.status === 429);
  assert.deepEqual(answers.map((r) => r.status).sort(), [401, 401, 429, 429, 429, 429]);
  assert.equal(await busy[0]!.text(), 'The hub is busy: try again in a moment');
  assert.equal(busy[0]!.headers.get('retry-after'), '1');
  for (let i = 0; i < 2; i++) assert.equal((await login(web, 'alex', WRONG)).status, 401); // 4 counted
  assert.equal((await login(web, 'alex', PASSWORD)).status, 204);
});

test('the login is behind the CSRF check: the Origin and JSON', async (t) => {
  const web = await webHub(t);
  await loginAs(web);
  assert.equal((await login(web, 'alex', PASSWORD, '10.0.0.1', { 'content-type': 'application/json' })).status, 403);
  assert.equal((await login(web, 'alex', PASSWORD, '10.0.0.1', { ...dashboard(), origin: 'https://evil.example' })).status, 403);
  assert.equal((await login(web, 'alex', PASSWORD, '10.0.0.1', { ...dashboard(), 'content-type': 'text/plain' })).status, 415);
});

test('an invite names its user, sets a password once (a refused one leaves it unused), logs in, and lasts 24 h', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const web = await webHub(t);
  const { id, token } = web.users.invite({ username: 'sam', grants: [] }, OWNER);
  const at = `/api/invites/${token}`;
  const set = (password: string) => web.app.request(at, { method: 'POST', headers: dashboard(), body: JSON.stringify({ password }) });
  assert.deepEqual(await (await web.app.request(at)).json(), { username: 'sam' } satisfies InviteInfo);
  assert.equal((await web.app.request('/api/invites/made-up')).status, 404);
  const short = await set('too short');
  assert.equal(short.status, 400);
  assert.equal(await short.text(), 'A password is at least 12 characters');
  const ok = await set(PASSWORD);
  assert.equal(ok.status, 204);
  const me = (await (await web.app.request('/api/me', { headers: { cookie: cookies(ok) } })).json()) as Me;
  assert.deepEqual(me, { id, username: 'sam', owner: false, permissions: [] });
  assert.equal((await set(PASSWORD)).status, 404); // used
  assert.equal((await web.app.request(at)).status, 404);
  const late = web.users.reset(id, OWNER);
  t.mock.timers.tick(24 * 60 * 60_000);
  assert.equal((await web.app.request(`/api/invites/${late.token}`)).status, 404);
});

test('a session reads its user afresh: a changed grant counts at once, a disabled user is 401 at once', async (t) => {
  const web = await webHub(t);
  const owner = await loginAs(web);
  const sam = await loginAs(web, { username: 'sam', grants: [] });
  assert.equal(await status(web, sam.cookie, '/api/audit'), 403);
  const change = (body: object) => web.app.request(`/api/users/${sam.id}`, { method: 'PUT', headers: dashboard(owner.cookie), body: JSON.stringify(body) });
  assert.equal((await change({ grants: [{ roleId: await roleId(web, owner.cookie, 'Admin') }] })).status, 204);
  assert.equal(await status(web, sam.cookie, '/api/audit'), 200);
  assert.equal((await change({ disabled: true })).status, 204);
  assert.equal(await status(web, sam.cookie), 401);
});

test("the Discord login's sessions and Users' don't mix: theirs is 401, and a User's leaves web_sessions empty", async (t) => {
  const cfg = config(t, { web: WEB });
  const handle = await startHub(cfg, { startFrontend: () => assert.fail('Discord is off'), get: async () => ({ ok: true, status: 200 }) });
  t.after(() => handle.close());
  const db = new DatabaseSync(cfg.dbPath);
  t.after(() => db.close());
  db.prepare('INSERT INTO web_sessions (id, user_id, username, expires) VALUES (?, ?, ?, ?)').run(hashToken('old-cookie'), '5'.repeat(18), 'alex', Date.now() + 60_000);
  assert.equal(await status(handle.web!, 'session=old-cookie'), 401);
  // A hub rolled back past Users reads web_sessions and would take any row there for an admin's.
  const viewer = await loginAs(handle.web!, { username: 'vic', grants: [] });
  assert.equal(await status(handle.web!, viewer.cookie), 200);
  assert.deepEqual((db.prepare('SELECT user_id AS id FROM web_sessions').all() as { id: string }[]).map((r) => r.id), ['5'.repeat(18)]);
});

test('a session expires after sessionDays', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const web = await webHub(t);
  const { cookie } = await loginAs(web);
  t.mock.timers.tick(7 * 24 * 60 * 60_000 - 1);
  assert.equal(await status(web, cookie), 200);
  t.mock.timers.tick(1);
  assert.equal(await status(web, cookie), 401);
});

test('logging out ends this session; a password change ends the others; out everywhere ends them all', async (t) => {
  const web = await webHub(t);
  const a = await loginAs(web);
  const b = await loginAs(web);
  const post = (cookie: string, path: string, body?: object) => web.app.request(path, { method: path === '/api/me/password' ? 'PUT' : 'POST', headers: dashboard(cookie), body: JSON.stringify(body ?? {}) });
  assert.equal((await post(a.cookie, '/api/logout')).status, 204);
  assert.equal(await status(web, a.cookie), 401);
  assert.equal(await status(web, b.cookie), 200);

  const c = await loginAs(web);
  const wrong = await post(c.cookie, '/api/me/password', { current: WRONG, password: 'a new password, long' });
  assert.equal(wrong.status, 403);
  assert.equal(await wrong.text(), 'Wrong password');
  assert.equal((await post(c.cookie, '/api/me/password', { current: PASSWORD, password: 'short' })).status, 400);
  assert.equal((await post(c.cookie, '/api/me/password', { current: PASSWORD, password: 'a new password, long' })).status, 204);
  assert.equal(await status(web, b.cookie), 401);
  assert.equal(await status(web, c.cookie), 200);
  assert.equal((await login(web, 'alex', PASSWORD)).status, 401);
  const d = await login(web, 'alex', 'a new password, long');
  assert.equal(d.status, 204);

  assert.equal((await post(c.cookie, '/api/me/logout-all')).status, 204);
  assert.equal(await status(web, c.cookie), 401);
  assert.equal(await status(web, cookies(d)), 401);
});

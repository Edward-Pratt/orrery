// The event stream's session re-check (`eventsRoutes` on a bare Hono app with a fake feed), and `sessionUser`, the
// check it and every request use, on real Users: a logout everywhere, a disabled user and an expiry each end it.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Hono } from 'hono';
import { Db } from '../../src/stats/db.ts';
import type { LiveFeed } from '../../src/stats/live.ts';
import { OWNER_GRANTS } from '../../src/users/permissions.ts';
import { Roles } from '../../src/users/roles.ts';
import { Users } from '../../src/users/users.ts';
import { sessionUser } from '../../src/web/auth.ts';
import { eventsRoutes } from '../../src/web/web-events.ts';
import type { Env } from '../../src/web/web.ts';

const CLI = { label: 'cli:test', userId: null, grants: OWNER_GRANTS };

/** A stream behind a fake session check that holds while `state.alive`; its body's text so far and whether it ended. */
async function stream(state: { alive: boolean; asked: string[] }) {
  const live = Object.assign(new EventEmitter(), { since: () => [] }) as unknown as LiveFeed;
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set('session', 'hash-1');
    await next();
  });
  eventsRoutes(app, { live, tickMs: 20, alive: (s) => (state.asked.push(s), state.alive) });
  const res = await app.request('/events');
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const out = { text: '', ended: false };
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return void (out.ended = true);
      out.text += value;
    }
  })();
  return { out, live, cancel: () => reader.cancel() };
}

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), 'condition not met in time');
};

test('an open stream re-checks its session on each tick, keeps alive while it holds, and closes once it ends', async () => {
  const state = { alive: true, asked: [] as string[] };
  const { out, live } = await stream(state);
  await until(() => out.text.includes(': keep-alive'));
  assert.equal(out.ended, false);
  assert.equal(live.listenerCount('event'), 1);
  state.alive = false;
  await until(() => out.ended);
  assert.equal(live.listenerCount('event'), 0);
  assert.ok(state.asked.every((s) => s === 'hash-1'));
});

test("sessionUser: a session's user while it holds; nothing after Log out everywhere, a disable or its expiry", () => {
  const db = new Db(':memory:');
  const users = new Users(db.users, new Roles(db.users, () => {}), () => {}, { knownServer: () => true });
  const deps = { users, sessions: db.users };
  const { id } = users.invite({ username: 'sam', grants: [{ roleId: 'owner' }] }, CLI);
  const { id: other } = users.invite({ username: 'kim', grants: [{ roleId: 'owner' }] }, CLI);
  db.users.addSession('a', id, Date.now() + 60_000);
  assert.equal(sessionUser(deps, 'a')?.user.id, id);
  users.endSessions(id, CLI);
  assert.equal(sessionUser(deps, 'a'), undefined);
  db.users.addSession('b', id, Date.now() + 60_000);
  users.disable(id, CLI);
  assert.equal(sessionUser(deps, 'b'), undefined);
  db.users.addSession('c', other, Date.now() - 1);
  assert.equal(sessionUser(deps, 'c'), undefined);
});

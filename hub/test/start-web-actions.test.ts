// The dashboard's actions on `apiHub`: chat, a console command, a restart countdown and its cancel, a backup start,
// each audited; clear errors for offline or unknown servers; a state-changing request needs a session, the dashboard
// origin and JSON.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuditLog, CommandOutput, ServerCard } from '../src/api.ts';
import { online, until } from './fake-mod.ts';
import { ACTOR } from './web/web-hub.ts';
import { openStream, apiHub, ORIGIN, post, webAudit } from './start-hub.ts';

test('chat from the dashboard reaches the mod, appears on the stream and is audited', async (t) => {
  const { app, cookie, get, port } = await apiHub(t);
  const mod = await online(port);
  const stream = await openStream(app, cookie);
  t.after(() => stream.close());
  const res = await post(app, cookie, '/api/servers/gtnh/chat', { message: 'hi §cthere' });
  assert.equal(res.status, 204);
  assert.deepEqual(await mod.next(), { type: 'say', author: 'alex', message: 'hi there', source: 'dashboard' });
  await until(() => stream.events.some((e) => e.data.type === 'say'));
  assert.deepEqual(stream.events.find((e) => e.data.type === 'say')!.data, {
    serverId: 'gtnh',
    type: 'say',
    author: 'alex',
    message: 'hi there',
    source: 'dashboard', // no avatar: Discord shows the webhook's own
  });
  assert.deepEqual(webAudit(await get<AuditLog>('/api/audit')), [
    { actor: ACTOR, action: 'chat', target: 'gtnh', details: 'hi there' },
  ]);
  for (const body of [{}, [], { message: 42 }, { message: '§c ' }]) {
    assert.equal((await post(app, cookie, '/api/servers/gtnh/chat', body)).status, 400, JSON.stringify(body));
  }
  const bad = await app.request('/api/servers/gtnh/chat', {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(bad.status, 400);
});

test('a console command answers with its output, and late output arrives on the stream', async (t) => {
  const { app, cookie, get, port } = await apiHub(t);
  const mod = await online(port);
  const stream = await openStream(app, cookie);
  t.after(() => stream.close());
  const pending = post(app, cookie, '/api/servers/gtnh/command', { command: '/spark profiler' });
  const cmd = (await mod.next()) as { id: string; command: string };
  assert.equal(cmd.command, 'spark profiler');
  mod.send({ type: 'cmdResult', id: cmd.id, output: ['Profiler started'] });
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { output: ['Profiler started'] } satisfies CommandOutput);
  mod.send({ type: 'cmdLate', id: cmd.id, output: ['https://spark.lucko.me/abc'] });
  await until(() => stream.events.some((e) => e.data.type === 'console' && e.data.late));
  assert.deepEqual(webAudit(await get<AuditLog>('/api/audit')), [
    { actor: ACTOR, action: 'command', target: 'gtnh', details: 'spark profiler' },
  ]);
  for (const body of [{ command: ' /' }, { command: '\u0001' }, {}]) {
    assert.equal((await post(app, cookie, '/api/servers/gtnh/command', body)).status, 400, JSON.stringify(body));
  }
});

test('a restart is scheduled with a countdown and cancelled from the dashboard', async (t) => {
  const { app, cookie, get, port } = await apiHub(t);
  const mod = await online(port);
  assert.equal((await post(app, cookie, '/api/servers/gtnh/restart', { minutes: 10 })).status, 204);
  assert.equal(((await mod.next()) as { command: string }).command, 'say Server restarting in 10 minutes');
  assert.deepEqual((await get<ServerCard[]>('/api/servers'))[0]!.restart?.by, 'alex');
  assert.equal((await post(app, cookie, '/api/servers/gtnh/restart', { minutes: 5 })).status, 409);
  assert.equal((await post(app, cookie, '/api/servers/gtnh/restart/cancel')).status, 204);
  assert.equal(((await mod.next()) as { command: string }).command, 'say Restart cancelled');
  assert.equal((await post(app, cookie, '/api/servers/gtnh/restart/cancel')).status, 409);
  for (const body of [{}, { minutes: 61 }, { minutes: 1.5 }, { minutes: '5' }]) {
    assert.equal((await post(app, cookie, '/api/servers/gtnh/restart', body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(webAudit(await get<AuditLog>('/api/audit')), [
    { actor: ACTOR, action: 'restart cancel', target: 'gtnh', details: '' },
    { actor: ACTOR, action: 'restart', target: 'gtnh', details: 'in 10 min' },
  ]);
});

test('a backup start sends the command and answers with its output', async (t) => {
  const { app, cookie, get, port } = await apiHub(t);
  const mod = await online(port);
  const pending = post(app, cookie, '/api/servers/gtnh/backup');
  const cmd = (await mod.next()) as { id: string; command: string };
  assert.equal(cmd.command, 'backup start');
  mod.send({ type: 'cmdResult', id: cmd.id, output: ['Backup started'] });
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { output: ['Backup started'] });
  assert.deepEqual(webAudit(await get<AuditLog>('/api/audit')), [
    { actor: ACTOR, action: 'command', target: 'gtnh', details: 'backup start' },
  ]);
});

test('actions on an offline or unknown server get a clear error', async (t) => {
  const { app, cookie } = await apiHub(t);
  for (const [path, body] of [
    ['chat', { message: 'hi' }],
    ['command', { command: 'list' }],
    ['restart', { minutes: 5 }],
    ['restart/cancel', undefined],
    ['backup', undefined],
  ] as const) {
    const res = await post(app, cookie, `/api/servers/web/${path}`, body);
    assert.equal(res.status, 409, path);
    assert.equal(await res.text(), 'Website is offline');
    assert.equal((await post(app, cookie, `/api/servers/nope/${path}`, body)).status, 404, path);
  }
});

test('a state-changing request needs a session, the dashboard origin and JSON', async (t) => {
  const { app, cookie, port } = await apiHub(t);
  const mod = await online(port);
  const chat = (headers: Record<string, string>, withCookie = cookie) =>
    post(app, withCookie, '/api/servers/gtnh/chat', { message: 'hi' }, headers);
  assert.equal((await chat({}, '')).status, 401);
  assert.equal((await chat({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await chat({ origin: '' })).status, 403);
  assert.equal((await chat({ 'content-type': 'text/plain' })).status, 415);
  assert.equal((await chat({ 'content-type': 'application/json; charset=utf-8' })).status, 204);
  assert.deepEqual(await mod.next(), { type: 'say', author: 'alex', message: 'hi', source: 'dashboard' });
  assert.equal((await app.request('/api/logout', { method: 'POST', headers: { cookie } })).status, 403);
});

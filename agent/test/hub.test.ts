// `HubClient` against the fake hub, the Agent connection: nothing before a welcome, pings, `serviceState`, the
// `connected` file; `events` on each change and on every connect (a reason made `printable` and cut); a line over 1 MiB
// closes cleanly and reconnects; invalid, unknown and unsupported requests answered `ok: false` by id, a handler's error
// with no query string and cut to 2 KiB; `deliver` false offline, when the write fails (a mocked `Socket.write`) and
// once stopping, true once written; `settings` on change (not twice the same on one connection), on every connect, cut
// to the hub's limits; the saves list on each connect and change; `save` and `backup` on the game connection.
// Reconnects are `hub-retry.test.ts`, the game connection `hub-game.test.ts`, the setup `hub-setup.ts`.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { LIMITS } from '../src/wire.ts';
import { eventually } from './fake-hub.ts';
import { READING, T0, TOKEN, VERSION, sent, setup } from './hub-setup.ts';

test('agentHello first, nothing else before welcome; then serviceState, pings and the connected file', async (t) => {
  let welcome = false;
  const { hub, client, root } = await setup(t, () => (welcome ? 'welcome' : 'silent'), { pingMs: 20, handshakeMs: 150 });
  client.service({ unit: 'factorio.service', active: 'active', sub: 'running', since: 1_700_000_000_000, result: 'success' });
  client.start();
  const [first] = await eventually(() => hub.of('agentHello').length === 1 && hub.of('agentHello'));
  assert.deepEqual(first!.lines[0], { type: 'agentHello', protocol: 1, agentId: 'factorio-vm', token: TOKEN, agentVersion: VERSION, node: process.version });
  client.sample({ ts: 1, cpu: 0.5, load: [1, 2, 3], memory: { used: 1, total: 2 }, disks: [] });
  client.status({ ...READING, ups: 60 });
  await sleep(60);
  assert.equal(first!.lines.length, 1, 'only the hello before a welcome');
  assert.equal(client.connected, false);
  assert.equal(hub.of('hello').length, 0, 'no game connection before a welcome');

  welcome = true; // the silent connection times out, the next is welcomed
  // The welcomed one, not the second by index: a slow machine may have opened (and timed out) another silent one first.
  const second = await eventually(() => hub.of('agentHello').find((c) => c !== first && sent(c, 'ping').length >= 2), 2000, 'pings');
  assert.ok(first!.closed);
  assert.deepEqual(sent(second, 'serviceState'), [
    { type: 'serviceState', unit: 'factorio.service', active: 'active', sub: 'running', since: 1_700_000_000_000, result: 'success' },
  ]);
  await eventually(() => existsSync(join(root, 'connected')), 2000, 'the connected file');
  const connected = JSON.parse(await readFile(join(root, 'connected'), 'utf8'));
  assert.deepEqual(Object.keys(connected), ['version', 'time']);
  assert.equal(connected.version, VERSION);
  assert.ok(Math.abs(connected.time - Date.now()) < 5000);

  client.sample({ ts: 2, cpu: 0.25, load: [0.1, 0.2, 0.3], memory: { used: 3, total: 4 }, disks: [{ mount: '/', free: 5, total: 6 }] });
  client.service({ unit: 'factorio.service', active: 'inactive', sub: 'dead', since: 1_700_000_100_000, result: 'success' });
  await eventually(() => sent(second, 'hostSample').length === 1 && sent(second, 'serviceState').length === 2);
  assert.deepEqual(sent(second, 'hostSample')[0], {
    type: 'hostSample',
    sample: { ts: 2, cpu: 0.25, load: [0.1, 0.2, 0.3], memory: { used: 3, total: 4 }, disks: [{ mount: '/', free: 5, total: 6 }] },
  });
  assert.deepEqual([...first!.invalid, ...second.invalid], [], 'every line valid for the hub');
});

test('a line from the hub over 1 MiB closes the connection cleanly, then it reconnects; a line of exactly 1 MiB is read', async (t) => {
  const { hub, client } = await setup(t);
  client.start();
  const first = await eventually(() => hub.conns[0]);
  await eventually(() => client.connected);
  // Exactly LIMITS.lineBytes with its newline: read (extra fields dropped), answered.
  const base = JSON.stringify({ type: 'logs', id: 'r1', pad: '' });
  first.socket.write(JSON.stringify({ type: 'logs', id: 'r1', pad: 'x'.repeat(LIMITS.lineBytes - 1 - base.length) }) + '\n');
  await eventually(() => sent(first, 'reply').length === 1);
  // One byte more, with no newline yet: closed as soon as the cap is passed.
  first.socket.write('x'.repeat(LIMITS.lineBytes));
  await eventually(() => first.closed, 2000, 'the connection closed');
  assert.equal(sent(first, 'bye').length, 0, 'not a planned exit');
  const second = await eventually(() => hub.conns[1], 2000, 'a reconnect');
  await eventually(() => client.connected);
  assert.equal(second.kind, 'agentHello');
});

test('every request gets a reply by its id: invalid, unknown and unsupported ones ok: false; an error redacted and cut', async (t) => {
  const seen: unknown[] = [];
  const { hub, client } = await setup(t, undefined, {
    handlers: {
      journal: async (req) => (seen.push(req), { lines: ['one', 'two'] }),
      log: async () => {
        throw new Error('no such log');
      },
      restore: async () => {
        throw new Error(`can't fetch https://dl.factorio.com/x1.zip?secure=abc&expires=1 ${'😀'.repeat(LIMITS.detail)}`);
      },
    },
  });
  client.start();
  const conn = await eventually(() => hub.conns[0]);
  await eventually(() => client.connected);
  const requests = [
    { type: 'serviceAct', id: 'a', action: 'explode' },
    { type: 'frobnicate', id: 'b' },
    { type: 'restore', id: 'c', name: 'x'.repeat(LIMITS.text + 1) },
    { type: 'update', id: 'd', factorio: { version: '2.1.25', url: 'https://dl.factorio.com/x', sha256: 'aa' }, mods: 'all' },
    { type: 'logs', id: 'e' },
    { type: 'journal', id: 'f', unit: 'factorio.service', extra: 'dropped' },
    { type: 'log', id: 'g', name: 'agent.log' },
    { type: 'restore', id: 'h', name: 'world.zip' },
  ];
  conn.socket.write('not json\n' + JSON.stringify({ id: 'no-type' }) + '\n' + JSON.stringify({ type: 'logs', id: 'x'.repeat(LIMITS.text + 1) }) + '\n');
  for (const r of requests) conn.send(r);
  await eventually(() => sent(conn, 'reply').length === requests.length, 2000, 'a reply to each');
  const replies = Object.fromEntries(sent(conn, 'reply').map((r) => [r.id, r]));
  assert.deepEqual(replies.a, { type: 'reply', id: 'a', ok: false, error: 'invalid serviceAct' });
  assert.deepEqual(replies.b, { type: 'reply', id: 'b', ok: false, error: 'unknown type' });
  assert.deepEqual(replies.c, { type: 'reply', id: 'c', ok: false, error: 'invalid restore' });
  assert.deepEqual(replies.d, { type: 'reply', id: 'd', ok: false, error: 'invalid update' });
  assert.deepEqual(replies.e, { type: 'reply', id: 'e', ok: false, error: `logs is not supported by ${VERSION}` });
  assert.deepEqual(replies.f, { type: 'reply', id: 'f', ok: true, data: { lines: ['one', 'two'] } });
  assert.deepEqual(replies.g, { type: 'reply', id: 'g', ok: false, error: 'no such log' });
  const h = replies.h!.error as string;
  assert.ok(h.startsWith("can't fetch https://dl.factorio.com/x1.zip 😀"), 'no query string');
  assert.ok(h.length <= LIMITS.detail && !/[\uD800-\uDBFF]$/.test(h), 'cut to 2 KiB, never half a surrogate pair');
  assert.deepEqual(seen, [{ type: 'journal', id: 'f', unit: 'factorio.service' }], 'a handler gets only the documented fields');
  assert.equal(conn.closed, false, 'lines with no usable id are dropped; the connection stays');
  assert.deepEqual(conn.invalid, []);
});

test('deliver: false while not connected; true once the line is written; false when its write fails', async (t) => {
  const { hub, client } = await setup(t);
  const done = { type: 'updateDone', id: 'u1', outcome: 'ok', from: '2.1.24 · 3 mods', to: '2.1.25 · 4 mods' } as const;
  assert.equal(await client.deliver(done), false, 'no connection yet');
  client.start();
  await eventually(() => client.connected);
  const agent = hub.of('agentHello')[0]!;
  assert.equal(await client.deliver(done), true);
  await eventually(() => sent(agent, 'updateDone').length === 1);
  // A write that fails, as on a connection that drops while the line goes out.
  t.mock.method(Socket.prototype, 'write', function (this: Socket, _line: string, cb?: (err?: Error) => void) {
    process.nextTick(() => cb?.(new Error('write EPIPE')));
    return false;
  });
  assert.equal(await client.deliver(done), false);
  t.mock.restoreAll();
  await client.stop();
  assert.equal(await client.deliver(done), false, 'stopping');
});

test('events on the Agent connection: each change, and again on every connect, so an on the hub missed while it was away comes', async (t) => {
  const { hub, client } = await setup(t);
  const told = () => hub.of('agentHello').map((c) => sent(c, 'events'));
  client.events({ on: false, reason: 'before any connection' }); // kept for the connect
  client.start();
  await eventually(() => told()[0]?.length === 1);
  assert.deepEqual(told()[0], [{ type: 'events', on: false, reason: 'before any connection' }]);
  const long = `a\u001b[2Jb${'x'.repeat(LIMITS.detail)}`; // a terminal escape and over the limit: printable, cut
  client.events({ on: false, reason: long });
  await eventually(() => told()[0]?.length === 2);
  assert.equal((told()[0]![1] as { reason: string }).reason, `a?[2Jb${'x'.repeat(LIMITS.detail - 6)}`);

  hub.conns[0]!.socket.destroy();
  await eventually(() => told()[1]?.length === 1, 2000, 'resent on connect while off');
  assert.equal(told()[1]![0]!.on, false);
  hub.conns[1]!.socket.destroy();
  client.events({ on: true }); // while away
  await eventually(() => told()[2]?.length === 1, 2000, 'the on, on connect');
  assert.deepEqual(told()[2], [{ type: 'events', on: true }]);
  assert.deepEqual(hub.conns.flatMap((c) => c.invalid), []);
});

test('settings on the Agent connection: sent on change (never twice the same on one connection), again on every connect, cut to the hub\'s limits', async (t) => {
  const { hub, client } = await setup(t);
  const told = () => hub.of('agentHello').map((c) => sent(c, 'settings'));
  const report = {
    settings: null,
    admins: Array.from({ length: LIMITS.admins + 5 }, (_, i) => `admin${i}`),
    problem: `server-settings.json \u001b[2J${'x'.repeat(LIMITS.detail)}`,
    pending: [],
    extra: Array.from({ length: LIMITS.extra + 1 }, () => 'tags'),
    rolledBack: null,
  };
  client.settings(report); // kept for the connect
  client.start();
  await eventually(() => told()[0]?.length === 1);
  const first = told()[0]![0] as typeof report;
  assert.equal(first.admins.length, LIMITS.admins);
  assert.equal(first.extra.length, LIMITS.extra);
  assert.equal(first.problem, `server-settings.json ?[2J${'x'.repeat(LIMITS.detail - 25)}`);
  client.settings(report); // the same: not sent again on this connection
  client.settings({ ...report, problem: 'other' });
  await eventually(() => told()[0]?.length === 2);
  await sleep(30);
  assert.equal(told()[0]!.length, 2);
  hub.conns[0]!.socket.destroy();
  await eventually(() => told()[1]?.length === 1, 2000, 'sent again on connect');
  assert.equal((told()[1]![0] as typeof report).problem, 'other');
  assert.deepEqual(hub.conns.flatMap((c) => c.invalid), []);
});

test('the saves list goes on the Agent connection on each connect and change; the game connection’s save goes to save, and backup back on it', async (t) => {
  let saves = 0;
  const { hub, client } = await setup(t, undefined, { save: () => saves++ });
  const list = { saves: [{ name: 'world.zip', size: 10, mtime: T0, kind: 'world' as const, current: true }], free: 1e9 };
  client.saves(list); // before any connection: kept for it
  client.start();
  const agent = await eventually(() => hub.of('agentHello')[0]);
  await eventually(() => sent(agent, 'saves').length === 1, 2000, 'saves on connect');
  assert.deepEqual(sent(agent, 'saves')[0], { type: 'saves', ...list });
  client.saves({ ...list, free: 5e8 });
  await eventually(() => sent(agent, 'saves').length === 2, 2000, 'saves on change');

  client.status(READING);
  const game = await eventually(() => hub.of('hello')[0]);
  game.send({ type: 'save' });
  await eventually(() => saves === 1, 2000, 'save called');
  client.backup({ ok: true, detail: 'Saved orrery-20261031T120000Z.zip (1.0 MB)' });
  await eventually(() => sent(game, 'backup').length === 1, 2000, 'backup');
  assert.deepEqual(sent(game, 'backup')[0], { type: 'backup', ok: true, detail: 'Saved orrery-20261031T120000Z.zip (1.0 MB)' });

  agent.socket.destroy(); // a new Agent connection gets the latest list again
  const second = await eventually(() => hub.of('agentHello')[1], 2000, 'reconnected');
  await eventually(() => sent(second, 'saves').length === 1, 2000, 'saves on the new connection');
  assert.equal(sent(second, 'saves')[0]!.free, 5e8);
  assert.deepEqual(hub.conns.flatMap((c) => c.invalid), []);
});

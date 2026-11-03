// Game updates, on the Host `fake-world.ts` builds: `from`/`to` against the hub's `GAME_MODS` and docs/protocol.md's
// example, and from a kept `installed` after a restart with the server stopped; the step throttle, the latest step on
// connect and a running step again after the beat time (never `stop` `waiting`); `HubClient`'s `installed` (kept in
// `installed.json` across a restart, a bad file never sent) and `send`.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseAgentLine } from '../../hub/src/protocol.ts';
import type { AgentMsg } from '../../hub/src/types.ts';
import { HubClient } from '../src/hub.ts';
import { GAME_MODS as HUB_GAME_MODS } from '../../hub/src/updates/factorio.ts';
import { GAME_MODS, labels, Updates } from '../src/update.ts';
import type { Request } from '../src/wire.ts';
import { eventually, fakeHub } from './fake-hub.ts';
import { sha256, sha1, modUrl, zip, type Step, world, until } from './fake-world.ts';

test("updateDone's from and to as the hub names its row: every enabled mod, the game's own included, from the latest installed", async (t) => {
  assert.deepEqual([...GAME_MODS].sort(), [...HUB_GAME_MODS].sort(), "the hub's list of the game's own mods");
  // docs/protocol.md's example, and a server with its game mods partly off.
  const mods = (...names: string[]) => names.map((name) => ({ name, version: '1.0.0' }));
  const req = (n: number): Request<'update'> => ({
    type: 'update',
    id: 'u',
    factorio: { version: '2.1.25', url: '', sha256: '' },
    mods: Array.from({ length: n }, (_, i) => ({ name: `m${i}`, version: '1.0.0', sha1: '', url: '' })),
  });
  assert.deepEqual(labels({ factorio: '2.1.24', mods: mods('base', 'elevated-rails', 'quality', 'space-age', 'orrery') }, '2.1.24', req(2)), { from: '2.1.24 · 5 mods', to: '2.1.25 · 6 mods' });
  assert.deepEqual(labels({ factorio: '2.1.24', mods: mods('base') }, '2.1.24', req(1)), { from: '2.1.24 · 1 mod', to: '2.1.25 · 2 mods' });
  assert.deepEqual(labels(null, '2.1.24', req(1)), { from: '2.1.24', to: '2.1.25' }, 'nothing to count yet');

  // A restarted agent with its server stopped: no /orrery-status answer, but the installed it kept names the from.
  const w = await world(t);
  await w.unit.act('stop');
  w.restart();
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.mod('flib', '0.16.2');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']]));
  await w.step('stop', 'waiting');
  await w.u.cancel();
  const done = await w.done();
  assert.deepEqual([done.from, done.to], ['2.1.24 · 3 mods', '2.1.25 · 4 mods']);
});

test('steps go out at most once per second per step unless their state changes, and again on connect', async (t) => {
  const sentAt: [number, Step][] = [];
  const w = await world(t, { stepMs: 200 });
  const send = w.options.send;
  w.u = new Updates({ ...w.options, send: (m) => (m.type === 'updateStep' && sentAt.push([performance.now(), m]), send(m)) });
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  // A slow download: 30 chunks, 20 ms apart.
  const file = zip('orrery', '0.2.0');
  w.routes.set(modUrl('orrery', '0.2.0'), async () => {
    let i = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(c) {
          await new Promise((r) => setTimeout(r, 20));
          if (i < file.length) c.enqueue(file.subarray(i, (i += 1)));
          else c.close();
        },
      }),
    );
  });
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  const prepare = sentAt.filter(([, m]) => m.step === 'prepare' && m.state === 'running');
  assert.ok(prepare.length >= 2, 'progress went out');
  for (let i = 1; i < prepare.length; i++) assert.ok(prepare[i]![0] - prepare[i - 1]![0] >= 190, `${prepare[i]![0] - prepare[i - 1]![0]} ms apart`);
  assert.ok(prepare.length < 10, `not one per chunk: ${prepare.length}`);
  const latest = w.sent.at(-1);
  w.sent.length = 0;
  w.u.connected();
  assert.deepEqual(w.sent, [latest], 'the latest step again on connect');
  await w.u.cancel();
  await w.done();
});

test('HubClient sends installed on connect and on change, and update messages only while connected', async (t) => {
  const hub = await fakeHub();
  t.after(() => hub.close());
  const dir = await mkdtemp(join(tmpdir(), 'orrery-installed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let welcomes = 0;
  const client = new HubClient({
    config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server: {} as never, token: 't'.repeat(32), root: dir, state: join(dir, 'state') },
    version: 'agent-v0.0.0',
    welcomed: () => welcomes++,
    backoffMs: 10,
  });
  t.after(() => client.stop());
  const step: AgentMsg = { type: 'updateStep', id: 'u1', step: 'prepare', state: 'running', detail: 'x' };
  assert.equal(client.send(step), false, 'not connected');
  const installed = { factorio: '2.1.24', mods: [{ name: 'base', version: '2.1.24' }, { name: 'orrery', version: '0.1.0' }] };
  client.installed(installed);
  client.start();
  const [conn] = await eventually(() => hub.of('agentHello').length === 1 && hub.of('agentHello'));
  await eventually(() => conn!.lines.some((l) => l.type === 'installed'));
  assert.equal(welcomes, 1);
  client.installed({ ...installed, mods: [...installed.mods] });
  assert.equal(client.send(step), true);
  await eventually(() => conn!.lines.some((l) => l.type === 'updateStep'));
  client.installed({ factorio: '2.1.25', mods: installed.mods });
  await eventually(() => conn!.lines.filter((l) => l.type === 'installed').length === 2);
  assert.deepEqual(
    conn!.lines.filter((l) => l.type === 'installed'),
    [{ type: 'installed', ...installed }, { type: 'installed', factorio: '2.1.25', mods: installed.mods }],
    'the same twice is sent once',
  );
  conn!.socket.destroy();
  await eventually(() => hub.of('agentHello').length === 2);
  const again = hub.of('agentHello')[1]!;
  await eventually(() => again.lines.some((l) => l.type === 'installed'));
  assert.equal(welcomes, 2);
  assert.deepEqual(again.invalid, []);
  assert.deepEqual(conn!.invalid, []);
});

test('installed is kept in state/installed.json: a restarted agent sends it on connect with its server stopped, never twice the same', async (t) => {
  const hub = await fakeHub();
  t.after(() => hub.close());
  const dir = await mkdtemp(join(tmpdir(), 'orrery-installed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, 'state');
  const file = join(state, 'installed.json');
  const make = () =>
    new HubClient({
      config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server: {} as never, token: 't'.repeat(32), root: dir, state },
      version: 'agent-v0.0.0',
      backoffMs: 10,
    });
  const mods = [{ name: 'base', version: '2.1.24' }, { name: 'orrery', version: '0.1.0' }];
  const first = make();
  first.installed({ factorio: '2.1.24', mods });
  first.installed({ factorio: '2.1.25', mods });
  await until(async () => JSON.parse(await readFile(file, 'utf8')).factorio === '2.1.25', 2000, 'the newest kept');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { factorio: '2.1.25', mods });
  await first.stop();

  // A new agent on the same Host, its server stopped: no /orrery-status answer, yet the hub hears what it runs.
  const again = make();
  t.after(() => again.stop());
  again.start();
  const conn = (await eventually(() => hub.of('agentHello')[0]))!;
  await eventually(() => conn.lines.some((l) => l.type === 'installed'));
  again.installed({ factorio: '2.1.25', mods: mods.map((m) => ({ ...m })) }); // the server's first answer: the same
  await sleep(50);
  assert.deepEqual(conn.lines.filter((l) => l.type === 'installed'), [{ type: 'installed', factorio: '2.1.25', mods }], 'once');
  assert.deepEqual(conn.invalid, []);
  await again.stop();

  // A file that isn't one (not JSON, another shape, a field over the hub's limit) is never sent.
  for (const bad of ['not json', 'null', JSON.stringify({ factorio: 1, mods: [] }), JSON.stringify({ factorio: '2.1.25', mods: [{ name: 'x'.repeat(257), version: '1.0.0' }] })]) {
    await writeFile(file, bad);
    const n = hub.of('agentHello').length;
    const c = make();
    c.start();
    const other = (await eventually(() => hub.of('agentHello')[n]))!;
    await eventually(() => c.connected);
    await sleep(30);
    await c.stop();
    assert.deepEqual(other.lines.filter((l) => l.type === 'installed'), [], bad);
  }
});

test('a running step goes out again when none went for the beat time (the hub gives an update up after 15 minutes without a word); stop waiting never', async (t) => {
  const w = await world(t, { beatMs: 50, stepMs: 20, gateMs: 500 });
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.broken.add('2.1.25'); // the gate waits its whole time
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  await sleep(300);
  assert.equal(w.steps().filter((m) => m.step === 'stop').length, 1, 'stop waiting once: it asks the hub to stop the server');
  await w.unit.act('stop');
  await w.u.resume();
  assert.equal((await w.done()).outcome, 'rolled back');
  const gate = w.steps().filter((m) => m.step === 'gate' && m.state === 'running');
  assert.ok(gate.length >= 4, `the gate's running step went out ${gate.length} times in 500 ms`);
  assert.ok(gate.every((m) => m.detail === gate[0]!.detail), 'the same step, as it is');
  for (const m of w.sent) assert.ok(parseAgentLine(JSON.stringify(m)), `the hub takes ${JSON.stringify(m)}`);
  const n = w.sent.length;
  await sleep(200);
  assert.equal(w.sent.length, n, 'nothing once it ended');
});

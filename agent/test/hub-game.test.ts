// `HubClient` against the fake hub, the game connection: only while RCON answers, kept through a stall and, with no
// unit state known, closed when RCON is gone (with `StatusPoller` and fake RCON); heartbeats; `bye` and both closes on
// `stop` (index.test.ts: on SIGTERM, which a deploy's `systemctl restart` sends); a game `hello` refused four times as
// `reconnecting too fast` tried again on each RCON answer until welcomed, the Agent connection kept.
//
// `started` once per run, kept across a new agent on the same run, again after a restart between readings (with
// `stopping` for the old run); no game connection while the unit isn't active; a console `cmd` answered by
// `cmdResult` (also when refused or when RCON fails, "may still run" only for one sent and not answered). The setup is
// `hub-setup.ts`.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { HubClient } from '../src/hub.ts';
import { RconNoAnswer, RconNotSent } from '../src/rcon.ts';
import { StatusPoller } from '../src/status.ts';
import { LIMITS } from '../src/wire.ts';
import { eventually } from './fake-hub.ts';
import { PASSWORD, fakeRcon } from './fake-rcon.ts';
import { READING, SERVER, T0, TOKEN, VERSION, sent, setup, unit } from './hub-setup.ts';

test('the game connection: a hello with the agent token and the mod version, then heartbeats; stop sends bye and closes both', async (t) => {
  const { hub, client } = await setup(t);
  client.start();
  await eventually(() => client.connected);
  client.status(READING);
  const game = await eventually(() => hub.of('hello')[0]);
  assert.deepEqual(game.lines[0], { type: 'hello', protocol: 1, serverId: 'factorio', token: TOKEN, modVersion: '0.1.0' });
  // Heartbeats start once the client has read the welcome: the first status again until one lands (RCON answers
  // every 5 s), so the first heartbeat may come more than once.
  const busy = { type: 'heartbeat', tps: 59.8, players: ['alice', 'bob'], paused: false };
  await eventually(() => (client.status({ ups: 59.8, players: ['alice', 'bob'], paused: false, modVersion: '0.1.0' }), game.lines.length >= 2));
  client.status({ ups: 0.2, players: [], paused: true, modVersion: '0.1.0' });
  await eventually(() => game.lines.at(-1)?.tps === 0.2);
  assert.deepEqual(game.lines.slice(1), [...game.lines.slice(1, -1).map(() => busy), { type: 'heartbeat', tps: 0.2, players: [], paused: true }]);

  const agent = hub.of('agentHello')[0]!;
  await client.stop();
  await eventually(() => agent.closed && game.closed, 2000, 'both connections closed');
  assert.deepEqual(agent.lines.at(-1), { type: 'bye' });
  assert.equal(hub.conns.length, 2, 'no reconnect after stop');
  assert.deepEqual([...agent.invalid, ...game.invalid], []);
});

test('the game connection opens only while the Agent connection is up and RCON answers; a stall keeps it; with no unit state known, RCON gone closes it', async (t) => {
  let tick = 0;
  let mode: 'status' | 'hang' | 'garbage' = 'status';
  const handle = (cmd: string) => {
    if (cmd !== '/orrery-status') return [];
    if (mode === 'hang') return undefined; // like a frozen server: no answer at all
    if (mode === 'garbage') return 'Unknown command "orrery-status".';
    tick += 3;
    return JSON.stringify({ ok: true, tick, tick_paused: false, players: ['alice'], version: '2.1.24', mods: { base: '2.1.24', orrery: '0.1.0' }, loaded: true });
  };
  let rcon = await fakeRcon(handle);
  t.after(() => rcon.close());
  let welcome = false;
  const { hub, client } = await setup(t, (hello) => (hello.type === 'hello' || welcome ? 'welcome' : 'silent'), { handshakeMs: 5000 });
  const poller = new StatusPoller({ port: rcon.port, password: PASSWORD, settings: '/nonexistent/server-settings.json', intervalMs: 20, timeoutMs: 100 });
  poller.on('status', (r) => client.status(r));
  poller.on('stalled', () => client.stalled());
  poller.on('down', () => client.down());
  t.after(() => poller.stop());
  client.start();
  poller.start();

  const agent = await eventually(() => hub.of('agentHello')[0]);
  await eventually(() => tick >= 12, 2000, 'RCON answering');
  assert.equal(hub.of('hello').length, 0, 'RCON answers, but the Agent connection is not up');

  welcome = true;
  agent.send({ type: 'welcome' });
  const game = await eventually(() => hub.of('hello')[0]);
  assert.equal(game.lines[0]!.modVersion, '0.1.0');
  await eventually(() => game.lines.length >= 3, 2000, 'heartbeats');
  for (const hb of game.lines.slice(1)) {
    assert.equal(hb.type, 'heartbeat');
    assert.deepEqual(hb.players, ['alice']);
    assert.equal(hb.paused, false);
    assert.ok(typeof hb.tps === 'number' && hb.tps > 0);
  }

  for (const stall of ['hang', 'garbage'] as const) {
    mode = stall; // a blocking save or a frozen server: no heartbeats, so the hub sees it hung, not crashed
    await sleep(60);
    const beats = game.lines.length;
    await sleep(350);
    assert.equal(game.lines.length, beats, `no heartbeat while RCON stalls (${stall})`);
    assert.equal(game.closed, false, `a stall (${stall}) keeps the game connection`);
    mode = 'status';
    await eventually(() => game.lines.length > beats, 2000, `heartbeats again after the ${stall}`);
  }
  assert.equal(hub.of('hello').length, 1, 'the same game connection all along');

  await rcon.close(); // Factorio gone: nothing listens on the RCON port
  await eventually(() => game.closed, 2000, 'the game connection closed');
  await sleep(60);
  assert.equal(hub.of('hello').length, 1, 'not reopened while RCON is gone');
  assert.equal(agent.closed, false, 'the Agent connection stays up');

  rcon = await fakeRcon(handle, Infinity, rcon.port);
  const again = await eventually(() => hub.of('hello')[1], 2000, 'a new game connection');
  await eventually(() => again.lines.length >= 2);
  agent.socket.destroy(); // the Agent connection gone: the game connection follows
  await eventually(() => again.closed, 2000);
  assert.deepEqual([...agent.invalid, ...game.invalid, ...again.invalid], []);
});

test('started once per run of the unit, after the game hello; not again for a run already announced, even by an earlier agent', async (t) => {
  const { hub, client, root } = await setup(t);
  client.start();
  await eventually(() => client.connected);
  client.status(READING); // RCON answers before the unit's first reading: started waits for it
  const game = await eventually(() => hub.of('hello')[0]);
  await sleep(30);
  assert.deepEqual(sent(game, 'started'), []);
  client.service(unit(T0));
  await eventually(() => sent(game, 'started').length === 1 && existsSync(join(root, 'state', 'started.json')), 2000, 'started, then started.json');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'state', 'started.json'), 'utf8')), { since: T0 });

  game.socket.destroy(); // the hub dropped the game connection: the next one is the same run
  await eventually(() => game.closed);
  // The next RCON answer opens a new one, once the client has seen the close too: answers until it has.
  const again = await eventually(() => (client.status(READING), hub.of('hello')[1]), 2000, 'a new game connection');
  await sleep(50);
  assert.deepEqual(sent(again, 'started'), [], 'the same run: no second started');
  await client.stop();

  // A new agent (a deploy, a restart) on the same run: nothing; on the next run: started.
  const next = new HubClient({
    config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server: SERVER, token: TOKEN, root, state: join(root, 'state') },
    version: VERSION,
  });
  t.after(() => next.stop());
  next.service(unit(T0));
  next.start();
  await eventually(() => next.connected);
  next.status(READING);
  const third = await eventually(() => hub.of('hello')[2], 2000, 'the new agent’s game connection');
  await sleep(50);
  assert.deepEqual(sent(third, 'started'), [], 'announced by the agent before');
  next.service(unit(T0 + 5000)); // restarted between two readings
  await eventually(() => third.closed, 2000, 'the old run’s game connection closed');
  assert.deepEqual(sent(third, 'stopping').length, 1);
  next.status(READING);
  const fourth = await eventually(() => hub.of('hello')[3], 2000, 'the next run’s game connection');
  await eventually(() => sent(fourth, 'started').length === 1, 2000, 'started for the next run');
  assert.deepEqual(hub.conns.flatMap((c) => c.invalid), []);
});

test("a game hello the hub refuses as reconnecting too fast is tried again on the next RCON answer, every time (an update's gate waits for it), never given up", async (t) => {
  let refused = 0;
  const { hub, client } = await setup(t, (hello) => {
    if (hello.type === 'hello' && refused < 4) {
      refused++;
      return { reject: 'reconnecting too fast' };
    }
    return 'welcome';
  });
  const logged: string[] = [];
  t.mock.method(console, 'log', (line: string) => logged.push(line));
  client.service(unit(T0)); // the swap started the unit: a new run
  client.start();
  await eventually(() => client.connected);
  // RCON answers, as the status poll does every 5 s while the new Factorio runs.
  const poll = setInterval(() => client.status(READING), 20);
  t.after(() => clearInterval(poll));
  await eventually(() => client.gameUp, 3000, 'the game connection, after four refusals');
  clearInterval(poll);
  assert.equal(refused, 4);
  const hellos = hub.of('hello');
  assert.equal(hellos.length, 5, 'one hello per try: four refused, the fifth welcomed');
  for (const c of hellos.slice(0, 4)) await eventually(() => c.closed, 2000, 'a refused one closed');
  assert.equal(hub.of('agentHello').length, 1, 'the Agent connection stayed');
  assert.ok(!logged.some((l) => l.startsWith('[hub]') && l.includes('(rejected: ')), 'no [hub] rejection, which the first-boot check stops at');
});

test('a console cmd on the game connection runs through command and is answered by cmdResult; one the agent won’t run is answered too', async (t) => {
  const ran: string[] = [];
  const command = async (c: string) => {
    ran.push(c);
    if (c === '/slow') throw new RconNoAnswer('RCON command timed out after 4000 ms'); // sent: Factorio may still run it
    if (c === '/queued') throw new RconNotSent('RCON connection closed before the command was sent');
    return ['Online players (1):', '  alice (online)'];
  };
  const { hub, client } = await setup(t, undefined, { command });
  client.start();
  await eventually(() => client.connected);
  client.status(READING);
  const game = await eventually(() => hub.of('hello')[0]);
  game.send({ type: 'cmd', id: 'c1', command: '/players' });
  game.send({ type: 'cmd', id: 'c2', command: '/slow' });
  game.send({ type: 'cmd', id: 'c3', command: 'x'.repeat(LIMITS.text + 1) });
  game.send({ type: 'cmd', id: 'c4', command: '/c game.print(1)\n/c game.print(2)' });
  game.send({ type: 'cmd', id: 'c5', command: '/queued' });
  await eventually(() => sent(game, 'cmdResult').length === 5, 2000, 'five results');
  const out = Object.fromEntries(sent(game, 'cmdResult').map((r) => [r.id, r.output as string[]]));
  assert.deepEqual(out.c1, ['Online players (1):', '  alice (online)']);
  assert.deepEqual(out.c2, ['no answer in time (Factorio may be saving): the command may still run (RCON command timed out after 4000 ms)']);
  assert.deepEqual(out.c5, ['the command did not run: RCON connection closed before the command was sent']);
  assert.match(out.c3![0]!, /^refused/);
  assert.match(out.c4![0]!, /^refused/, 'one line only');
  assert.deepEqual(ran, ['/players', '/slow', '/queued'], 'only valid commands reach RCON');
  assert.deepEqual(game.invalid, []);
});

test('no game connection while the unit is known and not active: RCON may still answer a Factorio that is shutting down', async (t) => {
  const { hub, client } = await setup(t);
  client.start();
  await eventually(() => client.connected);
  client.service(unit(T0, 'deactivating'));
  client.status(READING);
  await sleep(50);
  assert.equal(hub.of('hello').length, 0);
  client.service(unit(T0 + 1000, 'inactive'));
  client.service(unit(T0 + 5000));
  client.status(READING);
  const game = await eventually(() => hub.of('hello')[0], 2000, 'a game connection for the new run');
  await eventually(() => sent(game, 'started').length === 1);
});

// What a welcomed connection's lines do (`dispatch.ts`): unknown fields dropped, an Agent's game events going off and
// on, a factorio server's paused and hung, requests and their replies (ids, checked data, refusals, timeouts, a
// disconnect), game settings' pushes and `settingsSet`, and the Mod-only messages an Agent's game connection drops.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPLY_WITH_DATA } from '../../src/protocol.ts';
import { sleep, until } from '../fake-mod.ts';
import type { GameSettingsFields } from '../../src/types.ts';
import { agentUp, gameUp, hubSides, readAll, SAMPLE, setup } from './agent-port.ts';

test('unknown fields never reach events, the Host or the state', async (t) => {
  const { agents, hosts, port, events, hub } = await setup(t);
  const agent = await agentUp(port);
  const pushed: unknown[] = [];
  agents.on('serviceState', (id, msg) => pushed.push([id, msg]));
  agents.on('saves', (id, msg) => pushed.push([id, msg]));
  agent.send('{"type":"serviceState","unit":"factorio.service","active":"active","sub":"running","since":5,"result":"success","evil":1,"__proto__":{"admin":true}}');
  agent.send({ type: 'saves', saves: [{ name: 'a.zip', size: 1, mtime: 2, kind: 'auto', current: false, path: '/etc/passwd' }], free: 9, extra: [1] });
  const before = Date.now();
  agent.send({ type: 'hostSample', sample: { ...SAMPLE, memory: { ...SAMPLE.memory, swap: 7 }, disks: [{ ...SAMPLE.disks[0], device: 'sda' }], extra: 1 }, more: 2 });
  await until(() => pushed.length === 2 && hosts.get('vm')!.latest() !== null);
  assert.deepEqual(pushed, [
    ['vm', { type: 'serviceState', unit: 'factorio.service', active: 'active', sub: 'running', since: 5, result: 'success' }],
    ['vm', { type: 'saves', saves: [{ name: 'a.zip', size: 1, mtime: 2, kind: 'auto', current: false }], free: 9 }],
  ]);
  assert.equal(Object.getPrototypeOf((pushed[0] as unknown[])[1]), Object.prototype);
  const latest = hosts.get('vm')!.latest()!;
  assert.deepEqual(latest, { ...SAMPLE, ts: latest.ts });
  assert.ok(latest.ts >= before && latest.ts <= Date.now(), `${latest.ts}`); // the hub's clock, not the Agent's

  const game = await gameUp(port);
  game.send({ type: 'chat', player: 'Ann', message: 'hi', serverId: 'gtnh', avatar: 'x' });
  game.send({ type: 'heartbeat', tps: 60, players: ['Ann'], paused: false, dims: [], cpu: 3 });
  await until(() => hub.get('space')?.tps === 60);
  assert.deepEqual(events.find((e) => e.type === 'chat'), { type: 'chat', player: 'Ann', message: 'hi', serverId: 'space' });
  assert.deepEqual(hub.get('space'), { id: 'space', name: 'Space Age', game: 'factorio', online: true, hung: false, paused: false, tps: 60, players: ['Ann'], dims: [] });
});

test("an Agent's game events going off and on: one host notice per change, a resend on connect posting nothing, within its budget", async (t) => {
  const { port, targets } = await setup(t);
  const posted = () => targets.flatMap((e) => (e.type === 'notice' && (e.kind === 'eventsOff' || e.kind === 'eventsOn') ? [e] : []));
  const reason = 'Factorio could not open its Lua UDP socket (is 127.0.0.1:34198 taken?)';
  const agent = await agentUp(port);
  agent.send({ type: 'events', on: true }); // the hub never heard them off: nothing to say
  agent.send({ type: 'events', on: false, reason });
  await until(() => posted().length === 1);
  assert.deepEqual(posted(), [{ target: 'host', id: 'vm', type: 'notice', severity: 'warning', kind: 'eventsOff', name: 'Factorio VM', reason }]);
  agent.socket.destroy();
  const again = await agentUp(port);
  again.send({ type: 'events', on: false, reason }); // what it sends on each connect
  again.send({ type: 'events', on: true });
  await until(() => posted().length === 2);
  assert.deepEqual(posted()[1], { target: 'host', id: 'vm', type: 'notice', severity: 'good', kind: 'eventsOn', name: 'Factorio VM' });
  // A flapping token holder: only changes take from the budget (3 at once, then 1 per 10 s, across reconnects), and
  // the two above took 2: one more off is posted, the rest dropped.
  for (let i = 0; i < 10; i++) again.send({ type: 'events', on: i % 2 === 1, reason: 'flap' });
  await until(() => posted().length === 3);
  assert.equal(posted()[2]!.kind, 'eventsOff');
  again.send({ type: 'ping' });
  await sleep(100);
  assert.equal(posted().length, 3, 'over the budget: dropped');
});

test('a frozen game while paused is reported hung: its Agent pings on, its heartbeats stop', async (t) => {
  const { hub, port, types } = await setup(t, { hub: { hungMs: 200 } });
  const agent = await agentUp(port);
  const game = await gameUp(port);
  game.send({ type: 'heartbeat', tps: 1, players: [], paused: true });
  await until(() => hub.get('space')?.paused === true);
  assert.equal(hub.get('space')?.tps, null); // a paused server's rate is ignored
  const pings = setInterval(() => agent.send({ type: 'ping' }), 50);
  t.after(() => clearInterval(pings));
  await until(() => types().includes('hung'));
  assert.deepEqual(types(), ['connected', 'paused', 'hung']); // no tps event while paused
  game.send({ type: 'heartbeat', tps: 59.5, players: ['Ann'], paused: false });
  await until(() => types().includes('recovered'));
  assert.deepEqual(hub.get('space'), { id: 'space', name: 'Space Age', game: 'factorio', online: true, hung: false, paused: false, tps: 59.5, players: ['Ann'], dims: [] });
  assert.deepEqual(types(), ['connected', 'paused', 'hung', 'paused', 'tps', 'recovered']);
});

test("a change in a factorio server's paused goes on the stream, once per change, before its rate", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { hub, port, events } = await setup(t);
  const sides = hubSides(t, port);
  await agentUp(port);
  const game = await gameUp(port);
  const beat = async (paused: boolean | undefined, tps = 60) => {
    game.send({ type: 'heartbeat', tps, players: [], ...(paused === undefined ? {} : { paused }) });
    await readAll(sides.at(-1)!, game.socket);
    t.mock.timers.tick(1000); // within the heartbeat budget
  };
  await beat(false); // as it was: not paused
  await beat(true);
  await beat(true);
  await beat(undefined, 59); // no `paused` is not paused
  await beat(false, 59);
  await beat(true, 59);
  const seen = () => events.flatMap((e) => (e.type === 'paused' ? [`paused ${e.paused}`] : e.type === 'tps' ? [`tps ${e.tps}`] : []));
  assert.deepEqual(seen(), ['tps 60', 'paused true', 'paused false', 'tps 59', 'paused true']);
  assert.equal(hub.get('space')?.paused, true);
});

test('requests carry fresh ids, answer with checked data, and fail on refusal, bad data, a timeout or a disconnect', async (t) => {
  const { agents, port } = await setup(t, { agents: { requestTimeoutMs: 100 } });
  await assert.rejects(agents.request('vm', { type: 'logs' }), /agent vm is not connected/);
  const agent = await agentUp(port);
  const journal = agents.request('vm', { type: 'journal', unit: 'factorio.service' });
  const asked = (await agent.next()) as { type: string; id: string; unit: string };
  assert.equal(asked.type, 'journal');
  assert.equal(asked.unit, 'factorio.service');
  agent.send({ type: 'reply', id: asked.id, ok: true, data: { lines: ['a', 'b'], extra: 1 } });
  assert.deepEqual(await journal, { lines: ['a', 'b'] });

  const act = agents.request('vm', { type: 'serviceAct', action: 'start' });
  const acted = (await agent.next()) as { id: string; action: string };
  assert.notEqual(acted.id, asked.id);
  assert.equal(acted.action, 'start');
  agent.send({ type: 'reply', id: acted.id, ok: true });
  assert.equal(await act, undefined);

  const refused = agents.request('vm', { type: 'restore', name: 'x.zip' });
  agent.send({ type: 'reply', id: ((await agent.next()) as { id: string }).id, ok: false, error: 'the server is running' });
  await assert.rejects(refused, /the server is running/);
  const bad = agents.request('vm', { type: 'log', name: 'agent.log' });
  agent.send({ type: 'reply', id: ((await agent.next()) as { id: string }).id, ok: true, data: { lines: [1] } });
  await assert.rejects(bad, /malformed/);
  const late = agents.request('vm', { type: 'logs' });
  await agent.next();
  await assert.rejects(late, /did not answer in time/);
  const dropped = agents.request('vm', { type: 'logs' });
  await agent.next();
  agent.socket.destroy();
  await assert.rejects(dropped, /disconnected/);
});

test("a saveUploadEnd's reply gives the stored name: every request with a reply schema has its data read", async (t) => {
  const { agents, port } = await setup(t);
  const agent = await agentUp(port);
  const end = agents.request('vm', { type: 'saveUploadEnd', upload: 'c'.repeat(32) });
  const asked = (await agent.next()) as { id: string };
  agent.send({ type: 'reply', id: asked.id, ok: true, data: { name: 'uploaded-20300101T000000Z-x.zip' } });
  assert.deepEqual(await end, { name: 'uploaded-20300101T000000Z-x.zip' });
  for (const type of ['journal', 'logs', 'log', 'settingsSet', 'saveUploadEnd']) assert.ok(REPLY_WITH_DATA.has(type), type);
  assert.ok(!REPLY_WITH_DATA.has('saveChunk'), 'a request with no data answers undefined');
});

test("a request's own timeout outlives the default one: a long restore is not reported failed while it goes on", async (t) => {
  const { agents, port } = await setup(t, { agents: { requestTimeoutMs: 50 } });
  const agent = await agentUp(port);
  const restore = agents.request('vm', { type: 'restore', name: 'x.zip' }, { timeoutMs: 5_000 });
  const asked = (await agent.next()) as { id: string };
  await sleep(200); // well past the default 50 ms
  agent.send({ type: 'reply', id: asked.id, ok: true });
  assert.equal(await restore, undefined);
  const short = agents.request('vm', { type: 'restore', name: 'x.zip' }, { timeoutMs: 50 });
  await agent.next();
  await assert.rejects(short, /did not answer in time/);
});

test("game settings: a push like the last is skipped, changed ones within their own budget; settingsSet's answer is checked", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  t.mock.method(console, 'error', () => {});
  const { agents, port } = await setup(t);
  const sides = hubSides(t, port);
  const agent = await agentUp(port);
  const pushed: string[] = [];
  agents.on('settings', (_, m) => pushed.push(`${m.settings?.max_players} ${m.pending.join(',')}`));
  const fields: GameSettingsFields = {
    name: 'orrery Factorio',
    description: '',
    max_players: 0,
    require_user_verification: true,
    autosave_interval: 10,
    autosave_slots: 5,
    afk_autokick_interval: 0,
    auto_pause: true,
    auto_pause_when_players_connect: false,
    only_admins_can_pause_the_game: true,
    allow_commands: 'admins-only',
  };
  const settings = (max: number, pending: string[] = []) => ({
    type: 'settings',
    settings: { ...fields, game_password_set: false, max_players: max, game_password: 'never-sent' },
    admins: ['alice'],
    problem: null,
    pending,
    extra: [],
    rolledBack: null,
  });
  for (const msg of [settings(0), settings(0), settings(8, ['auto_pause']), settings(8, ['auto_pause']), settings(0)]) agent.send(msg);
  await readAll(sides[0]!, agent.socket);
  assert.deepEqual(pushed, ['0 ', '8 auto_pause', '0 ']);
  pushed.length = 0;
  for (let i = 1; i <= 12; i++) agent.send(settings(i)); // 7 left of the 10
  await readAll(sides[0]!, agent.socket);
  assert.equal(pushed.length, 7);

  const set = agents.request('vm', {
    type: 'settingsSet',
    settings: { ...fields, max_players: 8 },
    game_password: null,
    admins: ['alice', 'bob'],
  });
  const asked = (await agent.next()) as { type: string; id: string; game_password: unknown; admins: string[] };
  assert.equal(asked.type, 'settingsSet');
  assert.equal(asked.game_password, null, 'null removes the password: it is sent as null');
  assert.deepEqual(asked.admins, ['alice', 'bob']);
  agent.send({ type: 'reply', id: asked.id, ok: true, data: { applied: ['max_players'], pending: ['game_password'], extra: 1 } });
  assert.deepEqual(await set, { applied: ['max_players'], pending: ['game_password'] });
  const bad = agents.request('vm', { type: 'settingsSet', settings: { ...fields, allow_commands: 'false' }, admins: [] });
  agent.send({ type: 'reply', id: ((await agent.next()) as { id: string }).id, ok: true, data: { applied: ['Max Players'], pending: [] } });
  await assert.rejects(bad, /malformed/);
});

test("an Agent's game connection never passes on cmdLate, quest or achievement, which only a Mod sends", async (t) => {
  const { hub, port, events, types } = await setup(t, { hub: { lateMs: 60_000 } });
  await agentUp(port);
  const game = await gameUp(port);
  const late: string[][] = [];
  const result = hub.runCommand('space', '/players', 'test', (lines) => late.push(lines));
  const cmd = (await game.next()) as { id: string };
  game.send({ type: 'cmdResult', id: cmd.id, output: ['Ann'] });
  assert.deepEqual(await result, ['Ann']);
  for (let i = 0; i < 3; i++) game.send({ type: 'cmdLate', id: cmd.id, output: ['late output'] });
  game.send({ type: 'quest', player: 'Ann', quests: [{ name: 'Stone Age', main: true }] });
  game.send({ type: 'achievement', player: 'Ann', achievement: 'Getting Wood' });
  game.send({ type: 'started' });
  game.send({ type: 'started' }); // one per connection
  game.send({ type: 'chat', player: 'Ann', message: 'after' });
  await until(() => types().includes('chat'));
  assert.deepEqual(late, []);
  assert.deepEqual(types(), ['connected', 'console', 'started', 'chat']);
  assert.equal(events.filter((e) => e.type === 'console' && e.late).length, 0);
});

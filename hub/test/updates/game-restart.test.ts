// A hub restart's interrupted updates, and ends that come late or twice: the Agent told to cancel, its later end
// matched by the update's id, an end taken once, and Packs leaving a game update's row to GameUpdates
// (`game-updates.ts`, `game-run.ts`).

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ServerSettings } from '../../src/config.ts';
import { Db } from '../../src/stats/db.ts';
import { GameUpdates } from '../../src/updates/game-updates.ts';
import { Packs, type PacksDeps } from '../../src/packs/packs.ts';
import { agentUp, eventually, gameConfig, gameHub, PICK, ready } from '../fake-agent.ts';

test('on a hub restart a running update is closed as interrupted: the Agent is told to cancel one before the swap, and its end is recorded', async (t) => {
  const cfg = gameConfig(t);
  const h1 = await ready(t, {}, { cfg });
  const { id } = await h1.json<{ id: number }>(h1.req('POST', '/api/servers/space/game/update', PICK), 202);
  const update = await h1.answer();
  h1.step(update.id, 'prepare', 'running', 'Downloading');
  await eventually(async () => (await h1.game()).running?.steps[0]?.detail === 'Downloading');
  await h1.close();

  const h = await gameHub(t, { cfg });
  const g = await h.game();
  assert.equal(g.running, null);
  assert.equal(g.blocked, "Space Age's Agent isn't connected.");
  assert.deepEqual([g.history[0]!.id, g.history[0]!.outcome], [id, 'failed']);
  assert.ok(g.history[0]!.log.endsWith('interrupted during prepare: the hub restarted. The Agent is told to cancel it when it connects.'), g.history[0]!.log);
  const a = await agentUp(h.agentPort);
  assert.equal((await a.answer()).type, 'updateCancel'); // first thing on connecting
  a.done(update.id, 'cancelled');
  await eventually(async () => (await h.game()).history[0]?.outcome === 'cancelled');
  assert.ok((await h.game()).history[0]!.log.endsWith('Then the Agent ended it: cancelled.'));
  assert.deepEqual(h.notices.at(-1)?.kind, 'packUpdateFinished');
});

test('on a hub restart an update past its swap is not cancelled: the Agent\'s later end is recorded', async (t) => {
  const cfg = gameConfig(t);
  const h1 = await ready(t, {}, { cfg });
  await h1.json(h1.req('POST', '/api/servers/space/game/update', PICK), 202);
  const update = await h1.answer();
  h1.step(update.id, 'stop', 'waiting');
  await h1.answer(); // the stop
  h1.agent.send({ type: 'serviceState', unit: 'factorio.service', active: 'inactive', sub: 'dead', since: 2, result: 'success' });
  await h1.answer(); // resume
  h1.step(update.id, 'swap', 'done', 'Swapped');
  await eventually(async () => (await h1.game()).history[0]?.step === 'swap');
  await h1.close();

  const h = await gameHub(t, { cfg });
  assert.ok((await h.game()).history[0]!.log.endsWith("interrupted during swap: the hub restarted. The Agent's result is recorded when it comes."));
  const a = await agentUp(h.agentPort);
  await eventually(async () => (await h.game()).installed !== null);
  a.done(update.id, 'rolled back', 'orrery-pre-update-2.1.24-20261101T120000Z.zip');
  await eventually(async () => (await h.game()).history[0]?.outcome === 'rolled back');
  assert.equal((await h.game()).history[0]!.backup, 'orrery-pre-update-2.1.24-20261101T120000Z.zip');
  assert.ok(!a.got.some((m) => m.type === 'updateCancel'));
});

test('after a hub restart the end recorded is the update the Agent echoes: refused with none echoed, no stray end lands on the row', async (t) => {
  const cfg = gameConfig(t);
  const h1 = await ready(t, {}, { cfg });
  await h1.json(h1.req('POST', '/api/servers/space/game/update', PICK), 202);
  const update = await h1.answer();
  h1.step(update.id, 'prepare', 'running', 'Downloading');
  await eventually(async () => (await h1.game()).running?.steps[0]?.detail === 'Downloading');
  await h1.close();

  // Nothing runs there: it echoes no step, and refuses the cancel.
  const h = await gameHub(t, { cfg });
  const a = await agentUp(h.agentPort);
  a.agent.socket.setNoDelay(true); // the refusal goes out alone, not held back to share a packet with the stray end
  assert.equal((await a.answer('no update is running')).type, 'updateCancel');
  await new Promise((r) => setTimeout(r, 20)); // the refusal heard
  a.done('another-update', 'ok'); // a stray end, later
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await h.game()).history[0]!.outcome, 'failed');
});

test('after a hub restart an update the Agent echoes in a step is the one whose end goes on the row; another is ignored', async (t) => {
  const cfg = gameConfig(t);
  const h1 = await ready(t, {}, { cfg });
  await h1.json(h1.req('POST', '/api/servers/space/game/update', PICK), 202);
  const update = await h1.answer();
  h1.step(update.id, 'prepare', 'running', 'Downloading');
  await eventually(async () => (await h1.game()).running?.steps[0]?.detail === 'Downloading');
  await h1.close();

  const h = await gameHub(t, { cfg });
  const a = await agentUp(h.agentPort);
  a.step(update.id, 'prepare', 'running', 'Downloading'); // its latest again, as it connects
  assert.equal((await a.answer('too late to cancel')).type, 'updateCancel');
  a.done('another-update', 'ok');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await h.game()).history[0]!.outcome, 'failed');
  a.done(update.id, 'failed in staging');
  await eventually(async () => (await h.game()).history[0]?.outcome === 'failed in staging');
});

test("an update's end is taken once: a flood of the same updateDone (only the line budget holds it) posts and stores nothing more", async (t) => {
  const h = await ready(t, { unit: 'inactive' });
  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  const update = await h.answer();
  h.done(update.id, 'ok');
  await eventually(async () => (await h.game()).running === null);
  const notices = h.notices.length;
  const history = (await h.game()).history;
  for (let i = 0; i < 20; i++) h.done(update.id, i % 2 ? 'failed' : 'ok');
  h.agent.send({ type: 'ping' }); // the Agent connection still up after them
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.notices.length, notices, 'nothing announced again');
  assert.deepEqual((await h.game()).history, history, 'the row as it was');
});

test("a new update ends the wait for the last one's end: a repeated end of the new one never lands on the old row", async (t) => {
  const cfg = gameConfig(t);
  const h1 = await ready(t, {}, { cfg });
  const { id: old } = await h1.json<{ id: number }>(h1.req('POST', '/api/servers/space/game/update', PICK), 202);
  await h1.answer();
  await h1.close();

  const h = await gameHub(t, { cfg });
  const a = await agentUp(h.agentPort);
  assert.equal((await a.answer()).type, 'updateCancel'); // taken, but its end never comes
  await eventually(async () => (await h.game()).blocked === null);
  const { id } = await h.json<{ id: number }>(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  const update = await a.answer();
  a.done(update.id, 'ok');
  await eventually(async () => (await h.game()).running === null);
  a.done(update.id, 'ok'); // once more
  await new Promise((r) => setTimeout(r, 50));
  const history = (await h.game()).history;
  assert.deepEqual(
    history.map((r) => [r.id, r.outcome]),
    [
      [id, 'ok'],
      [old, 'failed'],
    ],
  );
});

test("Packs.start closes only pack updates; a game update's row is left to GameUpdates, which closes it as interrupted", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-sweep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Db(join(dir, 'hub.db'));
  t.after(() => db.close());
  const row = { changes: null, by: 'alex', started: 1 };
  const pack = db.startPackUpdate('gtnh', { from: '2.7.4', to: '2.7.5', ...row });
  const game = db.startPackUpdate('space', { from: '2.1.24 · 5 mods', to: '2.1.24 · 7 mods', ...row });
  // A Minecraft server that lost its folder (so has no packs now), and one gone from config: closed as before.
  db.startPackUpdate('bare', { from: '2.7.4', to: '2.7.5', ...row });
  db.startPackUpdate('gone', { from: '2.7.4', to: '2.7.5', ...row });
  const servers = [
    { id: 'gtnh', name: 'GTNH', game: 'minecraft', dir: join(dir, 'gtnh'), backupMinFreeGB: 10, lag: { tps: 15, minutes: 2, enabled: true }, quests: 'batched', service: 'gtnh' },
    { id: 'bare', name: 'Bare', game: 'minecraft', backupMinFreeGB: 10, lag: { tps: 15, minutes: 2, enabled: true }, quests: 'batched', service: 'gtnh' },
    { id: 'space', name: 'Space Age', game: 'factorio', backupMinFreeGB: 10, lag: { tps: 50, minutes: 2, enabled: true }, quests: 'batched', service: 'factorio' },
  ] satisfies ServerSettings[];
  const hub = { on: () => {}, off: () => {} } as unknown as PacksDeps['hub'];
  const services = { ofServer: (id: string): unknown => ({ id: id === 'gtnh' ? 'gtnh' : 'factorio', unit: `${id}.service`, state: 'active', sub: 'running', checks: [] }) } as unknown as PacksDeps['services'];
  const packs = new Packs({ hub, db, services, servers, hasMod: (id: string) => id === 'gtnh', dataDir: dir } as unknown as PacksDeps);
  await packs.start();
  packs.stop();
  const outcome = (server: string) => db.packUpdates(server, 1)[0]!;
  assert.equal(outcome('gtnh').id, pack);
  assert.equal(outcome('gtnh').outcome, 'failed');
  assert.deepEqual([outcome('bare').outcome, outcome('gone').outcome], ['failed', 'failed']);
  assert.deepEqual([outcome('space').id, outcome('space').outcome], [game, 'running']);

  const agents = { list: () => [{ id: 'vm', server: 'space' }], on: () => {} } as unknown as ConstructorParameters<typeof GameUpdates>[0]['agents'];
  const updates = new GameUpdates({ hub, db, agents, servers } as unknown as ConstructorParameters<typeof GameUpdates>[0]);
  updates.start();
  assert.equal(outcome('space').outcome, 'failed');
  assert.ok(outcome('space').log.startsWith('interrupted during prepare: the hub restarted.'));
});

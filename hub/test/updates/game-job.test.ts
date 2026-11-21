// A game update's quiet give-up and cancel: counted from the Agent's latest step, told to cancel, an update request
// cut off, and a late end after the give-up recorded once (`game-job.ts`).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentUp, eventually, PICK, ready } from '../fake-agent.ts';

test('the quiet give-up counts from the Agent\'s latest step: an update it keeps reporting on runs past it', async (t) => {
  const h = await ready(t, {}, { quietMs: 200 });
  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  const update = await h.answer();
  for (let i = 0; i < 12; i++) {
    h.step(update.id, 'prepare', 'running', `Downloading: ${i * 10} MiB`);
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.notEqual((await h.game()).running, null); // 600 ms, three times its quiet time
  assert.ok(!h.got.some((m) => m.type === 'updateCancel'));
  await eventually(async () => (await h.game()).history[0]?.outcome === 'failed in staging');
  assert.ok((await h.game()).history[0]!.log.includes('No word from the Agent for'));
});

test('an Agent that says nothing about its update is given up, and told to cancel it', async (t) => {
  const h = await ready(t, {}, { quietMs: 100 });
  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  await h.answer(); // accepted, then silence
  assert.equal((await h.answer()).type, 'updateCancel');
  await eventually(async () => (await h.game()).history[0]?.outcome === 'failed in staging');
  assert.ok((await h.game()).history[0]!.log.includes('No word from the Agent for'));
});

test('an update request cut off before its reply is cancelled: the Agent may have started it, and is told on reconnect', async (t) => {
  const h = await ready(t);
  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  assert.equal(((await h.agent.next()) as { type: string }).type, 'update');
  h.agent.socket.destroy(); // no reply
  await eventually(async () => (await h.game()).history[0]?.outcome === 'failed in staging');
  const a = await agentUp(h.agentPort);
  assert.equal((await a.answer()).type, 'updateCancel');
});

test('a late updateDone after the hub gave the update up is recorded once: repeats change nothing', async (t) => {
  const h = await ready(t, {}, { quietMs: 100 });
  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  const update = await h.answer();
  assert.equal((await h.answer()).type, 'updateCancel'); // given up, and told
  await eventually(async () => (await h.game()).history[0]?.outcome === 'failed in staging');
  h.done(update.id, 'cancelled');
  await eventually(async () => (await h.game()).history[0]?.outcome === 'cancelled');
  const notices = h.notices.length;
  const history = (await h.game()).history;
  for (let i = 0; i < 5; i++) h.done(update.id, 'ok'); // resent until the Agent knows its write went out
  h.agent.send({ type: 'ping' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.notices.length, notices);
  assert.deepEqual((await h.game()).history, history);
});

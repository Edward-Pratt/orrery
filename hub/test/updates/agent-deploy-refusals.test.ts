// What an Agent deploy refuses and what refuses it: every deploy while its unit hasn't reported its end, a restore
// while it runs, an Agent below the floor, the request's own refusals, and a countdown, game update or restore on its
// server.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameState, ServerDetail } from '../../src/api.ts';
import { eventually, PICK } from '../fake-agent.ts';
import { connected, deployConfig, deployHub, restarted, started, TAG } from './agent-deploys-hub.ts';

test("while an Agent deploy's unit hasn't reported its end, every deploy is refused saying so; an older deploy's result never changes a newer row", async (t) => {
  const h = await deployHub(t, deployConfig(t), 10_000);
  const a = await connected(h);
  await started(h, a);
  const b = await restarted(h, a, TAG);
  await eventually(async () => (await h.rows())[0]!.outcome === 'ok');
  const finishing = [409, `Factorio VM's deploy of ${TAG} hasn't reported its end yet: deploy once it has.`];
  assert.deepEqual(await h.refused({ part: 'agent', tag: 'agent-v1.1.0', host: 'vm' }), finishing);
  assert.deepEqual(await h.refused({ part: 'hub', tag: 'hub-v2.7.0' }), finishing);
  assert.deepEqual(await h.refused({ part: 'agent', tag: TAG, host: 'vm' }), finishing);
  b.agent.send({ type: 'deployResult', tag: TAG, outcome: 'ok', log: 'ok' });
  await eventually(async () => (await h.game()).blocked === null);
  assert.deepEqual(await h.refused({ part: 'agent', tag: TAG, host: 'vm' }), [409, `${TAG} is already running.`]);

  // Back to agent-v1.1.0: the first deploy's result, sent again, is not this one's.
  const res = h.deploy({ part: 'agent', tag: 'agent-v1.1.0', host: 'vm' });
  assert.equal((await b.answer()).type, 'deploy');
  assert.equal((await res).status, 202);
  b.agent.send({ type: 'deployResult', tag: TAG, outcome: 'rolled back', log: 'an old one' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual((await h.rows()).map((r) => [r.to, r.outcome]), [['agent-v1.1.0', 'running'], [TAG, 'ok']]);
  await restarted(h, b, 'agent-v1.1.0');
  await eventually(async () => (await h.rows())[0]!.outcome === 'ok');
  assert.equal((await h.rows())[1]!.outcome, 'ok');
});

test('a restore is refused while an Agent deploy runs on its server, until its result', async (t) => {
  const h = await deployHub(t, deployConfig(t), 10_000);
  const a = await connected(h); // its unit inactive
  a.agent.send({ type: 'saves', saves: [{ name: 'orrery-20261101T000000Z.zip', size: 10, mtime: 1, kind: 'named', current: false }], free: 1e9 });
  await eventually(async () => {
    const { backups } = await h.json<ServerDetail>(h.req('GET', '/api/servers/space'));
    return backups.configured && backups.backups.length === 1;
  });
  await started(h, a);
  const restore = () => h.req('POST', '/api/servers/space/restore', { name: 'orrery-20261101T000000Z.zip' });
  const refused = await restore();
  assert.deepEqual([refused.status, await refused.text()], [409, "Space Age's Agent is being deployed: restore once it is done."]);
  a.agent.send({ type: 'deployResult', tag: TAG, outcome: 'failed', log: "can't download orrery-agent-v1.2.0.tar.gz" }); // before any restart
  await eventually(async () => (await h.rows())[0]!.outcome === 'failed');
  const done = restore();
  const request = (await a.agent.next()) as { type: string; id: string };
  assert.equal(request.type, 'restore');
  a.agent.send({ type: 'reply', id: request.id, ok: true });
  assert.equal((await done).status, 200);
});

test("an Agent on release 1's agent-v1.0.0, which can't deploy itself, is refused up front with the setup re-run; the repo's agent-v0.0.0 deploys", async (t) => {
  const h = await deployHub(t);
  const old = await connected(h, { version: 'agent-v1.0.0' });
  assert.deepEqual(await h.refused({ part: 'agent', tag: TAG, host: 'vm' }), [
    409,
    "Factorio VM runs agent-v1.0.0, which can't deploy itself: the friend re-runs setup-agent-host.sh at agent-v1.1.0 or later.",
  ]);
  assert.deepEqual(await h.rows(), [], 'no row');
  assert.deepEqual(h.notices, [], 'nothing announced');
  old.agent.socket.destroy();

  // The dev loop's agent (the repo's own version, never a release) deploys as any other.
  const dev = await connected(h, { version: 'agent-v0.0.0' });
  await started(h, dev);
});

test('Agent deploy refusals: an unknown host, no host, a tag of another part, below the floor, the running tag, an Agent not connected', async (t) => {
  const h = await deployHub(t);
  assert.deepEqual(await h.refused({ part: 'agent', tag: TAG, host: 'nope' }), [404, 'No such Agent.']);
  assert.equal((await h.deploy({ part: 'agent', tag: TAG })).status, 400);
  assert.equal((await h.deploy({ part: 'agent', tag: TAG, server: 'space' })).status, 400);
  assert.equal((await h.deploy({ part: 'mod', tag: TAG, server: 'space', host: 'vm' })).status, 400);
  assert.deepEqual(await h.refused({ part: 'agent', tag: 'factorio-v1.0.0', host: 'vm' }), [404, 'No published release factorio-v1.0.0.']);
  assert.deepEqual(await h.refused({ part: 'agent', tag: 'hub-v2.7.0', host: 'vm' }), [404, 'No published release hub-v2.7.0.']);
  assert.deepEqual(await h.refused({ part: 'agent', tag: TAG, host: 'vm' }), [409, "Factorio VM isn't connected."]);
  await connected(h);
  assert.deepEqual(await h.refused({ part: 'agent', tag: 'agent-v0.9.0', host: 'vm' }), [409, 'agent-v0.9.0 is older than agent-v1.1.0, the first release that can deploy.']);
  // Release 1's agent has no deploy handler: going back to it would strand the Host until a setup re-run.
  assert.deepEqual(await h.refused({ part: 'agent', tag: 'agent-v1.0.0', host: 'vm' }), [409, 'agent-v1.0.0 is older than agent-v1.1.0, the first release that can deploy.']);
  assert.deepEqual(await h.refused({ part: 'agent', tag: 'agent-v1.1.0', host: 'vm' }), [409, 'agent-v1.1.0 is already running.']);
  assert.deepEqual(await h.rows(), []);
});

test('an Agent deploy is refused during a countdown, a game update or a restore on its server', async (t) => {
  const h = await deployHub(t);
  const a = await connected(h, { unit: 'active' });
  const detail = () => h.json<ServerDetail>(h.req('GET', '/api/servers/space'));
  await eventually(async () => (await detail()).card.online);

  assert.equal((await h.req('POST', '/api/servers/space/restart', { minutes: 5 })).status, 204);
  assert.deepEqual(await h.refused({ part: 'agent', tag: TAG, host: 'vm' }), [409, 'A countdown is running on Space Age: cancel it first.']);
  assert.equal((await h.req('POST', '/api/servers/space/restart/cancel')).status, 204);

  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  const update = await a.answer();
  assert.deepEqual(await h.refused({ part: 'agent', tag: TAG, host: 'vm' }), [409, 'A game update is running on Space Age: deploy the Agent once it is done.']);
  a.done(update.id, 'cancelled');
  await eventually(async () => (await h.json<GameState>(h.req('GET', '/api/servers/space/game'))).running === null);

  a.agent.send({ type: 'serviceState', unit: 'factorio.service', active: 'inactive', sub: 'dead', since: 2, result: 'success' });
  a.agent.send({ type: 'saves', saves: [{ name: 'orrery-20261101T000000Z.zip', size: 10, mtime: 1, kind: 'named', current: false }], free: 1e9 });
  await eventually(async () => {
    const d = await detail();
    return d.card.service?.state === 'inactive' && d.backups.configured && d.backups.backups.length === 1;
  });
  const restore = h.req('POST', '/api/servers/space/restore', { name: 'orrery-20261101T000000Z.zip' });
  const request = (await a.agent.next()) as { type: string; id: string };
  assert.equal(request.type, 'restore');
  assert.deepEqual(await h.refused({ part: 'agent', tag: TAG, host: 'vm' }), [409, 'A restore is running on Space Age: deploy the Agent once it is done.']);
  a.agent.send({ type: 'reply', id: request.id, ok: true });
  assert.equal((await restore).status, 200);

  await started(h, a); // nothing in the way any more
});

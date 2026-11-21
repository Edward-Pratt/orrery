// Why a game update can't start, and what waits for one: an Agent below the floor, a hub deploy, a restore and a
// daily restart (`game-ctx.ts`'s `blockedReason`).

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { DeploysAnswer } from '../../src/api.ts';
import { beforeAgentFloor } from '../../src/agents/agents.ts';
import { AGENT_TOKEN, eventually, gameConfig, gameHub, PICK, ready } from '../fake-agent.ts';
import { fakeMod } from '../fake-mod.ts';

test("an Agent on release 1's agent-v1.0.0 never says what it runs: the Game tab says it has no game updates, and names the setup re-run", async (t) => {
  assert.deepEqual(
    ['agent-v1.0.0', '1.0.0', 'agent-v0.9.0', 'agent-v1.1.0', 'agent-v2.0.0', 'agent-v0.0.0', 'dev', null].map(beforeAgentFloor),
    [true, true, true, false, false, false, false, false],
  );
  const h = await gameHub(t);
  const hello = async (agentVersion: string) => {
    const agent = fakeMod(h.agentPort);
    t.after(() => agent.socket.destroy());
    agent.send({ type: 'agentHello', protocol: 1, agentId: 'vm', token: AGENT_TOKEN, agentVersion });
    assert.deepEqual(await agent.next(), { type: 'welcome' });
    return agent;
  };
  const old = await hello('agent-v1.0.0');
  await eventually(async () => (await h.game()).blocked !== "Space Age's Agent isn't connected.");
  const blocked = "Space Age's Agent runs agent-v1.0.0, which has no game updates: the friend re-runs setup-agent-host.sh at agent-v1.1.0 or later.";
  assert.equal((await h.game()).blocked, blocked);
  const res = await h.req('POST', '/api/servers/space/game/update', PICK);
  assert.deepEqual([res.status, await res.text()], [409, blocked]);
  old.socket.destroy();
  await eventually(async () => (await h.game()).blocked === "Space Age's Agent isn't connected.");

  // The dev loop's agent (the repo's agent-v0.0.0) has game updates: it just hasn't said yet.
  await hello('agent-v0.0.0');
  await eventually(async () => (await h.game()).blocked === "Space Age's Agent hasn't said what it runs yet.");
});

test('a hub deploy and a restore are refused during a game update, and the deploys answer lists its server', async (t) => {
  const cfg = gameConfig(t);
  cfg.integrations.github = {
    repo: 'Edward-Pratt/orrery',
    newerAfterDays: 14,
    deploys: { root: dirname(cfg.dbPath), hubUnit: 'orrery-hub.service', hubTemplate: 'orrery-deploy', webTemplate: 'orrery-deploy-web', webDir: join(dirname(cfg.dbPath), 'www') },
  };
  const h = await ready(t, { unit: 'inactive' }, { cfg });
  h.agent.send({ type: 'saves', saves: [{ name: 'orrery-20261101T000000Z.zip', size: 10, mtime: 1, kind: 'named', current: false }], free: 1e9 });
  await eventually(async () => (await h.json<DeploysAnswer>(h.req('GET', '/api/deploys'))).checkedAt !== null);
  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  await h.answer();

  const deploy = await h.req('POST', '/api/deploys', { part: 'hub', tag: 'hub-v2.7.0' });
  assert.equal(deploy.status, 409);
  assert.equal(await deploy.text(), 'A game update is running: deploy the hub once it is done.');
  assert.deepEqual((await h.json<DeploysAnswer>(h.req('GET', '/api/deploys'))).packing, ['space']);
  const restore = await h.req('POST', '/api/servers/space/restore', { name: 'orrery-20261101T000000Z.zip' });
  assert.equal(restore.status, 409);
  assert.equal(await restore.text(), 'A game update is running on Space Age: restore once it is done.');
});

test('a daily restart is skipped during a game update', async (t) => {
  const h = await ready(t, {}, { cfg: gameConfig(t, { discord: { guildId: '1'.repeat(18), adminRoleId: '2'.repeat(18), channels: {} } }) });
  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  await h.answer();
  const errors = t.mock.method(console, 'error', () => {});
  const at = new Date();
  at.setHours(5, 49, 59, 0);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: at.getTime() }); // after the Agent connected: its timers stay real
  h.restarts.daily('space', '06:00'); // its countdown starts at 05:50
  t.mock.timers.tick(1000);
  assert.ok(errors.mock.calls.some((c) => String(c.arguments[0]) === '[restart] daily restart of space skipped: a game update is running'));
  t.mock.timers.reset(); // real timers again for the hub's close
});

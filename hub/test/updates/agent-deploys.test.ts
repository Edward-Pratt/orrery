// An Agent's deploy (`deploy-agent.ts`) from the deploys answer to ok: each Agent listed with the release its hello
// named, the `deploy` request and ok on the new release's hello (a throttled hello too), an Agent that doesn't take
// it, and a deploy left running by a hub that stopped. Its results are in `agent-deploy-results.test.ts`, the
// refusals in `agent-deploy-refusals.test.ts`, the shared setup in `agent-deploys-hub.ts`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuditLog, LiveEvent } from '../../src/api.ts';
import { ACTOR, AGENT_TOKEN, eventually, PICK } from '../fake-agent.ts';
import { fakeMod } from '../fake-mod.ts';
import { connected, deployConfig, deployHub, restarted, started, TAG } from './agent-deploys-hub.ts';

test("the deploys answer lists each Agent with the release its hello named, and only agent-v tags as the Agent's releases", async (t) => {
  const h = await deployHub(t);
  const before = await h.answer();
  assert.deepEqual(before.agent.hosts, [{ id: 'vm', name: 'Factorio VM', server: 'space', running: null }]); // never connected
  assert.deepEqual(before.agent.releases.map((r) => r.tag), ['agent-v1.2.0', 'agent-v1.1.0', 'agent-v1.0.0', 'agent-v0.9.0']);
  assert.equal(before.agent.latest, TAG);
  assert.ok(![...before.hub.releases, ...before.web.releases, ...before.mod.releases].some((r) => r.tag.startsWith('factorio-')));
  await connected(h);
  assert.deepEqual((await h.answer()).agent.hosts, [{ id: 'vm', name: 'Factorio VM', server: 'space', running: 'agent-v1.1.0' }]);
});

test('an Agent deploy: the Agent is sent `deploy`, and the row is ok once it says hello as the new release', async (t) => {
  const h = await deployHub(t, deployConfig(t), 10_000);
  const hostNotices: string[] = [];
  h.live.on('event', (_, e: LiveEvent) => {
    if ('target' in e && e.target === 'host' && e.type === 'notice') hostNotices.push(e.kind);
  });
  const a = await connected(h);
  await started(h, a);
  assert.deepEqual(await h.rows(), [{ part: 'agent', target: 'vm', from: 'agent-v1.1.0', to: TAG, by: ACTOR, outcome: 'running', log: '' }]);
  // No game update meanwhile: the Agent restarts itself.
  assert.equal((await h.game()).blocked, "Space Age's Agent is being deployed.");
  const update = await h.req('POST', '/api/servers/space/game/update', PICK);
  assert.deepEqual([update.status, await update.text()], [409, "Space Age's Agent is being deployed."]);
  assert.deepEqual(await h.refused({ part: 'agent', tag: 'agent-v1.1.0', host: 'vm' }), [409, 'Another deploy is running.']);

  const b = await restarted(h, a, TAG);
  await eventually(async () => (await h.rows())[0]!.outcome === 'ok');
  assert.equal((await h.rows())[0]!.log, `Factorio VM runs ${TAG}`);
  assert.equal((await h.answer()).agent.hosts[0]!.running, TAG);
  // Its unit gates on after the hello, holding the Agent's deploy lock: busy until its result.
  assert.equal((await h.game()).blocked, "Space Age's Agent is being deployed.");
  b.agent.send({ type: 'deployResult', tag: TAG, outcome: 'ok', log: `${TAG} connected` });
  await eventually(async () => (await h.game()).blocked === null);
  assert.equal((await h.rows())[0]!.log, `${TAG} connected`); // the script's log, nothing announced again
  const told = h.notices.map((n) => {
    if (n.type === 'notice' && n.kind === 'deployStarted') return [n.kind, n.id, n.from];
    if (n.type === 'notice' && n.kind === 'deployFinished') return [n.kind, n.id, n.outcome];
    return n.type;
  });
  assert.deepEqual(
    told,
    [
      ['deployStarted', 'vm', 'agent-v1.1.0'],
      ['deployFinished', 'vm', 'ok'],
    ],
  );
  // The deploy's restart is a planned exit (`bye`): no agentLost, so no agentBack, on the stream or Discord.
  assert.deepEqual(hostNotices, []);
  const audit = (await h.json<AuditLog>(h.req('GET', '/api/audit'))).entries.filter((e) => e.action === 'deploy');
  assert.deepEqual(
    audit.map(({ actor, target, details }) => ({ actor, target, details })),
    [{ actor: ACTOR, target: 'vm', details: `agent agent-v1.1.0 → ${TAG}` }],
  );
});

test("the restarted Agent's hello is throttled like any reconnect: refused under the window after its last welcome, then welcomed and the deploy ok", async (t) => {
  // A real deploy restart comes long after the 5 s window; this one comes back at once, so the window is 1 s.
  const h = await deployHub(t, deployConfig(t), 10_000, { handshakeMs: 1000 });
  const a = await connected(h);
  await started(h, a);
  a.agent.send({ type: 'bye' });
  await a.agent.closed;
  const early = fakeMod(h.agentPort);
  early.send({ type: 'agentHello', protocol: 1, agentId: 'vm', token: AGENT_TOKEN, agentVersion: TAG });
  assert.deepEqual(await early.next(), { type: 'reject', reason: 'reconnecting too fast' });
  await early.closed;
  assert.equal((await h.rows())[0]!.outcome, 'running', 'the deploy still waits for its hello');
  // The Agent tries again after its backoff, past the window: welcomed as the new release.
  await new Promise((r) => setTimeout(r, 1000));
  await connected(h, { version: TAG });
  await eventually(async () => (await h.rows())[0]!.outcome === 'ok');
});

test("an Agent that doesn't take the deploy answers 502 and closes the row failed", async (t) => {
  const h = await deployHub(t);
  const a = await connected(h);
  const res = h.deploy({ part: 'agent', tag: TAG, host: 'vm' });
  await a.answer('deploy is not supported by this agent');
  const r = await res;
  assert.deepEqual([r.status, await r.text()], [502, 'The deploy failed: deploy is not supported by this agent']);
  assert.deepEqual((await h.rows()).map((row) => [row.outcome, row.log]), [['failed', "the Agent didn't start it: deploy is not supported by this agent"]]);
});

test('an Agent deploy left running by a hub that stopped is closed as interrupted; its later result changes nothing', async (t) => {
  const cfg = deployConfig(t);
  const h1 = await deployHub(t, cfg);
  await started(h1, await connected(h1));
  await h1.close();

  const h = await deployHub(t, cfg);
  assert.deepEqual((await h.rows()).map((r) => [r.outcome, r.log]), [['failed', 'interrupted: the hub restarted']]);
  const a = await connected(h, { version: TAG });
  a.agent.send({ type: 'deployResult', tag: TAG, outcome: 'ok', log: 'ok' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual((await h.rows()).map((r) => r.outcome), ['failed']);
  assert.equal((await h.answer()).agent.hosts[0]!.running, TAG);
});

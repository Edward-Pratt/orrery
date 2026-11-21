// An Agent deploy's end: ok only on a matching hello, the Agent's `deployResult` recorded (and correcting an ok row
// once), taken once, and the waits for the hello and the result, longer than the deploy unit's `TimeoutStartSec`.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AGENT_DEPLOY_MS } from '../../src/updates/deploys.ts';
import { ACTOR, eventually } from '../fake-agent.ts';
import { connected, deployConfig, deployHub, restarted, started, TAG } from './agent-deploys-hub.ts';

test('ok only on a matching agentVersion: back on the old release with no result, the deploy fails once its time is up', async (t) => {
  const h = await deployHub(t);
  const a = await connected(h);
  await started(h, a);
  const back = await restarted(h, a, 'agent-v1.1.0');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await h.rows())[0]!.outcome, 'running'); // the old release's hello is not the deploy's
  back.agent.send({ type: 'deployResult', tag: 'agent-v1.0.5', outcome: 'ok', log: 'another deploy' }); // not this one's
  await eventually(async () => (await h.rows())[0]!.outcome === 'failed');
  assert.equal((await h.rows())[0]!.log, `Factorio VM didn't come back with ${TAG} in time`);
});

test("the Agent's deployResult is recorded: rolled back when it came back on the old release; an ok it can't show is failed", async (t) => {
  const h = await deployHub(t);
  const a = await connected(h);
  await started(h, a);
  const back = await restarted(h, a, 'agent-v1.1.0');
  back.agent.send({ type: 'deployResult', tag: TAG, outcome: 'rolled back', log: `${TAG} didn't connect within 60s\nrolling back to agent-v1.1.0` });
  await eventually(async () => (await h.rows())[0]!.outcome === 'rolled back');
  assert.deepEqual((await h.rows())[0], {
    part: 'agent',
    target: 'vm',
    from: 'agent-v1.1.0',
    to: TAG,
    by: ACTOR,
    outcome: 'rolled back',
    log: `${TAG} didn't connect within 60s\nrolling back to agent-v1.1.0`,
  });
  const last = h.notices.at(-1)!;
  assert.deepEqual(last.type === 'notice' && last.kind === 'deployFinished' && [last.outcome, last.from], ['rolled back', 'agent-v1.1.0']);

  // A result saying ok while its hello named another release.
  await started(h, back);
  back.agent.send({ type: 'deployResult', tag: TAG, outcome: 'ok', log: 'ok' });
  await eventually(async () => (await h.rows())[0]!.outcome === 'failed');
  assert.equal((await h.rows())[0]!.log, 'ok\nFactorio VM says ok, but runs agent-v1.1.0');
});

test('a deployResult after the hello closed the row ok corrects it once: rolled back is recorded and announced; a repeat changes nothing', async (t) => {
  const h = await deployHub(t, deployConfig(t), 10_000);
  const a = await connected(h);
  await started(h, a);
  const b = await restarted(h, a, TAG);
  await eventually(async () => (await h.rows())[0]!.outcome === 'ok');
  // The gate failed after that hello: the script flips back, and the old release comes back with the result.
  const c = await restarted(h, b, 'agent-v1.1.0');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await h.rows())[0]!.outcome, 'ok'); // the old release's hello alone changes nothing
  c.agent.send({ type: 'deployResult', tag: TAG, outcome: 'rolled back', log: `${TAG} didn't connect within 60s\nrolling back to agent-v1.1.0` });
  await eventually(async () => (await h.rows())[0]!.outcome === 'rolled back');
  assert.equal((await h.rows())[0]!.log, `${TAG} didn't connect within 60s\nrolling back to agent-v1.1.0`);
  const told = () => h.notices.flatMap((n) => (n.type === 'notice' && (n.kind === 'deployStarted' || n.kind === 'deployFinished') ? [[n.kind, n.kind === 'deployFinished' ? n.outcome : n.from]] : []));
  assert.deepEqual(told(), [
    ['deployStarted', 'agent-v1.1.0'],
    ['deployFinished', 'ok'],
    ['deployFinished', 'rolled back'],
  ]);
  assert.equal((await h.game()).blocked, null);

  c.agent.send({ type: 'deployResult', tag: TAG, outcome: 'failed', log: 'again' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual((await h.rows()).map((r) => [r.outcome, r.log]), [['rolled back', `${TAG} didn't connect within 60s\nrolling back to agent-v1.1.0`]]);
  assert.equal(told().length, 3);
});

test('with no result after its hello, the wait for it ends in time: the row stays ok and the Agent is free again', async (t) => {
  const h = await deployHub(t); // 300 ms for the hello, then for the result
  const a = await connected(h);
  await started(h, a);
  await restarted(h, a, TAG);
  await eventually(async () => (await h.rows())[0]!.outcome === 'ok');
  assert.equal((await h.game()).blocked, "Space Age's Agent is being deployed.");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await h.game()).blocked, null);
  assert.deepEqual((await h.rows()).map((r) => [r.outcome, r.log]), [['ok', `Factorio VM runs ${TAG}`]]);
});

test("the hub waits for an Agent deploy longer than its deploy unit may run (the unit's TimeoutStartSec)", () => {
  const unit = readFileSync(new URL('../../../deploy/orrery-agent-deploy@.service', import.meta.url), 'utf8');
  const m = /^TimeoutStartSec=(\d+)min$/m.exec(unit);
  assert.ok(m, 'the unit names its TimeoutStartSec in minutes');
  assert.ok(AGENT_DEPLOY_MS > Number(m[1]) * 60_000, `${AGENT_DEPLOY_MS} ms is not over ${m[1]} min`);
});

test('a deployResult is taken once: the Agent resending it (until its write went out) changes nothing more', async (t) => {
  const h = await deployHub(t, deployConfig(t), 10_000);
  const a = await connected(h);
  await started(h, a);
  for (let i = 0; i < 3; i++) a.agent.send({ type: 'deployResult', tag: TAG, outcome: 'failed', log: "can't download orrery-agent-v1.2.0.tar.gz" }); // before any restart
  await eventually(async () => (await h.rows())[0]!.outcome === 'failed');
  await new Promise((r) => setTimeout(r, 50));
  a.agent.send({ type: 'deployResult', tag: TAG, outcome: 'ok', log: 'later' });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual((await h.rows()).map((r) => [r.outcome, r.log]), [['failed', "can't download orrery-agent-v1.2.0.tar.gz"]]);
  const finished = h.notices.filter((n) => n.type === 'notice' && n.kind === 'deployFinished');
  assert.equal(finished.length, 1);
  assert.equal((await h.game()).blocked, null);
});

import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AuditLog, DeploysAnswer, GameState, LiveEvent, ServerDetail, TargetEvent } from '../src/api.ts';
import type { Config } from '../src/config.ts';
import type { GitHub, GitHubRelease } from '../src/deploys.ts';
import { ACTOR, agentUp, eventually, gameConfig, gameHub, PICK } from './fake-agent.ts';

const release = (tag: string, publishedAt: number): GitHubRelease => ({
  tag,
  draft: false,
  prerelease: false,
  publishedAt,
  assets: [`orrery-${tag}.tar.gz`, `orrery-${tag}.tar.gz.sha256`],
});
/** GitHub's releases: Agent ones (one below the floor), the Factorio mod's (never deployed here) and a hub one. */
const github: GitHub = {
  releases: async () => [release('agent-v1.1.0', 2), release('agent-v1.2.0', 3), release('agent-v0.9.0', 1), release('factorio-v1.0.0', 3), release('hub-v2.7.0', 3)],
  download: async () => assert.fail('an Agent downloads its own release'),
};
const TAG = 'agent-v1.2.0';

/** `gameConfig`'s hub (Agent `vm` runs the factorio server `space`) with GitHub on. */
function deployConfig(t: TestContext): Config {
  const cfg = gameConfig(t);
  const root = dirname(cfg.dbPath);
  cfg.integrations.github = {
    repo: 'Edward-Pratt/orrery',
    newerAfterDays: 14,
    deploys: { root, hubUnit: 'orrery-hub.service', hubTemplate: 'orrery-deploy', webTemplate: 'orrery-deploy-web', webDir: join(root, 'www') },
  };
  return cfg;
}

/**
 * A whole hub with the Agent deploys' routes, its deploy notices kept, once it has asked GitHub. `agentTimeoutMs`: how
 * long a deploy waits for the Agent's hello, then for its result.
 */
async function deployHub(t: TestContext, cfg = deployConfig(t), agentTimeoutMs = 300) {
  const h = await gameHub(t, { cfg, releases: github, deploys: { watchMs: 10, agentTimeoutMs } });
  const notices: TargetEvent[] = [];
  h.live.on('event', (_, { at: _at, ...e }: LiveEvent) => {
    if ('target' in e && e.target === 'deploy') notices.push(e);
  });
  const answer = () => h.json<DeploysAnswer>(h.req('GET', '/api/deploys'));
  await eventually(async () => (await answer()).checkedAt !== null);
  const deploy = (body: object) => h.req('POST', '/api/deploys', body);
  const refused = async (body: object) => {
    const res = await deploy(body);
    return [res.status, await res.text()];
  };
  const rows = async () => (await answer()).history.map(({ part, target, from, to, by, outcome, log }) => ({ part, target, from, to, by, outcome, log }));
  return { ...h, notices, answer, deploy, refused, rows };
}

/** The Agent connected as `version`, as the deploys answer shows it. */
async function connected(h: Awaited<ReturnType<typeof deployHub>>, o: Parameters<typeof agentUp>[1] = {}) {
  const a = await agentUp(h.agentPort, { unit: 'inactive', ...o });
  await eventually(async () => (await h.answer()).agent.hosts[0]?.running === (o.version ?? 'agent-v1.1.0') && (await h.game()).installed !== null);
  return a;
}

/** Deploys `TAG` onto Agent `vm`, which takes the request: answers 202. */
async function started(h: Awaited<ReturnType<typeof deployHub>>, a: Awaited<ReturnType<typeof agentUp>>) {
  const res = h.deploy({ part: 'agent', tag: TAG, host: 'vm' });
  const sent = await a.answer();
  assert.deepEqual({ ...sent, id: typeof sent.id }, { type: 'deploy', id: 'string', tag: TAG });
  assert.equal((await res).status, 202);
}

/** The Agent leaves as its deploy restarts it (`bye`), and comes back as `version`. */
async function restarted(h: Awaited<ReturnType<typeof deployHub>>, a: Awaited<ReturnType<typeof agentUp>>, version: string) {
  a.agent.send({ type: 'bye' });
  await a.agent.closed;
  return connected(h, { version });
}

test("the deploys answer lists each Agent with the release its hello named, and only agent-v tags as the Agent's releases", async (t) => {
  const h = await deployHub(t);
  const before = await h.answer();
  assert.deepEqual(before.agent.hosts, [{ id: 'vm', name: 'Factorio VM', server: 'space', running: null }]); // never connected
  assert.deepEqual(before.agent.releases.map((r) => r.tag), ['agent-v1.2.0', 'agent-v1.1.0', 'agent-v0.9.0']);
  assert.equal(before.agent.latest, TAG);
  assert.ok(![...before.hub.releases, ...before.web.releases, ...before.mod.releases].some((r) => r.tag.startsWith('factorio-')));
  await connected(h);
  assert.deepEqual((await h.answer()).agent.hosts, [{ id: 'vm', name: 'Factorio VM', server: 'space', running: 'agent-v1.1.0' }]);
});

test('an Agent deploy: the Agent is sent `deploy`, and the row is ok once it says hello as the new release', async (t) => {
  const h = await deployHub(t, deployConfig(t), 10_000);
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
  const audit = (await h.json<AuditLog>(h.req('GET', '/api/audit'))).entries.filter((e) => e.action === 'deploy');
  assert.deepEqual(
    audit.map(({ actor, target, details }) => ({ actor, target, details })),
    [{ actor: ACTOR, target: 'vm', details: `agent agent-v1.1.0 → ${TAG}` }],
  );
});

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

test("an Agent that doesn't take the deploy answers 502 and closes the row failed", async (t) => {
  const h = await deployHub(t);
  const a = await connected(h);
  const res = h.deploy({ part: 'agent', tag: TAG, host: 'vm' });
  await a.answer('deploy is not supported by this agent');
  const r = await res;
  assert.deepEqual([r.status, await r.text()], [502, 'The deploy failed: deploy is not supported by this agent']);
  assert.deepEqual((await h.rows()).map((row) => [row.outcome, row.log]), [['failed', "the Agent didn't start it: deploy is not supported by this agent"]]);
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
  assert.deepEqual(await h.refused({ part: 'agent', tag: 'agent-v0.9.0', host: 'vm' }), [409, 'agent-v0.9.0 is older than agent-v1.0.0, the first release that can deploy.']);
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

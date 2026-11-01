import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { AuditLog, DeploysAnswer, GameCatalog, ModBrowse, ModCheckAnswer, ServerCard } from '../src/api.ts';
import type { ServerSettings } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { fitsLine, GameUpdates, redact } from '../src/game-updates.ts';
import { LIMITS } from '../src/protocol.ts';
import { Packs, type PacksDeps } from '../src/packs.ts';
import type { Notice } from '../src/types.ts';
import { beforeAgentFloor } from '../src/agents.ts';
import { ACCOUNT, ACTOR, AGENT_TOKEN, agentUp, eventually, gameConfig, gameHub, INSTALLED, MODS, PICK, PNG, ready, rel, SHA256, sha, signed } from './fake-agent.ts';
import { fakeMod } from './fake-mod.ts';

const kinds = (notices: Notice[]) => notices.filter((n) => n.kind !== 'packUpdateStep').map((n) => n.kind);
const webAudit = (log: AuditLog) => log.entries.filter((e) => e.actor.startsWith('web:') && e.action.startsWith('game')).map((e) => [e.action, e.details]);

test('redact takes query strings and credentials out of what the Agent says', () => {
  assert.equal(
    redact('GET https://dl-mod.factorio.com/files/ab/x.zip?secure=abc,1 failed; dl-mod.factorio.com/y.zip?secure=def also; username=owner&token=t0k'),
    'GET https://dl-mod.factorio.com/files/ab/x.zip failed; dl-mod.factorio.com/y.zip also; username=[redacted]&token=[redacted]',
  );
  assert.equal(redact('Staged: 3 mods, 41 MB'), 'Staged: 3 mods, 41 MB');
});

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

test('a game update: the hub resolves it, the Agent gets signed links only, the hub stops the server and resumes the Agent, which ends it', async (t) => {
  const h = await ready(t);
  assert.deepEqual(await h.game(), { installed: { factorio: '2.1.24', mods: INSTALLED }, history: [], running: null, blocked: null });
  const catalog = await h.json<GameCatalog>(h.req('POST', '/api/servers/space/game/catalog', PICK));
  assert.deepEqual(catalog, {
    versions: [{ version: '2.1.24', channel: 'stable' }, { version: '2.1.25', channel: 'experimental' }],
    mods: [
      { name: 'orrery', title: 'orrery', version: '0.1.0', releases: ['0.1.0'], requiredBy: null },
      { name: 'helmod', title: 'helmod', version: '2.0.0', releases: ['2.0.0'], requiredBy: null },
      { name: 'flib', title: 'flib', version: '0.16.2', releases: ['0.16.2', '0.15.0'], requiredBy: 'helmod' },
    ],
    unresolved: [],
    changes: ['Added: helmod 2.0.0', 'Added: flib 0.16.2'],
  });

  const { id } = await h.json<{ id: number }>(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  const update = await h.answer();
  assert.equal(update.type, 'update');
  assert.match(update.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(update.factorio, { version: '2.1.24', url: 'https://www.factorio.com/get-download/2.1.24/headless/linux-arm64', sha256: SHA256 });
  assert.deepEqual(update.mods, [
    { name: 'orrery', version: '0.1.0', sha1: sha('orrery@0.1.0'), url: signed('orrery') },
    { name: 'helmod', version: '2.0.0', sha1: sha('helmod@2.0.0'), url: signed('helmod') },
    { name: 'flib', version: '0.16.2', sha1: sha('flib@0.16.2'), url: signed('flib') },
  ]);
  // Resolved links carry no credentials: the Agent never sees the account.
  assert.ok(!JSON.stringify(update).includes(ACCOUNT.token) && !JSON.stringify(update).includes('username'));

  // What the Agent says is redacted before it is a step's detail or a log line.
  h.step(update.id, 'prepare', 'running', `Downloading ${signed('helmod')} token=${ACCOUNT.token} username=owner`);
  await eventually(() => h.notices.some((n) => n.kind === 'packUpdateStep' && n.step === 'prepare' && n.detail.startsWith('Downloading')));
  const redacted = h.notices.find((n) => n.kind === 'packUpdateStep' && n.detail.startsWith('Downloading'))!;
  assert.deepEqual(redacted, {
    severity: 'info',
    kind: 'packUpdateStep',
    step: 'prepare',
    state: 'running',
    detail: `Downloading https://dl-mod.factorio.com/files/${sha('helmod').slice(0, 2)}/helmod.zip token=[redacted] username=[redacted]`,
    cancellable: true,
  });
  h.step(update.id, 'prepare', 'done', `Staged 3 mods from ${signed('flib')}`);
  h.step(update.id, 'backup', 'done', 'orrery-pre-update-2.1.24-20261101T120000Z.zip');
  h.step(update.id, 'stop', 'waiting');
  // Nobody online: the hub stops the unit at once, through the Agent, and resumes it once the unit is inactive.
  const stop = await h.answer();
  assert.deepEqual([stop.type, stop.action], ['serviceAct', 'stop']);
  h.agent.send({ type: 'serviceState', unit: 'factorio.service', active: 'inactive', sub: 'dead', since: 2, result: 'success' });
  const resume = await h.answer();
  assert.equal(resume.type, 'updateResume');
  assert.notEqual(resume.id, update.id); // a fresh request id: it acts on the update running
  assert.equal((await h.game()).running?.cancellable, false);
  h.step(update.id, 'swap', 'done', 'Swapped');
  h.step(update.id, 'gate', 'done', 'Back after 0:20');
  h.agent.send({ type: 'installed', factorio: '2.1.24', mods: [...INSTALLED, { name: 'helmod', version: '2.0.0' }, { name: 'flib', version: '0.16.2' }] });
  h.done(update.id, 'ok');
  await eventually(async () => (await h.game()).running === null);

  const g = await h.game();
  assert.equal(g.installed?.mods.length, 7);
  const { finished, started, log, ...row } = g.history[0]!;
  assert.ok(finished! >= started);
  assert.deepEqual(row, { id, from: '2.1.24 · 5 mods', to: '2.1.24 · 7 mods', changes: ['Added: helmod 2.0.0', 'Added: flib 0.16.2'], by: 'alex', outcome: 'ok', step: 'gate', backup: null });
  assert.ok(!/secure=|token=|username=owner/.test(log), log);
  assert.ok(log.includes(`prepare: done: Staged 3 mods from https://dl-mod.factorio.com/files/`), log);
  assert.deepEqual(kinds(h.notices), ['packUpdateStarted', 'packUpdateFinished']);
  assert.deepEqual(h.notices[0], { severity: 'info', kind: 'packUpdateStarted', from: '2.1.24 · 5 mods', to: '2.1.24 · 7 mods', by: 'alex' });
  assert.deepEqual(webAudit(await h.json<AuditLog>(h.req('GET', '/api/audit'))), [
    ['game update', '2.1.24 · 5 mods → 2.1.24 · 7 mods: ok'],
    ['game update', '2.1.24 · 5 mods → 2.1.24 · 7 mods: Added: helmod 2.0.0, Added: flib 0.16.2'],
  ]);
});

test('an update starts on a stopped server: no stop is asked, the Agent goes on once it has saved', async (t) => {
  const h = await ready(t, { unit: 'inactive' });
  assert.equal((await h.json<ServerCard[]>(h.req('GET', '/api/servers'))).find((c) => c.id === 'space')!.online, false);
  await h.json(h.req('POST', '/api/servers/space/game/update', { factorio: '2.1.24', mods: [{ name: 'orrery', version: null }, { name: 'flib', version: null }] }), 202);
  const update = await h.answer();
  assert.deepEqual((update.mods as { name: string }[]).map((m) => m.name), ['orrery', 'flib']);
  h.step(update.id, 'backup', 'done', 'Stopped: the newest save is world.zip');
  h.step(update.id, 'stop', 'waiting');
  assert.equal((await h.answer()).type, 'updateResume');
  h.step(update.id, 'swap', 'done');
  h.done(update.id, 'ok');
  await eventually(async () => (await h.game()).running === null);
  const row = (await h.game()).history[0]!;
  assert.deepEqual([row.outcome, row.from, row.to, row.changes], ['ok', '2.1.24 · 5 mods', '2.1.24 · 6 mods', ['Added: flib 0.16.2']]);
  assert.ok(row.log.includes('stop: done: Already stopped'), row.log);
  assert.ok(!h.got.some((m) => m.type === 'serviceAct'));
});

test('cancel before the swap: while the Agent prepares it is told to cancel; after the swap it is too late', async (t) => {
  const h = await ready(t);
  const { id } = await h.json<{ id: number }>(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  const update = await h.answer();
  h.step(update.id, 'prepare', 'running', 'Downloading');
  await eventually(async () => (await h.game()).running?.steps[0]?.detail === 'Downloading');
  assert.equal((await h.game()).running?.cancellable, true);
  const cancelling = h.req('POST', '/api/servers/space/game/update/cancel');
  const cancel = await h.answer();
  assert.equal(cancel.type, 'updateCancel');
  assert.equal((await cancelling).status, 204);
  h.step(update.id, 'stop', 'waiting'); // too late to matter: it was told to cancel
  h.done(update.id, 'cancelled');
  await eventually(async () => (await h.game()).history[0]?.outcome === 'cancelled');
  assert.equal((await h.game()).history[0]!.id, id);
  assert.ok(!h.got.some((m) => m.type === 'serviceAct'));

  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  const second = await h.answer();
  h.step(second.id, 'stop', 'waiting');
  await h.answer(); // the stop
  h.agent.send({ type: 'serviceState', unit: 'factorio.service', active: 'inactive', sub: 'dead', since: 2, result: 'success' });
  await h.answer(); // resume
  h.step(second.id, 'swap', 'running', 'Swapping');
  await eventually(async () => (await h.game()).running?.steps.some((s) => s.step === 'swap' && s.state === 'running') ?? false);
  const late = await h.req('POST', '/api/servers/space/game/update/cancel');
  assert.equal(late.status, 409);
  assert.equal(await late.text(), 'Too late to cancel: only before the swap, while it prepares or during the countdown.');
  h.done(second.id, 'rolled back', 'orrery-pre-update-2.1.24-20261101T120000Z.zip');
  await eventually(async () => (await h.game()).running === null);
  assert.deepEqual([(await h.game()).history[0]!.outcome, (await h.game()).history[0]!.backup], ['rolled back', 'orrery-pre-update-2.1.24-20261101T120000Z.zip']);
  assert.deepEqual(h.notices.at(-1), {
    severity: 'problem',
    kind: 'packUpdateFinished',
    outcome: 'rolled back',
    from: '2.1.24 · 5 mods',
    to: '2.1.24 · 7 mods',
    ms: (h.notices.at(-1) as { ms: number }).ms,
    backup: 'orrery-pre-update-2.1.24-20261101T120000Z.zip',
  });
});

test('with players online the stop counts down; cancelling the countdown cancels the update before the swap', async (t) => {
  const h = await ready(t, { players: ['Ann'] });
  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  const update = await h.answer();
  h.step(update.id, 'stop', 'waiting');
  await eventually(() => h.notices.some((n) => n.kind === 'restartScheduled'));
  await eventually(async () => /^1 player online: stopping in \d+:\d\d$/.test((await h.game()).running?.steps.find((s) => s.step === 'stop')?.detail ?? ''));
  assert.equal((await h.game()).running?.cancellable, true);
  assert.equal((await h.game()).blocked, 'A game update is running on Space Age.');
  const cancelling = h.req('POST', '/api/servers/space/game/update/cancel');
  assert.equal((await h.answer()).type, 'updateCancel');
  assert.equal((await cancelling).status, 204);
  assert.ok(h.notices.some((n) => n.kind === 'restartCancelled'));
  h.done(update.id, 'cancelled');
  await eventually(async () => (await h.game()).history[0]?.outcome === 'cancelled');
  assert.ok(!h.got.some((m) => m.type === 'serviceAct')); // the countdown never fired
  assert.deepEqual(webAudit(await h.json<AuditLog>(h.req('GET', '/api/audit'))).map(([action]) => action), ['game update', 'game update cancel', 'game update']);
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

test('the game routes: 404 for a server no Agent runs, 400 for bad input, 409 with unmet dependencies, nothing to change or no Agent', async (t) => {
  const h = await gameHub(t);
  assert.equal((await h.req('GET', '/api/servers/gtnh/game')).status, 404);
  assert.equal((await h.req('GET', '/api/servers/nope/game')).status, 404);
  assert.equal((await h.game()).blocked, "Space Age's Agent isn't connected.");
  const refused = async (path: string, body: unknown, status: number, text: string | RegExp) => {
    const res = await h.req('POST', `/api/servers/space/game/${path}`, body);
    assert.equal(res.status, status, path);
    const got = await res.text();
    if (typeof text === 'string') assert.equal(got, text);
    else assert.match(got, text);
  };
  await refused('update', PICK, 409, "Space Age's Agent isn't connected.");
  const a = await agentUp(h.agentPort);
  await eventually(async () => (await h.game()).installed !== null);
  await refused('catalog', { factorio: '2.1', mods: [] }, 400, 'Give a Factorio version, like 2.1.24.');
  await refused('catalog', { factorio: '2.1.24', mods: [{ name: '../x', version: null }] }, 400, 'Give each mod by its name on the mod portal.');
  await refused('catalog', { factorio: '2.1.24', mods: [{ name: '.', version: null }] }, 400, 'Give each mod by its name on the mod portal.');
  await refused('catalog', { factorio: '2.1.24', mods: [{ name: 'flib', version: '../../x' }] }, 400, 'flib: give a version like 1.2.3, or null for the newest that fits.');
  await refused('catalog', { factorio: '2.1.24', mods: [{ name: 'base', version: null }] }, 400, "base comes with Factorio: it isn't picked.");
  await refused('catalog', { factorio: '2.1.24', mods: [{ name: 'flib', version: null }, { name: 'flib', version: null }] }, 400, 'flib is picked twice.');
  await refused('catalog', { factorio: '2.1.24', mods: [{ name: 'gone', version: null }] }, 404, 'The mod portal has no mod gone.');
  const needy = await h.json<GameCatalog>(h.req('POST', '/api/servers/space/game/catalog', { factorio: '2.1.24', mods: [{ name: 'needy', version: null }] }));
  assert.deepEqual(needy.unresolved, [{ mod: 'needy', dependency: 'nowhere', reason: 'Not on the mod portal.' }]);
  await refused('update', { factorio: '2.1.24', mods: [{ name: 'needy', version: null }] }, 409, 'Unmet dependencies: needy needs nowhere: Not on the mod portal.');
  await refused('update', { factorio: '2.1.24', mods: [{ name: 'orrery', version: null }] }, 409, 'Nothing to change: Space Age runs 2.1.24 · 5 mods already.');
  await refused('update', { factorio: '2.1.99', mods: [{ name: 'orrery', version: null }] }, 400, "factorio.com lists no headless build of Factorio 2.1.99 for the Agent's machine.");
  await refused('update/cancel', {}, 409, 'No game update is running on Space Age.');
  assert.ok(!a.got.some((m) => m.type === 'update'));
  // A release 1 Agent refuses `update`: the row ends failed in staging, with its reason.
  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  await a.answer('update is not supported by this agent');
  await eventually(async () => (await h.game()).history[0]?.outcome === 'failed in staging');
  assert.ok((await h.game()).history[0]!.log.includes('prepare: failed: update is not supported by this agent'));
  // Refused outright, it never took the update: no updateCancel, which would hit whatever update it does run.
  a.agent.send({ type: 'ping' });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!a.got.some((m) => m.type === 'updateCancel'));
});

test('without FACTORIO_USERNAME and FACTORIO_TOKEN the hub runs, the catalog answers, and only an update is refused, saying why', async (t) => {
  const h = await ready(t, {}, { account: false });
  assert.equal((await h.json<GameCatalog>(h.req('POST', '/api/servers/space/game/catalog', PICK))).mods.length, 3);
  const res = await h.req('POST', '/api/servers/space/game/update', PICK);
  assert.equal(res.status, 409);
  assert.equal(await res.text(), "FACTORIO_USERNAME and FACTORIO_TOKEN aren't set on the hub (/etc/orrery-factorio-account.env), so it can't get the mods' download links.");
  assert.equal((await h.game()).history.length, 0);
  // Every update has mods to fetch: orrery at least.
  const none = await h.req('POST', '/api/servers/space/game/update', { factorio: '2.1.24', mods: [] });
  assert.deepEqual([none.status, await none.text()], [409, "The mods must include orrery: the Agent's health gate reads it."]);
  assert.ok(!h.got.some((m) => m.type === 'update'));
});

test('an Agent that says nothing about its update is given up, and told to cancel it', async (t) => {
  const h = await ready(t, {}, { quietMs: 100 });
  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  await h.answer(); // accepted, then silence
  assert.equal((await h.answer()).type, 'updateCancel');
  await eventually(async () => (await h.game()).history[0]?.outcome === 'failed in staging');
  assert.ok((await h.game()).history[0]!.log.includes('No word from the Agent for'));
});

test("the game's own mods stay as installed has them: dependencies are resolved, and from and to counted, against those enabled", async (t) => {
  MODS['needs-recycler'] = [rel('needs-recycler', '1.0.0', ['base >= 2.1.0', 'recycler'])];
  MODS['needs-space'] = [rel('needs-space', '1.0.0', ['base >= 2.1.0', 'space-age'])];
  const h = await ready(t);
  // Space Age disabled by hand in mod-list.json, and recycler never enabled: the Agent keeps both so.
  h.agent.send({ type: 'installed', factorio: '2.1.24', mods: INSTALLED.filter((m) => m.name !== 'space-age') });
  await eventually(async () => (await h.game()).installed?.mods.length === 4);
  const unresolved = async (name: string) =>
    (await h.json<GameCatalog>(h.req('POST', '/api/servers/space/game/catalog', { factorio: '2.1.24', mods: [{ name: 'orrery', version: null }, { name, version: null }] }))).unresolved;
  assert.deepEqual(await unresolved('needs-recycler'), [{ mod: 'needs-recycler', dependency: 'recycler', reason: "recycler comes with Factorio, but it isn't enabled on this server." }]);
  assert.deepEqual(await unresolved('needs-space'), [{ mod: 'needs-space', dependency: 'space-age', reason: "space-age comes with Factorio, but it isn't enabled on this server." }]);
  // orrery's `? space-age` is optional: fine without it. To: base, elevated-rails and quality, and the three mods.
  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  await h.answer();
  const running = (await h.game()).running!;
  assert.deepEqual([running.from, running.to], ['2.1.24 · 4 mods', '2.1.24 · 6 mods']);
});

test('a game update without orrery, or over the Agent\'s mods, is refused before any link, row or request', async (t) => {
  const h = await ready(t);
  const refused = async (mods: { name: string; version: null }[]) => {
    const res = await h.req('POST', '/api/servers/space/game/update', { factorio: '2.1.24', mods });
    return [res.status, await res.text()];
  };
  assert.deepEqual(await refused([{ name: 'helmod', version: null }]), [409, "The mods must include orrery: the Agent's health gate reads it."]);
  // 500 picks, the most a request takes, and a dependency of one of them: 501 mods, more than an `update` holds.
  for (let i = 1; i < LIMITS.mods; i++) MODS[`m${i}`] = [rel(`m${i}`, '1.0.0', i === 1 ? ['base >= 2.1.0', 'flib'] : undefined)];
  const many = [{ name: 'orrery', version: null }, ...Array.from({ length: LIMITS.mods - 1 }, (_, i) => ({ name: `m${i + 1}`, version: null }))];
  const [status, text] = await refused(many);
  assert.equal(status, 409);
  assert.match(text as string, new RegExp(`More than ${LIMITS.mods} mods`));
  assert.deepEqual((await h.game()).history, []);
  assert.ok(!h.got.some((m) => m.type === 'update'));
});

test("fitsLine: an update fits the Agent port's line only with its newline within LIMITS.lineBytes", () => {
  const msg = (n: number) => ({ type: 'update', pad: 'a'.repeat(n) });
  const empty = Buffer.byteLength(JSON.stringify(msg(0)));
  assert.ok(fitsLine(msg(LIMITS.lineBytes - 1 - empty)));
  assert.ok(!fitsLine(msg(LIMITS.lineBytes - empty)));
  assert.ok(!fitsLine({ type: 'update', pad: 'é'.repeat(LIMITS.lineBytes / 2) }), 'bytes, not characters');
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

test('an update that ends during the countdown cancels it: the server is never stopped', async (t) => {
  const h = await ready(t, { players: ['Ann'] });
  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  const update = await h.answer();
  h.step(update.id, 'stop', 'waiting');
  await eventually(() => h.notices.some((n) => n.kind === 'restartScheduled'));
  h.done(update.id, 'failed in staging'); // the Agent restarted meanwhile, and dropped it
  await eventually(() => h.notices.some((n) => n.kind === 'restartCancelled'));
  await eventually(async () => (await h.game()).running === null);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!h.got.some((m) => m.type === 'serviceAct' || m.type === 'updateResume' || m.type === 'updateCancel'));
  assert.deepEqual(kinds(h.notices), ['packUpdateStarted', 'restartScheduled', 'restartCancelled', 'packUpdateFinished']);
  assert.equal((await h.game()).history[0]!.outcome, 'failed in staging');
  assert.equal((await h.game()).blocked, null, 'no countdown left');
});

test('an update that ends while the hub stops the server starts the server again, and the Agent is never resumed', async (t) => {
  const h = await ready(t);
  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  const update = await h.answer();
  h.step(update.id, 'stop', 'waiting');
  const stop = await h.answer();
  assert.deepEqual([stop.type, stop.action], ['serviceAct', 'stop']);
  h.done(update.id, 'failed in staging'); // the unit still deactivating
  const start = await h.answer();
  assert.deepEqual([start.type, start.action], ['serviceAct', 'start']);
  await eventually(async () => (await h.game()).running === null);
  h.agent.send({ type: 'serviceState', unit: 'factorio.service', active: 'inactive', sub: 'dead', since: 2, result: 'success' });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!h.got.some((m) => m.type === 'updateResume' || m.type === 'updateCancel'));
  assert.equal(h.got.filter((m) => m.type === 'serviceAct').length, 2);
  assert.equal((await h.game()).history[0]!.outcome, 'failed in staging');
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

test('the mod browser: a page of the portal\'s mods for the version\'s line through the hub, its parameters checked, and thumbnails as checked PNGs', async (t) => {
  const h = await gameHub(t);
  const mods = '/api/servers/space/game/mods';
  // A session is needed, as for every route; a server no Agent runs has none; no Agent connected is fine (a read).
  assert.equal((await h.app.request(`${mods}?factorio=2.1.24`)).status, 401);
  assert.equal((await h.app.request(`${mods}/flib/thumbnail`)).status, 401);
  assert.equal((await h.req('GET', '/api/servers/gtnh/game/mods?factorio=2.1.24')).status, 404);
  assert.equal((await h.req('GET', '/api/servers/gtnh/game/mods/helmod/thumbnail')).status, 404);
  const answer = await h.json<ModBrowse>(h.req('GET', `${mods}?factorio=2.1.24`));
  assert.deepEqual(answer, {
    line: '2.1',
    total: 3,
    mods: [
      { name: 'flib', title: 'Factorio Library', owner: 'raiguard', summary: 'A library.', downloads: 1_080_000, version: '0.16.2', updated: Date.parse('2026-10-01T00:00:00.000Z'), category: 'internal', spaceAge: false, page: 'https://mods.factorio.com/mod/flib' },
      { name: 'helmod', title: 'Helmod', owner: 'Helfima', summary: 'Plan your factory.', downloads: 500_000, version: '2.0.0', updated: Date.parse('2026-10-02T00:00:00.000Z'), category: 'tweaks', spaceAge: false, page: 'https://mods.factorio.com/mod/helmod' },
      { name: 'Squeak Through', title: 'Squeak Through', owner: 'someone', summary: 'Squeeze.', downloads: 3, version: '1.0.0', updated: null, category: 'tweaks', spaceAge: false, page: 'https://mods.factorio.com/mod/Squeak%20Through' },
    ],
    categories: [{ id: 'tweaks', title: 'Tweaks' }, { id: 'internal', title: 'Internal' }, { id: 'mod-packs', title: 'Mod packs' }],
  });
  const names = async (query: string) => (await h.json<ModBrowse>(h.req('GET', `${mods}?factorio=2.1.24&${query}`))).mods.map((m) => m.name);
  assert.deepEqual(await names('q=PLAN&category=tweaks&sort=updated&page=1'), ['helmod']);
  assert.deepEqual(await names('sort=name'), ['flib', 'helmod', 'Squeak Through']);
  assert.deepEqual(await names('page=2'), []);
  for (const [query, why] of [
    ['', 'Give a Factorio version (factorio), like 2.1.24.'],
    ['factorio=2.1', 'Give a Factorio version (factorio), like 2.1.24.'],
    [`factorio=2.1.24&q=${'x'.repeat(101)}`, 'Search for at most 100 characters.'],
    ['factorio=2.1.24&sort=score', 'Sort by downloads, updated, name.'],
    ['factorio=2.1.24&category=Mod%20Packs', 'Give a category by its id on the mod portal, like mod-packs.'],
    ['factorio=2.1.24&category=nope', 'The mod portal has no category nope.'],
    ['factorio=2.1.24&page=0', 'Give a page from 1 to 1000.'],
    ['factorio=2.1.24&page=x', 'Give a page from 1 to 1000.'],
    ['factorio=2.1.24&page=1001', 'Give a page from 1 to 1000.'],
  ]) {
    const res = await h.req('GET', `${mods}?${query}`);
    assert.deepEqual([res.status, await res.text()], [400, why], query);
  }
  // 100 characters with spaces around them: trimmed, fine.
  assert.equal((await h.req('GET', `${mods}?factorio=2.1.24&q=${encodeURIComponent(` ${'x'.repeat(100)} `)}`)).status, 200);

  // A thumbnail: the fake image's bytes as image/png, never sniffed, kept a day by the browser; a name with a space works.
  const thumb = await h.req('GET', `${mods}/Squeak%20Through/thumbnail`);
  assert.equal(thumb.status, 200);
  assert.deepEqual(
    [thumb.headers.get('content-type'), thumb.headers.get('x-content-type-options'), thumb.headers.get('cache-control')],
    ['image/png', 'nosniff', 'private, max-age=86400'],
  );
  assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), PNG);
  // No thumbnail (flib has none), no such mod, a name that isn't a mod's: 404, kept an hour.
  for (const name of ['flib', 'gone', 'a..b', '..%2F..', 'a%2Fb', 'x%3Cb%3E']) {
    const res = await h.req('GET', `${mods}/${name}/thumbnail`);
    assert.deepEqual([res.status, res.headers.get('cache-control')], [404, 'private, max-age=3600'], name);
  }
  // The portal failing: 502 with why, never cached.
  const down = await h.req('GET', `${mods}/down/thumbnail`);
  assert.deepEqual([down.status, down.headers.get('cache-control'), await down.text()], [502, null, "The mod portal can't be read: HTTP 503."]);
  const old = await h.req('GET', `${mods}?factorio=2.0.0`);
  assert.deepEqual([old.status, await old.text()], [502, "The mod portal can't be read: HTTP 404."]);
});

test("Import mod list's check: each name on the portal for the version's line or not, the body checked before any portal read", async (t) => {
  const h = await gameHub(t);
  const check = '/api/servers/space/game/check';
  const body = { factorio: '2.1.24', names: ['helmod', 'Squeak Through', 'needy', 'gone'] };
  // A session is needed, as for every route; a server no Agent runs has none; no Agent connected is fine (a read).
  assert.equal((await h.app.request(check, { method: 'POST', body: JSON.stringify(body) })).status, 401);
  assert.equal((await h.req('POST', '/api/servers/gtnh/game/check', body)).status, 404);
  // helmod and Squeak Through from the list, needy read on its own (not listed), gone not on the portal.
  assert.deepEqual(await h.json<ModCheckAnswer>(h.req('POST', check, body)), {
    line: '2.1',
    mods: [
      { name: 'helmod', found: 'fits', title: 'Helmod', latest: '2.0.0' },
      { name: 'Squeak Through', found: 'fits', title: 'Squeak Through', latest: '1.0.0' },
      { name: 'needy', found: 'fits', title: 'needy', latest: '1.0.0' },
      { name: 'gone', found: 'missing', title: null, latest: null },
    ],
  });
  assert.deepEqual(await h.json<ModCheckAnswer>(h.req('POST', check, { factorio: '2.0.0', names: [] })), { line: '2.0', mods: [] }); // no read
  for (const [bad, why] of [
    [{ names: ['helmod'] }, 'Give a Factorio version, like 2.1.24.'],
    [{ factorio: '2.1', names: ['helmod'] }, 'Give a Factorio version, like 2.1.24.'],
    [{ factorio: '2.1.24' }, `Give the mods to check by name (names, at most ${LIMITS.mods}).`],
    [{ factorio: '2.1.24', names: 'helmod' }, `Give the mods to check by name (names, at most ${LIMITS.mods}).`],
    [{ factorio: '2.1.24', names: Array.from({ length: LIMITS.mods + 1 }, (_, i) => `m${i}`) }, `Give the mods to check by name (names, at most ${LIMITS.mods}).`],
    [{ factorio: '2.1.24', names: ['../etc'] }, 'Give each mod by its name on the mod portal.'],
    [{ factorio: '2.1.24', names: ['.'] }, 'Give each mod by its name on the mod portal.'], // /api/mods/./full is /api/mods/full
    [{ factorio: '2.1.24', names: ['<script>'] }, 'Give each mod by its name on the mod portal.'],
    [{ factorio: '2.1.24', names: ['x'.repeat(LIMITS.text + 1)] }, 'Give each mod by its name on the mod portal.'],
    [{ factorio: '2.1.24', names: [7] }, 'Give each mod by its name on the mod portal.'],
    [{ factorio: '2.1.24', names: ['space-age'] }, "space-age comes with Factorio: it isn't on the mod portal."],
    [{ factorio: '2.1.24', names: ['helmod', 'helmod'] }, 'helmod is given twice.'],
  ] as const) {
    const res = await h.req('POST', check, bad);
    assert.deepEqual([res.status, await res.text()], [400, why], JSON.stringify(bad).slice(0, 80));
  }
  // The portal has no list for 2.0 here: 502 with why.
  const old = await h.req('POST', check, { factorio: '2.0.0', names: ['helmod'] });
  assert.deepEqual([old.status, await old.text()], [502, "The mod portal can't be read: HTTP 404."]);
});

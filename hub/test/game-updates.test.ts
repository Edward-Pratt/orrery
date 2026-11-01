import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import type { AuditLog, DeploysAnswer, GameCatalog, ServerCard } from '../src/api.ts';
import type { ServerSettings } from '../src/config.ts';
import { Db } from '../src/db.ts';
import { GameUpdates, redact } from '../src/game-updates.ts';
import { Packs, type PacksDeps } from '../src/packs.ts';
import type { Notice } from '../src/types.ts';
import { ACCOUNT, ACTOR, agentUp, eventually, gameConfig, gameHub, INSTALLED, PICK, ready, SHA256, sha, signed } from './fake-agent.ts';

const kinds = (notices: Notice[]) => notices.filter((n) => n.kind !== 'packUpdateStep').map((n) => n.kind);
const webAudit = (log: AuditLog) => log.entries.filter((e) => e.actor.startsWith('web:') && e.action.startsWith('game')).map((e) => [e.action, e.details]);

test('redact takes query strings and credentials out of what the Agent says', () => {
  assert.equal(
    redact('GET https://dl-mod.factorio.com/files/ab/x.zip?secure=abc,1 failed; dl-mod.factorio.com/y.zip?secure=def also; username=owner&token=t0k'),
    'GET https://dl-mod.factorio.com/files/ab/x.zip failed; dl-mod.factorio.com/y.zip also; username=[redacted]&token=[redacted]',
  );
  assert.equal(redact('Staged: 3 mods, 41 MB'), 'Staged: 3 mods, 41 MB');
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
  await h.json(h.req('POST', '/api/servers/space/game/update', { factorio: '2.1.24', mods: [] }), 202); // removes orrery
  const update = await h.answer();
  assert.deepEqual(update.mods, []);
  h.step(update.id, 'backup', 'done', 'Stopped: the newest save is world.zip');
  h.step(update.id, 'stop', 'waiting');
  assert.equal((await h.answer()).type, 'updateResume');
  h.step(update.id, 'swap', 'done');
  h.done(update.id, 'ok');
  await eventually(async () => (await h.game()).running === null);
  const row = (await h.game()).history[0]!;
  assert.deepEqual([row.outcome, row.from, row.to, row.changes], ['ok', '2.1.24 · 5 mods', '2.1.24 · 4 mods', ['Removed: orrery 0.1.0']]);
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
  assert.equal(h.restarts.pending('space'), undefined);
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
});

test('without FACTORIO_USERNAME and FACTORIO_TOKEN the hub runs, the catalog answers, and only an update with mods is refused, saying why', async (t) => {
  const h = await ready(t, {}, { account: false });
  assert.equal((await h.json<GameCatalog>(h.req('POST', '/api/servers/space/game/catalog', PICK))).mods.length, 3);
  const res = await h.req('POST', '/api/servers/space/game/update', PICK);
  assert.equal(res.status, 409);
  assert.equal(await res.text(), "FACTORIO_USERNAME and FACTORIO_TOKEN aren't set on the hub (/etc/orrery-factorio-account.env), so it can't get the mods' download links.");
  assert.equal((await h.game()).history.length, 0);
  // With no mods to fetch, no link is needed.
  await h.json(h.req('POST', '/api/servers/space/game/update', { factorio: '2.1.24', mods: [] }), 202);
  assert.deepEqual((await h.answer()).mods, []);
});

test('an Agent that says nothing about its update is given up, and told to cancel it', async (t) => {
  const h = await ready(t, {}, { quietMs: 100 });
  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  await h.answer(); // accepted, then silence
  assert.equal((await h.answer()).type, 'updateCancel');
  await eventually(async () => (await h.game()).history[0]?.outcome === 'failed in staging');
  assert.ok((await h.game()).history[0]!.log.includes('No word from the Agent for'));
});

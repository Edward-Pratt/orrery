// Game updates run through: the hub resolves, the Agent gets signed links, the hub stops the server and resumes the
// Agent; cancel before the swap and the countdown; an end during the hub's stop (`game-run.ts`, `game-stop.ts`).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuditLog, GameCatalog, ServerCard } from '../../src/api.ts';
import type { Notice } from '../../src/types.ts';
import { ACCOUNT, eventually, INSTALLED, PICK, ready, SHA256, sha, signed } from '../fake-agent.ts';

const kinds = (notices: Notice[]) => notices.filter((n) => n.kind !== 'packUpdateStep').map((n) => n.kind);
const webAudit = (log: AuditLog) => log.entries.filter((e) => e.actor.startsWith('web:') && e.action.startsWith('game')).map((e) => [e.action, e.details]);

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

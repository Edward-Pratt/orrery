// Pack updates' Stop, Cancel, rollback and interruption, and what they refuse alongside (`pack-update.ts`).

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ServerCard } from '../../src/api.ts';
import type { RunRestore } from '../../src/backups/restore.ts';
import { formatEvent } from '../../src/discord/format.ts';
import { sleep, until } from '../fake-mod.ts';
import { snapshot, URL_OLD, world, write } from './pack-world.ts';
import { start, updatable, withGithub } from './pack-hub.ts';

test('with players online the stop counts down; cancelling it, here or anywhere, ends the update as cancelled', async (t) => {
  for (const from of ['pack', 'restart']) {
    const { w, s } = await updatable(t);
    s.fake.players = ['Steve'];
    s.mod().send({ type: 'heartbeat', tps: 20, players: ['Steve'] });
    await sleep(20);
    const before = snapshot(w.dir);
    await s.json(s.req('POST', '/api/servers/gtnh/pack/update', await s.toNew()), 202);
    await until(() => s.events.some((e) => e.kind === 'packUpdateStep' && e.step === 'stop' && e.cancellable && e.detail.startsWith('1 player online: stopping in')), 5000);
    const card = (await s.json<ServerCard[]>(s.req('GET', '/api/servers')))[0]!;
    assert.equal(card.restart?.stop, true);
    assert.equal((await s.pack()).running!.cancellable, true);
    const cancel = from === 'pack' ? '/api/servers/gtnh/pack/update/cancel' : '/api/servers/gtnh/restart/cancel';
    assert.equal((await s.req('POST', cancel)).status, 204, from);
    const row = await s.finished();
    assert.equal(row.outcome, 'cancelled', from);
    assert.deepEqual(snapshot(w.dir), before, from); // the backup went to its folder, outside the server's
    assert.deepEqual(s.systemctl(), [], from);
    assert.equal(row.backup, '2026-10-02-12-00-00.zip');
    await s.close();
  }
});

test('an update is refused while a countdown runs on the server, as its blocked reason says', async (t) => {
  const { s } = await updatable(t);
  assert.equal((await s.req('POST', '/api/servers/gtnh/restart', { minutes: 5 })).status, 204);
  const res = await s.req('POST', '/api/servers/gtnh/pack/update', await s.toNew());
  assert.equal(res.status, 409);
  assert.equal(await res.text(), 'A countdown is running on GTNH: cancel it first.');
  assert.equal((await s.pack()).blocked, 'A countdown is running on GTNH: cancel it first.');
  assert.equal((await s.req('POST', '/api/servers/gtnh/restart/cancel')).status, 204);
  assert.equal((await s.pack()).blocked, null);
});

test('a stop that never ends fails the update before the swap: the folder is unchanged and the service started again', async (t) => {
  const { w, s } = await updatable(t, { stopMs: 200 });
  s.fake.stopHangs = true;
  const before = snapshot(w.dir);
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', await s.toNew()), 202);
  const row = await s.finished();
  assert.equal(row.outcome, 'failed before swap');
  assert.ok(row.log.includes("The service didn't stop within"), row.log);
  assert.deepEqual(snapshot(w.dir), before);
  assert.deepEqual(s.systemctl(), ['stop gtnh.service', 'start gtnh.service']);
  const finished = s.events.find((e) => e.kind === 'packUpdateFinished')!;
  assert.equal(finished.severity, 'problem');
  assert.match(JSON.stringify(formatEvent({ type: 'notice', serverId: 'gtnh', ...finished })), /failed after the stop, before any file changed: 2\.7\.4 is starting again/);
});

test('Cancel after the server was stopped is 409', async (t) => {
  const { s } = await updatable(t, { comesBack: () => false, gateMs: 3_000 });
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', await s.toNew()), 202);
  await until(() => s.events.some((e) => e.kind === 'packUpdateStep' && e.step === 'gate' && e.state === 'running'), 5000);
  assert.equal((await s.pack()).running!.cancellable, false);
  const res = await s.req('POST', '/api/servers/gtnh/pack/update/cancel');
  assert.equal(res.status, 409);
  assert.equal(await res.text(), 'Too late to cancel: only while preparing or during the countdown.');
  s.fake.comesBack = () => true;
  await s.finished();
});

test('no hello within the gate rolls back to exactly the old files, offering the pre-update backup until a restore', async (t) => {
  let restored = 0;
  const restore: RunRestore = async () => (restored++, 'Restored.');
  // The new files never say hello (the 1st start); the old ones do (the 2nd).
  const { w, s } = await updatable(t, { gateMs: 300, restore, comesBack: (n) => n === 2 });
  const before = snapshot(w.dir);
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', await s.toNew()), 202);
  const row = await s.finished();
  assert.equal(row.outcome, 'rolled back', row.log);
  assert.equal(row.backup, '2026-10-02-12-00-00.zip');
  const after = snapshot(w.dir);
  const pre = Object.keys(after).find((f) => f.startsWith('.pre-update-'))!.split('/')[0]!;
  for (const f of Object.keys(after)) if (f.startsWith(`${pre}/`)) delete after[f];
  assert.deepEqual(after, before);
  assert.equal(readFileSync(join(w.dir, pre, 'mods/old-only.jar'), 'utf8'), 'gone in 2.7.5'); // kept for recovery by hand
  assert.deepEqual(s.systemctl(), ['stop gtnh.service', 'start gtnh.service', 'stop gtnh.service', 'start gtnh.service']);
  const p = await s.pack();
  assert.deepEqual([p.installed!.version, p.installed!.source], ['2.7.4', URL_OLD]);
  assert.deepEqual(p.pending.map((x) => x.path), ['mods/bq.jar', 'config/custom.cfg', 'startserver.sh']); // still pending
  assert.deepEqual(p.rolledBack, { to: '2.7.5', backup: '2026-10-02-12-00-00.zip' });
  assert.deepEqual((await s.json<ServerCard[]>(s.req('GET', '/api/servers')))[0]!.packUpdate, { running: false, rolledBack: p.rolledBack });
  const finished = s.events.find((e) => e.kind === 'packUpdateFinished')!;
  assert.deepEqual({ ...finished, ms: 0 }, { severity: 'problem', kind: 'packUpdateFinished', outcome: 'rolled back', from: '2.7.4', to: '2.7.5', ms: 0, backup: '2026-10-02-12-00-00.zip' });
  // A restore ends the offer. (The rollback's last read of the unit saw it stopped.)
  s.state['gtnh.service'] = 'inactive';
  assert.equal((await s.req('POST', '/api/servers/gtnh/restore', { name: '2026-10-02-12-00-00.zip' })).status, 200);
  assert.equal(restored, 1);
  assert.equal((await s.pack()).rolledBack, null);
  assert.deepEqual((await s.json<ServerCard[]>(s.req('GET', '/api/servers')))[0]!.packUpdate, { running: false, rolledBack: null });
});

test('no hello after the rollback either ends as failed, leaving the .pre-update folder and naming it', async (t) => {
  const { w, s } = await updatable(t, { gateMs: 200, comesBack: () => false });
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', await s.toNew()), 202);
  const row = await s.finished();
  assert.equal(row.outcome, 'failed');
  const pre = readdirSync(w.dir).find((f) => f.startsWith('.pre-update-'))!;
  assert.ok(row.log.includes(`The old files are in ${pre}/`), row.log);
  assert.equal(readFileSync(join(w.dir, 'mods/old-only.jar'), 'utf8'), 'gone in 2.7.5'); // the old files are back all the same
  assert.equal(readFileSync(join(w.dir, pre, 'mods/old-only.jar'), 'utf8'), 'gone in 2.7.5');
  const finished = s.events.find((e) => e.kind === 'packUpdateFinished')!;
  assert.deepEqual([finished.severity, 'outcome' in finished && finished.outcome], ['problem', 'failed']);
  assert.equal((await s.pack()).rolledBack, null);
});

test('an update left running by the last hub is closed as interrupted, naming its step and the .pre-update folder', async (t) => {
  const w = world(t);
  let s = await start(t, w);
  await s.connect();
  await s.adopt();
  s.fake.comesBack = () => false;
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', await s.toNew()), 202);
  await until(() => s.events.some((e) => e.kind === 'packUpdateStep' && e.step === 'gate' && e.state === 'running'), 5000);
  await s.close(); // mid-gate, as a hub restart would
  const pre = readdirSync(w.dir).find((f) => f.startsWith('.pre-update-'))!;
  s = await start(t, w);
  const row = (await s.pack()).history[0]!;
  assert.equal(row.outcome, 'failed', row.log);
  assert.ok(row.log.endsWith(`interrupted during gate: the hub restarted. The old files are in ${pre}/`), row.log);
  assert.equal((await s.pack()).running, null);
});

test('a pack update and a restore refuse each other (GitHub off: no deploys to ask)', async (t) => {
  // A pack update holds a restore off.
  let gate!: () => void;
  const restore: RunRestore = () => new Promise((r) => (gate = () => r('Restored.')));
  const { w: first, s } = await updatable(t, { restore });
  write(first.backupDir, { '2026-10-02-12-00-00.zip': 'backup' });
  s.fake.backupGate = new Promise(() => {});
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', await s.toNew()), 202);
  const refused = await s.req('POST', '/api/servers/gtnh/restore', { name: '2026-10-02-12-00-00.zip' });
  assert.equal(refused.status, 409);
  assert.equal(await refused.text(), 'A pack update is running on GTNH: restore once it is done.');
  await s.close();

  // A restore holds a pack update off (and says so in the state).
  const w = world(t);
  write(w.backupDir, { '2026-10-01-06-00-00.zip': 'backup' });
  const r = await start(t, w, { restore, unit: 'inactive' });
  await r.adopt();
  const restoring = r.req('POST', '/api/servers/gtnh/restore', { name: '2026-10-01-06-00-00.zip' });
  await until(() => gate !== undefined);
  await sleep(20);
  assert.equal((await r.pack()).blocked, 'A restore is running on GTNH.');
  const update = await r.req('POST', '/api/servers/gtnh/pack/update', await r.toNew());
  assert.equal(update.status, 409);
  assert.equal(await update.text(), 'A restore is running on GTNH.');
  gate();
  assert.equal((await restoring).status, 200);
});

test('a pack update and a Mod deploy onto the same server refuse each other', async (t) => {
  const { s } = await withGithub(t);
  s.fake.backupGate = new Promise(() => {});
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', await s.toNew()), 202);
  assert.deepEqual((await s.json<{ packing: string[] }>(s.req('GET', '/api/deploys'))).packing, ['gtnh']);
  const deploy = await s.req('POST', '/api/deploys', { part: 'mod', tag: 'mod-v1.5.0', server: 'gtnh' });
  assert.equal(deploy.status, 409);
  assert.equal(await deploy.text(), 'A pack update is running on GTNH: deploy the Mod once it is done.');
  await s.close();

  const other = await withGithub(t);
  assert.equal((await other.s.req('POST', '/api/deploys', { part: 'mod', tag: 'mod-v1.5.0', server: 'gtnh' })).status, 202); // counts down
  assert.equal((await other.s.pack()).blocked, 'A Mod deploy onto GTNH is running.');
  const update = await other.s.req('POST', '/api/servers/gtnh/pack/update', await other.s.toNew());
  assert.equal(update.status, 409);
  assert.equal(await update.text(), 'A Mod deploy onto GTNH is running.');
});

test('a pack update and a hub deploy refuse each other', async (t) => {
  const { s } = await withGithub(t);
  s.fake.backupGate = new Promise(() => {});
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', await s.toNew()), 202);
  const deploy = await s.req('POST', '/api/deploys', { part: 'hub', tag: 'hub-v2.7.0' });
  assert.equal(deploy.status, 409);
  assert.equal(await deploy.text(), 'A pack update is running: deploy the hub once it is done.');
  await s.close();

  const other = await withGithub(t);
  assert.equal((await other.s.req('POST', '/api/deploys', { part: 'hub', tag: 'hub-v2.7.0' })).status, 202);
  const update = await other.s.req('POST', '/api/servers/gtnh/pack/update', await other.s.toNew());
  assert.equal(update.status, 409);
  assert.equal(await update.text(), 'A hub deploy is running.');
});

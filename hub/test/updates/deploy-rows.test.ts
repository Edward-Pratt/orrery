// The hub's and the dashboard's deploys (`deploy-rows.ts`): a row, the database copy, the audit and the notices, the
// unit started, and the row closed from the status file by the watch (also by the next hub), rolled back,
// interrupted, or failed when systemctl fails.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ACTOR } from '../web/web-hub.ts';
import { until } from '../fake-mod.ts';
import { DAY, rows, start, status, world } from './deploys-world.ts';

test('a hub deploy records a running row, copies the database, audits, announces, and starts exactly its unit', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  const res = await s.deploy({ part: 'hub', tag: 'hub-v2.7.0' });
  assert.equal(res.status, 202);
  assert.deepEqual(w.systemd.starts(), ['orrery-deploy@hub-v2.7.0.service']);
  assert.deepEqual(await rows(s), [{ part: 'hub', target: 'production', from: 'dev', to: 'hub-v2.7.0', by: ACTOR, outcome: 'running', log: '' }]);
  assert.ok(readdirSync(join(w.root, 'db-backups')).some((f) => f.startsWith('hub-before-hub-v2.7.0-')));
  assert.deepEqual(await s.audit(), [{ actor: ACTOR, target: 'production', details: 'hub dev → hub-v2.7.0' }]);
  assert.deepEqual(s.notices, [
    { target: 'deploy', id: 'production', type: 'notice', severity: 'info', kind: 'deployStarted', part: 'hub', from: 'dev', to: 'hub-v2.7.0', by: ACTOR },
  ]);
  // One at a time.
  assert.equal((await s.deploy({ part: 'web', tag: 'web-v0.5.0' })).status, 409);
});

test('the hub started by a deploy closes its row from the status file once the unit is done', async (t) => {
  const w = world(t);
  const first = await start(t, w);
  await first.deploy({ part: 'hub', tag: 'hub-v2.7.0' });
  await first.close();
  // The new hub comes up during the gate: the unit still runs, and an old status file isn't this deploy's.
  status(w, { tag: 'hub-v2.7.0', from: 'dev', outcome: 'rolled back', finished: new Date(Date.now() - DAY).toISOString(), log: 'old' });
  const s = await start(t, w);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await rows(s))[0]!.outcome, 'running');
  status(w, { tag: 'hub-v2.7.0', from: 'dev', outcome: 'ok', finished: new Date().toISOString(), log: 'cloned\nflipped\nstayed up' });
  w.systemd.states['orrery-deploy@hub-v2.7.0.service'] = 'inactive';
  await until(() => s.notices.length > 0);
  assert.deepEqual((await rows(s))[0], { part: 'hub', target: 'production', from: 'dev', to: 'hub-v2.7.0', by: ACTOR, outcome: 'ok', log: 'cloned\nflipped\nstayed up' });
  assert.deepEqual(s.notices, [
    { target: 'deploy', id: 'production', type: 'notice', severity: 'good', kind: 'deployFinished', part: 'hub', from: 'dev', to: 'hub-v2.7.0', outcome: 'ok' },
  ]);
});

test('a hub deploy that rolled back keeps its log; one that left no status is closed as interrupted', async (t) => {
  const w = world(t);
  const first = await start(t, w);
  await first.deploy({ part: 'hub', tag: 'hub-v2.7.0' });
  w.systemd.states['orrery-deploy@hub-v2.7.0.service'] = 'failed';
  status(w, { tag: 'hub-v2.7.0', from: 'dev', outcome: 'rolled back', finished: new Date().toISOString(), log: 'MainPID changed' });
  await until(() => first.notices.length === 2);
  assert.equal(first.notices[1]!.type === 'notice' && first.notices[1]!.severity, 'problem');
  assert.deepEqual((await rows(first))[0]!.log, 'MainPID changed');

  rmSync(join(w.root, 'deploy-status.json'));
  await first.deploy({ part: 'hub', tag: 'hub-v2.6.0' });
  await first.close();
  w.systemd.states['orrery-deploy@hub-v2.6.0.service'] = 'inactive'; // the host rebooted mid-way
  const s = await start(t, w); // closed while it started, before this test listened for notices
  assert.deepEqual((await rows(s)).map((r) => [r.to, r.outcome, r.log]), [
    ['hub-v2.6.0', 'failed', 'interrupted: the deploy unit ended without reporting'],
    ['hub-v2.7.0', 'rolled back', 'MainPID changed'],
  ]);
});

test('a dashboard deploy starts its unit and closes its row, targeting production, when the unit is done', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  assert.equal((await s.deploy({ part: 'web', tag: 'web-v0.5.0' })).status, 202);
  assert.deepEqual(w.systemd.starts(), ['orrery-deploy-web@web-v0.5.0.service']);
  assert.ok(!existsSync(join(w.root, 'db-backups'))); // only a hub deploy copies the database
  status(w, { tag: 'web-v0.5.0', from: null, outcome: 'ok', finished: new Date().toISOString(), log: 'installed' });
  w.systemd.states['orrery-deploy-web@web-v0.5.0.service'] = 'inactive';
  await until(() => s.notices.length === 2);
  const a = await s.get();
  assert.equal(a.web.running, 'web-v0.5.0');
  assert.deepEqual((await rows(s))[0], { part: 'web', target: 'production', from: null, to: 'web-v0.5.0', by: ACTOR, outcome: 'ok', log: 'installed' });
});

test('a deploy whose systemctl fails answers 502 and closes its row failed', async (t) => {
  const w = world(t);
  const run = w.systemd.run;
  w.systemd.run = async (command, args) => (args[0] === 'start' ? Promise.reject(new Error('Access denied')) : run(command, args));
  const s = await start(t, w);
  const res = await s.deploy({ part: 'web', tag: 'web-v0.5.0' });
  assert.deepEqual([res.status, await res.text()], [502, 'The deploy failed: Access denied']);
  assert.deepEqual((await rows(s)).map((r) => [r.outcome, r.log]), [['failed', 'systemctl failed: Access denied']]);
});

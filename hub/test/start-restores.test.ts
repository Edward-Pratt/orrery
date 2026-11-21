// Restores from the dashboard (`restoreHub`: `gtnh` with a folder and one backup, run as the service `gtnh` or not
// linked, with a fake restore script), which also gives a card its linked service: the script run with the service
// stopped, its output answered and audited; refused while the service runs, for an unknown server, without a link, for
// an unlisted backup and while one runs; a failing script answers 502.

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AuditLog, CommandOutput } from '../src/api.ts';
import type { RestoreEnv, RunRestore } from '../src/backups/restore.ts';
import { startHub } from '../src/start.ts';
import { until } from './fake-mod.ts';
import { ACTOR, config, loginCookie, WEB } from './web/web-hub.ts';
import { MINECRAFT, cardsOf, post, webAudit, UNITS, fakeSystemd } from './start-hub.ts';

const BACKUP = '2026-09-26-06-00-00.zip';

/**
 * A Minecraft + web hub whose server `gtnh` (folder, one backup) runs as the service `gtnh` (unless `linked` is
 * false), with a fake restore script: `runs` has each call, `fake.fails` makes it fail, `fake.gate` holds it.
 * `stopService` stops `gtnh.service` and waits until the hub has read that.
 */
async function restoreHub(t: TestContext, linked = true) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cfg = config(t, { minecraft: MINECRAFT, web: WEB, systemd: UNITS });
  delete cfg.healthcheckUrl;
  const dir = join(dirname(cfg.dbPath), 'gtnh');
  const backupDir = join(dir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, BACKUP), 'zip');
  cfg.servers = [{ ...cfg.servers[0]!, dir, backupDir, ...(linked && { service: 'gtnh' }) }];
  const systemd = fakeSystemd();
  const runs: [string, RestoreEnv][] = [];
  const fake = { fails: false, gate: Promise.resolve() };
  const restore: RunRestore = async (name, env) => {
    runs.push([name, env]);
    await fake.gate;
    if (fake.fails) throw new Error("restore-backup: can't read 2026-09-26-06-00-00.zip (corrupt?)");
    return `Restored ${name} into ${dir}/World.\nNext: sudo systemctl start gtnh.service, then join and check the world.\n`;
  };
  const handle = await startHub(cfg, {
    startFrontend: () => assert.fail('Discord is off'),
    get: () => assert.fail('nothing to request'),
    run: systemd.run,
    restore,
  });
  t.after(() => handle.close());
  const shows = () => systemd.calls.length;
  await until(() => shows() === 2);
  const stopService = async () => {
    systemd.states['gtnh.service'] = ['inactive', 'dead'];
    const n = shows() + 2;
    t.mock.timers.tick(5_000);
    await until(() => shows() === n);
    await new Promise((r) => setImmediate(r));
  };
  const app = handle.web!.app;
  const cookie = await loginCookie(handle.web!);
  const restoreOf = (name: unknown, server = 'gtnh') => post(app, cookie, `/api/servers/${server}/restore`, { name });
  const audit = async () =>
    webAudit((await (await app.request('/api/audit', { headers: { cookie } })).json()) as AuditLog).filter((e) => e.action === 'restore');
  return { runs, fake, stopService, restoreOf, audit, dir, backupDir, cards: () => cardsOf(app, cookie) };
}

test("a card carries its linked service's id and state", async (t) => {
  const { cards, stopService } = await restoreHub(t);
  assert.deepEqual((await cards())[0]!.service, { id: 'gtnh', state: 'active' });
  await stopService();
  assert.deepEqual((await cards())[0]!.service, { id: 'gtnh', state: 'inactive' });
});

test('a card has no service without a link', async (t) => {
  assert.equal((await (await restoreHub(t, false)).cards())[0]!.service, null);
});

test('a restore with the linked service stopped runs the script with its settings, answers its output and is audited', async (t) => {
  const { runs, stopService, restoreOf, audit, dir, backupDir } = await restoreHub(t);
  await stopService();
  const res = await restoreOf(BACKUP);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    output: [`Restored ${BACKUP} into ${dir}/World.`, 'Next: sudo systemctl start gtnh.service, then join and check the world.'],
  } satisfies CommandOutput);
  assert.deepEqual(runs, [[BACKUP, { GTNH_DIR: dir, BACKUP_DIR: backupDir, GTNH_SERVICE: 'gtnh.service' }]]);
  assert.deepEqual(await audit(), [{ actor: ACTOR, action: 'restore', target: 'gtnh', details: `${BACKUP}: done` }]);
});

test('a restore is refused while the service runs, and for an unknown server', async (t) => {
  const { runs, restoreOf, audit } = await restoreHub(t);
  const running = await restoreOf(BACKUP);
  assert.equal(running.status, 409);
  assert.equal(await running.text(), 'gtnh.service is active: stop it first.');
  assert.equal((await restoreOf(BACKUP, 'nope')).status, 404);
  assert.deepEqual(runs, []);
  assert.deepEqual(await audit(), [{ actor: ACTOR, action: 'restore', target: 'gtnh', details: `${BACKUP}: refused: gtnh.service is active: stop it first.` }]);
});

test('a server without a linked service is never restored from the dashboard', async (t) => {
  const unlinked = await restoreHub(t, false);
  const res = await unlinked.restoreOf(BACKUP);
  assert.equal(res.status, 409);
  assert.match(await res.text(), /no linked service/);
  assert.deepEqual(unlinked.runs, []);
});

test('only a listed backup is ever passed to the script', async (t) => {
  const { runs, stopService, restoreOf } = await restoreHub(t);
  await stopService();
  for (const name of ['../x.zip', `../backups/${BACKUP}`, '2026-09-25-06-00-00.zip', 'latest', '']) {
    assert.equal((await restoreOf(name)).status, 404, name);
  }
  for (const name of [undefined, 42, [BACKUP]]) assert.equal((await restoreOf(name)).status, 400, String(name));
  assert.deepEqual(runs, []);
});

test('a failing restore answers 502 with its error output and is audited', async (t) => {
  const { fake, stopService, restoreOf, audit } = await restoreHub(t);
  await stopService();
  fake.fails = true;
  const res = await restoreOf(BACKUP);
  assert.equal(res.status, 502);
  assert.equal(await res.text(), "The restore failed: restore-backup: can't read 2026-09-26-06-00-00.zip (corrupt?)");
  assert.deepEqual(await audit(), [
    { actor: ACTOR, action: 'restore', target: 'gtnh', details: `${BACKUP}: failed: restore-backup: can't read 2026-09-26-06-00-00.zip (corrupt?)` },
  ]);
});

test('a second restore while one runs is refused', async (t) => {
  const { runs, fake, stopService, restoreOf } = await restoreHub(t);
  await stopService();
  let release!: () => void;
  fake.gate = new Promise((r) => (release = r));
  const first = restoreOf(BACKUP);
  await until(() => runs.length === 1);
  const second = await restoreOf(BACKUP);
  assert.equal(second.status, 409);
  assert.equal(await second.text(), 'A restore is already running on GTNH.');
  release();
  assert.equal((await first).status, 200);
  assert.equal(runs.length, 1);
});

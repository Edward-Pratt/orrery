import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { backupStats, BackupWatcher, freeBytes, growthPerDay, listBackups, type Backup } from '../../src/backups/backups.ts';
import { Db } from '../../src/stats/db.ts';
import type { HubEvent, Notice, ServerHub } from '../../src/servers/servers.ts';

const MIN = 60_000;
const GB = 1024 ** 3;
const flush = () => new Promise((r) => setImmediate(r)); // lets the injected list() promise settle

test('listBackups finds finished zips newest first and skips everything else', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'backups-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = async (name: string, mtimeSec: number, bytes = 10) => {
    await writeFile(join(dir, name), 'x'.repeat(bytes));
    await utimes(join(dir, name), mtimeSec, mtimeSec);
  };
  await file('2026-09-23-06-00-00.zip', 1000, 100);
  await file('2026-09-24-06-00-00.zip', 2000, 200);
  await file('.su-save-123.tmp', 3000); // staging
  await file('notes.txt', 3000);
  await mkdir(join(dir, '2026-09-25-06-00-00.zip')); // a folder, not a backup
  await symlink(join(dir, 'notes.txt'), join(dir, '2026-09-26-06-00-00.zip'));
  assert.deepEqual(
    (await listBackups(dir)).map((b) => [b.name, b.size]),
    [
      ['2026-09-24-06-00-00.zip', 200],
      ['2026-09-23-06-00-00.zip', 100],
    ],
  );
  assert.deepEqual(await listBackups(join(dir, 'missing')), []);
});

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000_000_000 });
  let backups: Backup[] = [];
  let free: number | null = 100 * GB;
  const notices: (Notice & { serverId: string })[] = [];
  const events = new EventEmitter<{ event: [HubEvent] }>();
  const hub = {
    on: (name: 'event', fn: (e: HubEvent) => void) => events.on(name, fn),
    publish: (serverId: string, n: Notice) => notices.push({ ...n, serverId }),
  } as unknown as Pick<ServerHub, 'on' | 'publish'>;
  const watcher = new BackupWatcher(
    hub,
    async () => backups,
    async () => free,
  );
  t.after(() => watcher.stop());
  return { watcher, events, notices, set: (b: Backup[]) => (backups = b), setFree: (f: number | null) => (free = f) };
}

test("the mod's backup events become finished / failed notices", (t) => {
  const { events, notices } = setup(t);
  events.emit('event', { serverId: 'gtnh', type: 'backup', ok: true, detail: '12.3 seconds (1.2GB)' });
  events.emit('event', { serverId: 'gtnh', type: 'backup', ok: false, detail: 'disk full' });
  events.emit('event', { serverId: 'gtnh', type: 'started' }); // not a backup: ignored
  assert.deepEqual(notices, [
    { severity: 'good', kind: 'backupFinished', detail: '12.3 seconds (1.2GB)', serverId: 'gtnh' },
    { severity: 'problem', kind: 'backupFailed', detail: 'disk full', serverId: 'gtnh' },
  ]);
});

test('the watchdog warns once when backups are overdue and re-arms after a new one', async (t) => {
  const { watcher, notices, set } = setup(t);
  set([{ name: 'a.zip', size: 1, mtimeMs: Date.now() - 30 * 60 * MIN }]); // 30 h old
  watcher.watchdog('gtnh', { maxAgeHours: 26, minFreeGB: 10 });
  t.mock.timers.tick(10 * MIN);
  await flush();
  t.mock.timers.tick(10 * MIN);
  await flush();
  assert.deepEqual(notices, [{ severity: 'warning', kind: 'backupOverdue', hours: 30, newest: 'a.zip', serverId: 'gtnh' }]);
  set([{ name: 'b.zip', size: 1, mtimeMs: Date.now() }]);
  t.mock.timers.tick(10 * MIN);
  await flush();
  set([{ name: 'b.zip', size: 1, mtimeMs: Date.now() - 27 * 60 * MIN }]);
  t.mock.timers.tick(10 * MIN);
  await flush();
  assert.equal(notices.length, 2);
  assert.deepEqual(notices[1], { severity: 'warning', kind: 'backupOverdue', hours: 27, newest: 'b.zip', serverId: 'gtnh' });
});

test('the watchdog says so when there are no backups at all', async (t) => {
  const { watcher, notices } = setup(t);
  watcher.watchdog('gtnh', { maxAgeHours: 26, minFreeGB: 10 });
  t.mock.timers.tick(10 * MIN);
  await flush();
  assert.deepEqual(notices, [{ severity: 'warning', kind: 'backupsMissing', serverId: 'gtnh' }]);
});

/** An Agent's server: its watchdog asks the database whether anyone played since its newest save, as the hub's does. */
function agentSetup(t: TestContext) {
  const w = setup(t);
  const db = new Db(':memory:');
  t.after(() => db.close());
  w.watcher.watchdog('space', { maxAgeHours: 12, minFreeGB: 10, played: (since) => db.sessionsSince('space', since).length > 0 });
  const tick = async (minutes: number) => {
    for (let m = 0; m < minutes; m += 10) {
      t.mock.timers.tick(10 * MIN);
      await flush();
    }
  };
  return { ...w, db, tick };
}

test("an Agent's server with nobody playing stays quiet after 24 h, its newest save that old", async (t) => {
  const { notices, set, db, tick } = agentSetup(t);
  const saved = Date.now();
  set([{ name: 'orrery-2026-10-31T06-00-00Z.zip', size: 1, mtimeMs: saved, kind: 'named', current: false }]);
  db.openSession('space', 'Ann', saved - 2 * 60 * MIN); // played before the save, and left before it
  db.closeSession('space', 'Ann', saved - 60 * MIN);
  await tick(24 * 60);
  assert.deepEqual(notices, []);
});

test("an Agent's server whose saves are stale after someone played warns once, and re-arms after a new save", async (t) => {
  const { notices, set, db, tick } = agentSetup(t);
  const saved = Date.now();
  set([{ name: 'orrery-a.zip', size: 1, mtimeMs: saved, kind: 'named', current: false }]);
  await tick(10 * 60);
  db.openSession('space', 'Ann', Date.now()); // 10 h after the save: from now on one is due
  await tick(3 * 60);
  assert.deepEqual(notices, [{ severity: 'warning', kind: 'backupOverdue', hours: 12, newest: 'orrery-a.zip', serverId: 'space' }]);
  db.closeSession('space', 'Ann', Date.now());
  set([{ name: 'orrery-b.zip', size: 1, mtimeMs: Date.now(), kind: 'named', current: false }]); // saved after the play
  await tick(24 * 60); // nobody since: quiet again, however old
  db.openSession('space', 'Bo', Date.now());
  await tick(10);
  assert.deepEqual(notices.slice(1), [{ severity: 'warning', kind: 'backupOverdue', hours: 24, newest: 'orrery-b.zip', serverId: 'space' }]);
});

test("an Agent's server with no save known yet is not said to have none", async (t) => {
  const { notices, db, tick } = agentSetup(t);
  db.openSession('space', 'Ann', Date.now() - 60 * MIN);
  await tick(60);
  assert.deepEqual(notices, []);
});

test('growthPerDay compares the newest backup with the oldest, if a day or more apart', () => {
  const b = (size: number, hoursAgo: number) => ({ name: 'x.zip', size, mtimeMs: 1e12 - hoursAgo * 3600_000 });
  assert.equal(growthPerDay([b(3 * GB, 0), b(2 * GB, 24), b(1 * GB, 48)]), GB);
  assert.equal(growthPerDay([b(1 * GB, 0), b(2 * GB, 48)]), -GB / 2);
  assert.equal(growthPerDay([b(3 * GB, 0), b(1 * GB, 23)]), null);
  assert.equal(growthPerDay([]), null);
});

test('freeBytes and backupStats read the real folder, never throw, and give no stats without one', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'backups-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, '2026-09-24-06-00-00.zip'), 'x'.repeat(10));
  assert.ok(((await freeBytes(dir)) ?? 0) > 0);
  assert.equal(await freeBytes(join(dir, 'missing')), null);
  const stats = await backupStats(dir);
  assert.deepEqual({ ...stats, free: stats?.free !== null }, { count: 1, total: 10, free: true, growth: null });
  assert.equal(await backupStats(join(dir, 'missing')), null); // e.g. the default <dir>/backups before any backup
});

test('the watchdog warns once about low disk space and re-arms when there is room again', async (t) => {
  const { watcher, notices, setFree } = setup(t);
  setFree(5 * GB);
  watcher.watchdog('gtnh', { minFreeGB: 10 }); // no age limit
  const tick = async () => {
    t.mock.timers.tick(10 * MIN);
    await flush();
  };
  await tick();
  await tick();
  assert.deepEqual(notices, [{ severity: 'warning', kind: 'lowDisk', free: 5 * GB, minFreeGB: 10, serverId: 'gtnh' }]);
  setFree(20 * GB);
  await tick();
  setFree(null); // unreadable: no notice, no re-arm
  await tick();
  setFree(4 * GB);
  await tick();
  assert.equal(notices.length, 2);
  assert.equal(notices[1].kind === 'lowDisk' && notices[1].free, 4 * GB);
});

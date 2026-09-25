import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { backupNotice, backupStats, BackupWatcher, freeBytes, growthPerDay, listBackups, type Backup } from '../src/backups.ts';

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
  const notices: string[] = [];
  const watcher = new BackupWatcher(
    async () => backups,
    async () => free,
    (_id, text) => notices.push(text),
  );
  t.after(() => watcher.stop());
  return { watcher, notices, set: (b: Backup[]) => (backups = b), setFree: (f: number | null) => (free = f) };
}

test('backupNotice turns mod backup events into notices', () => {
  assert.equal(backupNotice(true, '12.3 seconds (1.2GB)'), '✅ Backup finished (12.3 seconds (1.2GB))');
  assert.equal(backupNotice(false, 'disk full'), '❌ Backup failed: disk full');
});

test('the watchdog warns once when backups are overdue and re-arms after a new one', async (t) => {
  const { watcher, notices, set } = setup(t);
  set([{ name: 'a.zip', size: 1, mtimeMs: Date.now() - 30 * 60 * MIN }]); // 30 h old
  watcher.watchdog('gtnh', { maxAgeHours: 26, minFreeGB: 10 });
  t.mock.timers.tick(10 * MIN);
  await flush();
  t.mock.timers.tick(10 * MIN);
  await flush();
  assert.deepEqual(notices, ['⚠️ No new backup for 30 h (newest: a.zip)']);
  set([{ name: 'b.zip', size: 1, mtimeMs: Date.now() }]);
  t.mock.timers.tick(10 * MIN);
  await flush();
  set([{ name: 'b.zip', size: 1, mtimeMs: Date.now() - 27 * 60 * MIN }]);
  t.mock.timers.tick(10 * MIN);
  await flush();
  assert.equal(notices.length, 2);
  assert.match(notices[1], /No new backup for 27 h/);
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
  assert.deepEqual(notices, ['⚠️ Low disk space for backups: 5.0 GB free (limit 10 GB)']);
  setFree(20 * GB);
  await tick();
  setFree(null); // unreadable: no notice, no re-arm
  await tick();
  setFree(4 * GB);
  await tick();
  assert.equal(notices.length, 2);
  assert.match(notices[1], /4\.0 GB free/);
});

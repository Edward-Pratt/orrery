import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { BackupWatcher, listBackups, type Backup } from '../src/backups.ts';

const MIN = 60_000;
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
  const notices: string[] = [];
  const watcher = new BackupWatcher(
    async () => backups,
    (_id, text) => notices.push(text),
  );
  t.after(() => watcher.stop());
  return { watcher, notices, set: (b: Backup[]) => (backups = b) };
}

test('watch reports the first backup that appears after the start', async (t) => {
  const { watcher, notices, set } = setup(t);
  const since = Date.now();
  set([{ name: 'old.zip', size: 1, mtimeMs: since - MIN }]);
  assert.equal(watcher.watch('gtnh', since), true);
  assert.equal(watcher.watch('gtnh', since), false); // one watch per server
  t.mock.timers.tick(10_000);
  await flush();
  assert.deepEqual(notices, []);
  set([{ name: '2026-09-24-06-00-00.zip', size: 3 * 1024 ** 3, mtimeMs: since + 192_000 }]);
  t.mock.timers.tick(10_000);
  await flush();
  assert.deepEqual(notices, ['✅ Backup finished: 2026-09-24-06-00-00.zip (3.0 GB, 3 m 12 s)']);
  assert.equal(watcher.watch('gtnh', Date.now()), true); // free again
});

test('watch gives up after 60 minutes', async (t) => {
  const { watcher, notices } = setup(t);
  watcher.watch('gtnh', Date.now());
  for (let i = 0; i < 6 * 60; i++) {
    t.mock.timers.tick(10_000);
    await flush();
  }
  assert.deepEqual(notices, ['⚠️ No finished backup appeared within 60 minutes']);
});

test('the watchdog warns once when backups are overdue and re-arms after a new one', async (t) => {
  const { watcher, notices, set } = setup(t);
  set([{ name: 'a.zip', size: 1, mtimeMs: Date.now() - 30 * 60 * MIN }]); // 30 h old
  watcher.watchdog('gtnh', 26);
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

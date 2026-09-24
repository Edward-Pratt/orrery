import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findCrashLogs } from '../src/crashlogs.ts';

async function file(path: string, mtimeSec: number, bytes = 10): Promise<void> {
  await writeFile(path, 'x'.repeat(bytes));
  await utimes(path, mtimeSec, mtimeSec);
}

test('finds the newest crash report and JVM log written since the cutoff', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crashlogs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'crash-reports'));
  await file(join(dir, 'crash-reports', 'crash-old-server.txt'), 1000);
  await file(join(dir, 'crash-reports', 'crash-new-server.txt'), 3000);
  await file(join(dir, 'crash-reports', 'notes.md'), 4000); // wrong extension
  await file(join(dir, 'hs_err_pid111.log'), 1000);
  await file(join(dir, 'hs_err_pid222.log'), 3500);
  await file(join(dir, 'hs_err_pid333.txt'), 4000); // wrong name
  assert.deepEqual(await findCrashLogs(dir, 2000 * 1000), [
    join(dir, 'crash-reports', 'crash-new-server.txt'),
    join(dir, 'hs_err_pid222.log'),
  ]);
});

test('ignores files older than the cutoff or too big to upload', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crashlogs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'crash-reports'));
  await file(join(dir, 'crash-reports', 'crash-old.txt'), 1000);
  await file(join(dir, 'hs_err_pid1.log'), 5000, 9 * 1024 * 1024);
  assert.deepEqual(await findCrashLogs(dir, 2000 * 1000), []);
});

test('a missing folder yields no files instead of an error', async () => {
  assert.deepEqual(await findCrashLogs(join(tmpdir(), 'does-not-exist-' + Date.now()), 0), []);
});

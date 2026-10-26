import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { listLogs, tailLog, TAIL_LINES } from '../src/logs.ts';

async function folder(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'logs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'logs'));
  await mkdir(join(dir, 'crash-reports'));
  return dir;
}

async function file(path: string, mtimeSec: number, content: string | Buffer = 'x'): Promise<void> {
  await writeFile(path, content);
  await utimes(path, mtimeSec, mtimeSec);
}

/** `n` numbered lines of about 100 bytes each, every one ending in a newline. */
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1} ${'.'.repeat(90)}`);

test('lists logs and crash reports with sizes and times, newest first, and nothing else', async (t) => {
  const dir = await folder(t);
  await file(join(dir, 'logs', 'latest.log'), 5000, 'hello\n');
  await file(join(dir, 'logs', '2026-10-01-1.log.gz'), 2000, gzipSync('old\n'));
  await file(join(dir, 'logs', 'notes.txt'), 6000); // not a log
  await mkdir(join(dir, 'logs', 'nested.log')); // a folder, not a file
  await file(join(dir, 'crash-reports', 'crash-2026-10-02-server.txt'), 3000, 'crash');
  await file(join(dir, 'crash-reports', 'readme.md'), 6000);
  await file(join(dir, 'hs_err_pid42.log'), 4000, 'jvm');
  await file(join(dir, 'server.properties'), 6000);
  await file(join(dir, 'config.json'), 6000);
  const logs = await listLogs(dir);
  assert.deepEqual(logs.map((l) => [l.name, l.size, l.modified]), [
    ['latest.log', 6, 5000 * 1000],
    ['hs_err_pid42.log', 3, 4000 * 1000],
    ['crash-2026-10-02-server.txt', 5, 3000 * 1000],
    ['2026-10-01-1.log.gz', gzipSync('old\n').length, 2000 * 1000],
  ]);
});

test('a folder without logs lists nothing instead of failing', async () => {
  assert.deepEqual(await listLogs(join(tmpdir(), 'does-not-exist-' + Date.now())), []);
});

test("a symlink out of logs/ is neither listed nor read", async (t) => {
  const dir = await folder(t);
  await file(join(dir, 'config.json'), 3000, '{"token":"secret"}');
  await symlink(join(dir, 'config.json'), join(dir, 'logs', 'evil.log'));
  await symlink('../config.json', join(dir, 'crash-reports', 'crash-evil.txt'));
  assert.deepEqual(await listLogs(dir), []);
  assert.equal(await tailLog(dir, 'evil.log'), undefined);
  assert.equal(await tailLog(dir, 'crash-evil.txt'), undefined);
});

test('only a listed name is read: paths, unlisted files and empty names are undefined', async (t) => {
  const dir = await folder(t);
  await file(join(dir, 'logs', 'latest.log'), 3000, 'hello\n');
  await file(join(dir, 'config.json'), 3000, '{"token":"secret"}');
  for (const name of ['../config.json', 'config.json', 'logs/latest.log', '/etc/passwd', '..', '', 'latest.log/']) {
    assert.equal(await tailLog(dir, name), undefined, name);
  }
  assert.deepEqual(await tailLog(dir, 'latest.log'), ['hello']);
});

test(`a plain log's tail is its last ${TAIL_LINES} lines, oldest first`, async (t) => {
  const dir = await folder(t);
  const lines = numbered(1500);
  await file(join(dir, 'logs', 'latest.log'), 3000, lines.join('\n') + '\n');
  assert.deepEqual(await tailLog(dir, 'latest.log'), lines.slice(-TAIL_LINES));
});

test('a short log gives all its lines; no final newline and CRLF are fine; an empty one gives none', async (t) => {
  const dir = await folder(t);
  await file(join(dir, 'logs', 'short.log'), 3000, 'one\r\ntwo\r\nthree');
  await file(join(dir, 'logs', 'empty.log'), 3000, '');
  await file(join(dir, 'hs_err_pid7.log'), 3000, numbered(3).join('\n') + '\n');
  assert.deepEqual(await tailLog(dir, 'short.log'), ['one', 'two', 'three']);
  assert.deepEqual(await tailLog(dir, 'empty.log'), []);
  assert.deepEqual(await tailLog(dir, 'hs_err_pid7.log'), numbered(3));
});

test(`a .gz log is decompressed, giving its last ${TAIL_LINES} lines, or fewer`, async (t) => {
  const dir = await folder(t);
  const lines = numbered(2500);
  await file(join(dir, 'logs', '2026-10-01-1.log.gz'), 3000, gzipSync(lines.join('\n') + '\n'));
  await file(join(dir, 'logs', '2026-10-01-2.log.gz'), 3000, gzipSync('a\nb\n'));
  assert.deepEqual(await tailLog(dir, '2026-10-01-1.log.gz'), lines.slice(-TAIL_LINES));
  assert.deepEqual(await tailLog(dir, '2026-10-01-2.log.gz'), ['a', 'b']);
});

test('a broken .gz rejects', async (t) => {
  const dir = await folder(t);
  await file(join(dir, 'logs', 'broken.log.gz'), 3000, 'not gzip at all');
  await assert.rejects(tailLog(dir, 'broken.log.gz'));
});

test('a file with one line longer than the tail window gives no cut-off line', async (t) => {
  const dir = await folder(t);
  await file(join(dir, 'logs', 'huge.log'), 3000, 'x'.repeat(5 * 1024 * 1024) + '\nlast\n');
  assert.deepEqual(await tailLog(dir, 'huge.log'), ['last']);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { execRestore } from '../src/restore.ts';

const hasZip = ['zip', 'unzip'].every((cmd) => {
  try {
    execFileSync('which', [cmd], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});

/** A server folder with a World and one backup, and a systemctl stub on PATH answering `state`. */
function fixture(t: TestContext, state: string) {
  const root = mkdtempSync(join(tmpdir(), 'restore-'));
  const dir = join(root, 'server');
  const backupDir = join(dir, 'backups');
  mkdirSync(join(dir, 'World'), { recursive: true });
  mkdirSync(backupDir);
  writeFileSync(join(dir, 'World', 'level.dat'), 'old');
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'systemctl'), `#!/usr/bin/env bash\necho ${state}\n`);
  chmodSync(join(root, 'bin', 'systemctl'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${join(root, 'bin')}:${path}`;
  t.after(() => {
    process.env.PATH = path;
    rmSync(root, { recursive: true, force: true });
  });
  return { root, dir, env: { GTNH_DIR: dir, BACKUP_DIR: backupDir, GTNH_SERVICE: 'gtnh.service' } };
}

test('the real script answers its own prompt and restores; the old world is kept', { skip: !hasZip && 'needs zip and unzip' }, async (t) => {
  const { root, dir, env } = fixture(t, 'inactive');
  mkdirSync(join(root, 'new'));
  writeFileSync(join(root, 'new', 'level.dat'), 'new');
  execFileSync('zip', ['-qr', join(env.BACKUP_DIR, '2026-09-26-06-00-00.zip'), '.'], { cwd: join(root, 'new') });
  const out = await execRestore('2026-09-26-06-00-00.zip', env);
  assert.match(out, /Restored 2026-09-26-06-00-00\.zip/);
  assert.match(out, /Next: sudo systemctl start gtnh\.service/);
  assert.equal(readFileSync(join(dir, 'World', 'level.dat'), 'utf8'), 'new');
});

test("the real script's refusal rejects with its error output, without the prompt", async (t) => {
  const { dir, env } = fixture(t, 'active');
  writeFileSync(join(env.BACKUP_DIR, '2026-09-26-06-00-00.zip'), 'zip');
  await assert.rejects(execRestore('2026-09-26-06-00-00.zip', env), {
    message: 'restore-backup: gtnh.service is running; stop it first: sudo systemctl stop gtnh.service',
  });
  assert.equal(readFileSync(join(dir, 'World', 'level.dat'), 'utf8'), 'old');
});

// `loadConfig` (`config.ts`): one error listing every problem (and `check-config`), the Backup folder and the
// per-server defaults it applies (`config-defaults.ts`), and a removed key left unread. The checks are
// `config-validate.test.ts`, `config-servers.test.ts`, `config-agents.test.ts`, `config-integrations.test.ts` and
// `config-web.test.ts`; the shared setup is `config-fixtures.ts`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, validateConfig } from '../src/config.ts';
import { valid, withFactorio } from './config-fixtures.ts';

test('loadConfig throws one error listing every problem; check-config prints them and exits 1', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ ...valid(dir), dbPath: '', healthcheckUrl: 'x' }));
  assert.throws(() => loadConfig(path), /2 problems:\n- "dbPath" .*\n- "healthcheckUrl"/);
  await writeFile(join(dir, 'broken.json'), '{ nope');
  assert.throws(() => loadConfig(join(dir, 'broken.json')), /broken\.json: /);

  const run = (p: string) => execFileSync(process.execPath, ['src/check-config.ts', p], { encoding: 'utf8', stdio: 'pipe' });
  assert.throws(() => run(path), (err: { status: number; stderr: string }) => err.status === 1 && /"dbPath"/.test(err.stderr));
  await writeFile(path, JSON.stringify(valid(dir)));
  assert.equal(run(path), `${path} OK\n`);
});

async function load(dir: string, server: Record<string, unknown>) {
  const c = valid(dir);
  const { id, name } = c.servers[0];
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ ...c, servers: [{ id, name, ...server }] }));
  return loadConfig(path).servers[0];
}

test('loadConfig derives the Backup folder: backupDir, else <dir>/backups, else none', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  const other = await mkdtemp(join(tmpdir(), 'config-bk-'));
  t.after(() => Promise.all([rm(dir, { recursive: true, force: true }), rm(other, { recursive: true, force: true })]));
  assert.equal((await load(dir, { dir })).backupDir, join(dir, 'backups'));
  assert.equal((await load(dir, { backupDir: other })).backupDir, other);
  assert.equal((await load(dir, { dir, backupDir: other })).backupDir, other);
  assert.equal((await load(dir, {})).backupDir, undefined);
});

test('loadConfig applies each per-server default once, and keeps set values', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const d = await load(dir, {});
  assert.equal(d.game, 'minecraft');
  assert.deepEqual(d.lag, { tps: 15, minutes: 2, enabled: true });
  assert.equal(d.quests, 'batched');
  assert.equal(d.backupMinFreeGB, 10);
  assert.equal(d.backupMaxAgeHours, undefined);
  const s = await load(dir, { lagTps: 18, lagMinutes: 5, lagAlerts: false, quests: 'off', backupMinFreeGB: 3, backupMaxAgeHours: 26 });
  assert.deepEqual(s.lag, { tps: 18, minutes: 5, enabled: false });
  assert.equal(s.quests, 'off');
  assert.equal(s.backupMinFreeGB, 3);
  assert.equal(s.backupMaxAgeHours, 26);
  const path = join(dir, 'factorio.json');
  const factorio = withFactorio(dir);
  delete factorio.servers[1]!.lagTps;
  await writeFile(path, JSON.stringify(factorio));
  const f = loadConfig(path).servers[1]!;
  assert.equal(f.game, 'factorio');
  assert.deepEqual(f.lag, { tps: 50, minutes: 2, enabled: true }); // a factorio server's lag line is 50 of its 60 UPS
});

test('a config that still has the removed `environment` key is valid and loads, the key unread', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ ...valid(dir), environment: 'production' }));
  assert.deepEqual(validateConfig(JSON.parse(readFileSync(path, 'utf8'))), []);
  assert.equal(loadConfig(path).servers.length, valid(dir).servers.length);
});

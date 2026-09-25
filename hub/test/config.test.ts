import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, validateConfig } from '../src/config.ts';

const ID = '123456789012345678';

function valid(dir: string) {
  return {
    listenPort: 25580,
    dbPath: 'hub.db',
    guildId: ID,
    adminRoleId: ID,
    healthcheckUrl: 'https://hc-ping.com/abc',
    servers: [
      {
        id: 'gtnh',
        name: 'GTNH',
        token: 'a-long-enough-token',
        channelId: ID,
        dir,
        dailyRestart: '06:00',
        dailySummary: '09:00',
        backupMaxAgeHours: 26,
        backupMinFreeGB: 10,
        lagTps: 15,
        lagMinutes: 2,
        lagAlerts: true,
        quests: 'batched',
      },
    ],
  };
}

test('a valid config has no errors', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(validateConfig(valid(dir)), []);
});

test('validateConfig reports every problem at once, with where it is', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const c = valid(dir);
  const second = { ...c.servers[0], name: 'Two', token: 'short' };
  Object.assign(c.servers[0], { dailyRestart: '6am', quests: 'loud', lagTps: 30, dir: join(dir, 'missing') });
  const bad = { ...c, guildId: 'abc', healthcheckUrl: 'ftp://x', servers: [c.servers[0], second] };
  assert.deepEqual(validateConfig(bad), [
    '"guildId" must be a Discord ID (17–20 digits)',
    '"healthcheckUrl" must be an http(s) URL',
    'server "gtnh": "dailyRestart" must be HH:MM (24-hour), got "6am"',
    'server "gtnh": "quests" must be one of batched, main, all, off',
    'server "gtnh": "lagTps" must be a number from 1 to 20',
    `server "gtnh": "dir" is not an existing folder: ${join(dir, 'missing')}`,
    'server "gtnh": duplicate id',
    'server "gtnh": "token" must be at least 16 characters',
  ]);
  const low = valid(dir);
  low.servers[0].lagTps = 0.5;
  assert.deepEqual(validateConfig(low), ['server "gtnh": "lagTps" must be a number from 1 to 20']);
  assert.deepEqual(validateConfig([]), ['config must be a JSON object']);
  assert.deepEqual(validateConfig({}), [
    '"listenPort" must be a port number (1–65535)',
    '"dbPath" is required',
    '"guildId" is required',
    '"adminRoleId" is required',
    '"servers" must be a non-empty list',
  ]);
});

test('loadConfig throws one error listing every problem; check-config prints them and exits 1', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ ...valid(dir), guildId: 'x', adminRoleId: 'y' }));
  assert.throws(() => loadConfig(path), /2 problems:\n- "guildId" .*\n- "adminRoleId"/);
  await writeFile(join(dir, 'broken.json'), '{ nope');
  assert.throws(() => loadConfig(join(dir, 'broken.json')), /broken\.json: /);

  const run = (p: string) => execFileSync(process.execPath, ['src/check-config.ts', p], { encoding: 'utf8', stdio: 'pipe' });
  assert.throws(() => run(path), (err: { status: number; stderr: string }) => err.status === 1 && /"guildId"/.test(err.stderr));
  await writeFile(path, JSON.stringify(valid(dir)));
  assert.equal(run(path), `${path} OK\n`);
});

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
    dbPath: 'hub.db',
    healthcheckUrl: 'https://hc-ping.com/abc',
    servers: [
      {
        id: 'gtnh',
        name: 'GTNH',
        dir,
        dailyRestart: '06:00',
        dailySummary: '09:00',
        backupMaxAgeHours: 26,
        backupMinFreeGB: 10,
        lagTps: 15,
        lagMinutes: 2,
        lagAlerts: true,
        quests: 'batched',
      } as Record<string, unknown>,
    ],
    integrations: {
      minecraft: { listenPort: 25580, tokens: { gtnh: 'a-long-enough-token' } as Record<string, string> },
      discord: { guildId: ID, adminRoleId: ID, channels: { gtnh: ID } as Record<string, string> },
    },
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
  const second = { ...c.servers[0], name: 'Two' };
  Object.assign(c.servers[0], { dailyRestart: '6am', quests: 'loud', lagTps: 30, dir: join(dir, 'missing') });
  const bad = {
    ...c,
    healthcheckUrl: 'ftp://x',
    servers: [c.servers[0], second],
    integrations: {
      minecraft: { listenPort: 0, tokens: { gtnh: 'short', ghost: 'another-long-token' } },
      discord: { guildId: 'abc', adminRoleId: ID, channels: { gtnh: ID, nope: 'x' } },
    },
  };
  assert.deepEqual(validateConfig(bad), [
    '"healthcheckUrl" must be an http(s) URL',
    'server "gtnh": "dailyRestart" must be HH:MM (24-hour), got "6am"',
    'server "gtnh": "quests" must be one of batched, main, all, off',
    'server "gtnh": "lagTps" must be a number from 1 to 20',
    `server "gtnh": "dir" is not an existing folder: ${join(dir, 'missing')}`,
    'server "gtnh": duplicate id',
    'integrations.minecraft: "listenPort" must be a port number (1–65535)',
    'integrations.minecraft.tokens: "ghost" is not a server id',
    'integrations.minecraft.tokens: "gtnh" must be at least 16 characters',
    'integrations.discord: "guildId" must be a Discord ID (17–20 digits)',
    'integrations.discord.channels: "nope" is not a server id',
    'integrations.discord.channels: "nope" must be a Discord ID (17–20 digits)',
  ]);
  const low = valid(dir);
  low.servers[0].lagTps = 0.5;
  assert.deepEqual(validateConfig(low), ['server "gtnh": "lagTps" must be a number from 1 to 20']);
  assert.deepEqual(validateConfig([]), ['config must be a JSON object']);
  assert.deepEqual(validateConfig({}), ['"dbPath" is required', '"servers" must be a non-empty list']);
  assert.deepEqual(validateConfig({ ...valid(dir), integrations: [] }), ['"integrations" must be an object']);
  assert.deepEqual(validateConfig({ ...valid(dir), integrations: { discord: 'x' } }), ['integrations: "discord" must be an object']);
});

test('every server needs its own token when Minecraft is configured', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const c = valid(dir);
  c.servers.push({ id: 'two', name: 'Two' }, { id: 'three', name: 'Three' });
  c.integrations.minecraft.tokens.two = 'a-long-enough-token';
  assert.deepEqual(validateConfig(c), [
    'integrations.minecraft.tokens: "two" is the same as another server\'s',
    'integrations.minecraft.tokens: server "three" has no token',
  ]);
});

test('every integration is optional', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { integrations, ...none } = valid(dir);
  assert.deepEqual(validateConfig(none), []);
  assert.deepEqual(validateConfig({ ...none, integrations: {} }), []);
  assert.deepEqual(validateConfig({ ...none, integrations: { discord: integrations.discord } }), []);
  assert.deepEqual(validateConfig({ ...none, integrations: { minecraft: integrations.minecraft } }), []);
});

test('the old config shape is rejected with each key it has to move', () => {
  const old = {
    listenPort: 25580,
    dbPath: 'hub.db',
    guildId: ID,
    adminRoleId: ID,
    servers: [
      { id: 'gtnh', name: 'GTNH', token: 'a-long-enough-token', channelId: ID },
      { id: 'two', name: 'Two', token: 'another-long-token', channelId: ID },
    ],
  };
  assert.deepEqual(validateConfig(old), [
    'old config shape: move "listenPort" to integrations.minecraft.listenPort',
    'old config shape: move "guildId" to integrations.discord.guildId',
    'old config shape: move "adminRoleId" to integrations.discord.adminRoleId',
    'old config shape: move server "gtnh"\'s "token" to integrations.minecraft.tokens.gtnh',
    'old config shape: move server "gtnh"\'s "channelId" to integrations.discord.channels.gtnh',
    'old config shape: move server "two"\'s "token" to integrations.minecraft.tokens.two',
    'old config shape: move server "two"\'s "channelId" to integrations.discord.channels.two',
  ]);
});

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
  assert.deepEqual(d.lag, { tps: 15, minutes: 2, enabled: true });
  assert.equal(d.quests, 'batched');
  assert.equal(d.backupMinFreeGB, 10);
  assert.equal(d.backupMaxAgeHours, undefined);
  const s = await load(dir, { lagTps: 18, lagMinutes: 5, lagAlerts: false, quests: 'off', backupMinFreeGB: 3, backupMaxAgeHours: 26 });
  assert.deepEqual(s.lag, { tps: 18, minutes: 5, enabled: false });
  assert.equal(s.quests, 'off');
  assert.equal(s.backupMinFreeGB, 3);
  assert.equal(s.backupMaxAgeHours, 26);
});

// `validateConfig`'s whole pass (`config-validate.ts`): a valid config, every problem at once with where it is, the
// top-level keys, each server's Mod token, and the pre-2.0 shape's list of keys to move.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateConfig } from '../src/config.ts';
import { ID, valid } from './config-fixtures.ts';

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
    'integrations.minecraft.tokens: "gtnh" must be 16 to 256 characters',
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
  assert.deepEqual(validateConfig({ ...valid(dir), integrations: null }), ['"integrations" must be an object']);
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

test('the old config shape is rejected with each key it has to move', () => {
  const old = {
    listenPort: 25580,
    dbPath: 'hub.db',
    guildId: ID,
    adminRoleId: ID,
    servers: [
      { id: 'gtnh', name: 'GTNH', token: 'a-long-enough-token', channelId: ID },
      { id: 'two', name: 'Two', token: 'another-long-token', channelId: ID, quests: 'loud' },
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
    'server "two": "quests" must be one of batched, main, all, off',
  ]);
});

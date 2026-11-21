// `servers[]`'s own check (`config-servers.ts`): a factorio server's refused keys, its service and its one Agent,
// ids and tokens within the wire's cap, a server's linked service, and its keep list.

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, validateConfig } from '../src/config.ts';
import { AGENT_TOKEN, valid, withFactorio } from './config-fixtures.ts';

test('a factorio server has no folder, Backup folder, Kept paths or Mod token, and its lagTps goes up to 60 UPS', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const c = withFactorio(dir);
  assert.deepEqual(validateConfig(c), []); // the token is only required of minecraft servers
  Object.assign(c.servers[1]!, { dir, backupDir: dir, keep: ['x'], lagTps: 61 });
  c.servers.push({ id: 'odd', name: 'Odd', game: 'terraria' });
  c.integrations.minecraft.tokens.space = 'a-factorio-token-16';
  c.integrations.minecraft.tokens.odd = 'a-terraria-token-16';
  assert.deepEqual(validateConfig(c), [
    'server "space": "lagTps" must be a number from 1 to 60',
    'server "space": "dir" is only for minecraft servers: a factorio server has no folder on the hub\'s machine',
    'server "space": "backupDir" is only for minecraft servers: a factorio server has no folder on the hub\'s machine',
    'server "space": "keep" is only for minecraft servers: a factorio server has no folder on the hub\'s machine',
    'server "odd": "game" must be minecraft or factorio',
    'integrations.minecraft.tokens: "space" is a factorio server: only minecraft servers have a Mod token',
  ]);
});

test('a factorio server has a service and is exactly one agent\'s server', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const c = withFactorio(dir);
  delete c.servers[1]!.service;
  assert.deepEqual(validateConfig(c), ['server "space": "service" is required for a factorio server: its Agent starts and stops it']);
  const { agents: _, ...noAgents } = withFactorio(dir).integrations;
  assert.deepEqual(validateConfig({ ...c, servers: withFactorio(dir).servers, integrations: noAgents }), [
    'server "space": a factorio server must be the "server" of an agent in integrations.agents',
  ]);
  const two = withFactorio(dir);
  two.integrations.agents.agents.push({ id: 'second', name: 'Second', token: `${AGENT_TOKEN}-2`, address: '100.90.80.71', server: 'space' });
  assert.deepEqual(validateConfig(two), ['server "space": a factorio server is run by one agent only, not by "factorio-vm", "second"']);
  // The service an Agent backs is listed like any other, linked to its server only.
  const linked = withFactorio(dir);
  linked.servers[0]!.service = 'factorio';
  assert.deepEqual(validateConfig(linked), ['server "space": service "factorio" is linked to server "gtnh" already']);
});

test("tokens and server ids fit the wire's 256-character cap, so a hello can carry them", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { integrations: _, ...none } = valid(dir);
  const id = (sid: string) => validateConfig({ ...none, servers: [{ ...none.servers[0], id: sid }] });
  assert.deepEqual(id('x'.repeat(256)), []);
  assert.deepEqual(id('x'.repeat(257)), ['servers[0]: "id" must be at most 256 characters']);
  const mod = valid(dir);
  mod.integrations.minecraft.tokens.gtnh = 'm'.repeat(256);
  assert.deepEqual(validateConfig(mod), []);
  mod.integrations.minecraft.tokens.gtnh = 'm'.repeat(257);
  assert.deepEqual(validateConfig(mod), ['integrations.minecraft.tokens: "gtnh" must be 16 to 256 characters']);
  const agent = withFactorio(dir);
  agent.integrations.agents.agents[0]!.token = 'a'.repeat(256);
  assert.deepEqual(validateConfig(agent), []);
  agent.integrations.agents.agents[0]!.token = 'a'.repeat(257);
  assert.deepEqual(validateConfig(agent), ['agent "factorio-vm": "token" must be 32 to 256 characters']);
});

test("a server's linked service must be a listed service, linked to no other server", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { integrations: _, ...c } = valid(dir);
  const systemd = [{ id: 'gtnh', unit: 'gtnh.service' }];
  const servers = (...links: unknown[]) => links.map((service, i) => ({ id: `s${i}`, name: `S${i}`, service }));
  assert.deepEqual(validateConfig({ ...c, servers: servers('gtnh'), integrations: { systemd } }), []);
  assert.deepEqual(validateConfig({ ...c, servers: servers('nope', 4), integrations: { systemd } }), [
    'server "s0": "service" must be the id of a service in integrations.systemd',
    'server "s1": "service" must be the id of a service in integrations.systemd',
  ]);
  assert.deepEqual(validateConfig({ ...c, servers: servers('gtnh', 'gtnh'), integrations: { systemd } }), [
    'server "s1": service "gtnh" is linked to server "s0" already',
  ]);
  assert.deepEqual(validateConfig({ ...c, servers: servers('gtnh') }), [
    'server "s0": "service" must be the id of a service in integrations.systemd',
  ]);
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ ...c, servers: servers('gtnh'), integrations: { systemd } }));
  assert.equal(loadConfig(path).servers[0]!.service, 'gtnh');
});

test("a server's keep list is relative paths in its folder, without ..", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const c = valid(dir);
  c.servers[0]!.keep = ['config/JourneyMapServer', 'serverutilities/', 'journeymap'];
  assert.deepEqual(validateConfig(c), []);
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(c));
  assert.deepEqual(loadConfig(path).servers[0]!.keep, ['config/JourneyMapServer', 'serverutilities/', 'journeymap']);
  c.servers[0]!.keep = ['/etc', 'config/../..', '', 7, 'ok'];
  assert.deepEqual(validateConfig(c), [
    'server "gtnh": "keep" entries must be relative paths without "..", got "/etc"',
    'server "gtnh": "keep" entries must be relative paths without "..", got "config/../.."',
    'server "gtnh": "keep" entries must be relative paths without "..", got ""',
    'server "gtnh": "keep" entries must be relative paths without "..", got 7',
  ]);
  c.servers[0]!.keep = 'world';
  assert.deepEqual(validateConfig(c), ['server "gtnh": "keep" must be a list of paths in the server folder']);
});

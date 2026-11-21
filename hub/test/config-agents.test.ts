// `integrations.agents` (`config-validate.ts`): each Agent's id, name, address, server and token, the Agent port's
// address and port, and `loadConfig`'s defaults for an Agent's Host limits (`config-defaults.ts`).

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, validateConfig } from '../src/config.ts';
import { AGENT_TOKEN, withFactorio } from './config-fixtures.ts';

test("an agent names a factorio server, comes from an IPv4 address and has a long, unique token; its id is its Host's", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const c = withFactorio(dir);
  c.integrations.agents.agents.push(
    { id: 'Bad_Id', name: '', token: 'short', address: 'vm.tailnet', server: 'gtnh' },
    { id: 'oracle', name: 'Same as the hub', token: AGENT_TOKEN, address: '::1', server: 'ghost', host: { memoryMaxPercent: 101, memoryMinutes: 0.5, diskMinFreeGB: 0 } },
    { id: 'factorio-vm', name: 'Again', token: 'a-long-enough-token', address: '100.90.80.72', server: 'space', host: 'big' },
    { id: 'a-very-long-agent-id-of-33-chars0', name: 'Long', token: `${AGENT_TOKEN}-3`, address: '100.90.80.73', server: 'space' },
  );
  assert.deepEqual(validateConfig({ ...c, integrations: { ...c.integrations, host: { id: 'oracle' } } }), [
    'agent "Bad_Id": "id" must be lower-case letters, digits and dashes, starting with a letter, at most 32 characters',
    'agent "Bad_Id": "name" must be a non-empty string',
    'agent "Bad_Id": "token" must be 32 to 256 characters',
    'agent "Bad_Id": "address" must be an IPv4 address',
    'agent "Bad_Id": "server" "gtnh" must be a factorio server',
    'agent "oracle": "id" must differ from integrations.host.id: it is also its Host\'s id',
    'agent "oracle": "token" is the same as another token',
    'agent "oracle": "address" must be an IPv4 address',
    'agent "oracle": "server" "ghost" is not a server id',
    'agent "oracle": "memoryMaxPercent" must be a number from 1 to 100',
    'agent "oracle": "memoryMinutes" must be a whole number of at least 1',
    'agent "oracle": "diskMinFreeGB" must be a positive number',
    'agent "factorio-vm": "token" must be 32 to 256 characters',
    'agent "factorio-vm": "host" must be an object',
    'agent "factorio-vm": duplicate id',
    'agent "a-very-long-agent-id-of-33-chars0": "id" must be lower-case letters, digits and dashes, starting with a letter, at most 32 characters',
    'server "space": a factorio server is run by one agent only, not by "factorio-vm", "factorio-vm", "a-very-long-agent-id-of-33-chars0"',
  ]);
  // Unique across every token: a Mod's too.
  const mod = withFactorio(dir);
  mod.integrations.minecraft.tokens.gtnh = AGENT_TOKEN;
  assert.deepEqual(validateConfig(mod), ['agent "factorio-vm": "token" is the same as another token']);
});

test('the agents integration listens on an IPv4 address and a port of its own', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const c = withFactorio(dir);
  const agents = (a: unknown, extra: object = {}) => validateConfig({ ...c, integrations: { ...c.integrations, agents: a, ...extra } });
  const list = c.integrations.agents.agents;
  assert.deepEqual(agents('x'), ['integrations: "agents" must be an object', 'server "space": a factorio server must be the "server" of an agent in integrations.agents']);
  assert.deepEqual(agents({ agents: list }), ['integrations.agents: "listen" must be an object with "host" and "port"']);
  assert.deepEqual(agents({ listen: { host: '100.101.102.103', port: 25584 } }), [
    'integrations.agents: "agents" must be a list',
    'server "space": a factorio server must be the "server" of an agent in integrations.agents',
  ]);
  assert.deepEqual(agents({ listen: { host: 'tailnet', port: 0 }, agents: list }), [
    'integrations.agents.listen: "host" must be an IPv4 address',
    'integrations.agents.listen: "port" must be a port number (1–65535)',
  ]);
  const web = { listenPort: 25581, publicUrl: 'https://orrery.example' };
  assert.deepEqual(agents({ listen: { host: '100.101.102.103', port: 25580 }, agents: list }), [
    'integrations.agents.listen: "port" must differ from integrations.minecraft.listenPort',
  ]);
  assert.deepEqual(agents({ listen: { host: '100.101.102.103', port: 25581 }, agents: list }, { web }), [
    'integrations.agents.listen: "port" must differ from integrations.web.listenPort',
  ]);
});

test("loadConfig defaults an agent's Host limits like the hub's own", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const c = withFactorio(dir);
  c.integrations.agents.agents.push({ id: 'other', name: 'Other', token: `${AGENT_TOKEN}-2`, address: '100.90.80.71', server: 'more', host: { memoryMinutes: 10 } });
  c.servers.push({ id: 'more', name: 'More', game: 'factorio', service: 'more' });
  c.integrations.systemd.push({ id: 'more', unit: 'more.service' });
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(c));
  const { agents } = loadConfig(path).integrations;
  assert.deepEqual(agents!.listen, { host: '100.101.102.103', port: 25584 });
  assert.deepEqual(
    agents!.agents.map((a) => a.host),
    [
      { memoryMaxPercent: 90, memoryMinutes: 5, diskMinFreeGB: 10 },
      { memoryMaxPercent: 90, memoryMinutes: 10, diskMinFreeGB: 10 },
    ],
  );
  assert.equal(agents!.agents[0]!.server, 'space');
});

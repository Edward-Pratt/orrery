import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, checkConfig, loadConfig } from '../src/config.ts';

/** The config as setup writes it (deploy/setup-agent-host.sh). */
const CONFIG = {
  id: 'factorio-vm',
  hub: { host: '100.101.102.103', port: 25584 },
  server: { id: 'factorio', unit: 'factorio.service', install: '/opt/factorio', data: '/srv/factorio', rconPort: 27015, factorioUdpPort: 34198, agentUdpPort: 34199 },
  mounts: ['/'],
};
const ENV = { ORRERY_AGENT_TOKEN: 'k'.repeat(32), RCON_PASSWORD: 'rcon' };

const errors = (raw: unknown, env: NodeJS.ProcessEnv = ENV) => {
  const r = checkConfig(raw, env);
  return 'errors' in r ? r.errors.join('\n') : '';
};
const withServer = (o: Record<string, unknown>) => ({ ...CONFIG, server: { ...CONFIG.server, ...o } });

test('loads the config setup writes, with the secrets from the environment and state under the agent folder', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'config.json');
  await writeFile(file, JSON.stringify({ ...CONFIG, later: 'a newer setup may add keys' }));
  assert.deepEqual(loadConfig(file, ENV), {
    ...CONFIG,
    token: ENV.ORRERY_AGENT_TOKEN,
    rconPassword: 'rcon',
    root: '/srv/orrery-agent',
    state: '/srv/orrery-agent/state',
  });
  assert.equal(loadConfig(file, ENV, '/home/me/agent').state, '/home/me/agent/state');
  assert.throws(() => loadConfig(join(dir, 'missing.json'), ENV), ConfigError);
  await writeFile(file, '{');
  assert.throws(() => loadConfig(file, ENV), /can't read/);
});

test('refuses each bad field, listing every problem and never a secret', () => {
  const cases: [unknown, RegExp][] = [
    [[], /JSON object/],
    [{ ...CONFIG, id: 'Factorio' }, /"id"/],
    [{ ...CONFIG, id: 'a'.repeat(33) }, /"id"/],
    [{ ...CONFIG, hub: { host: 'hub.example', port: 25584 } }, /IPv4/],
    [{ ...CONFIG, hub: { host: '100.101.102.103', port: 70000 } }, /port/],
    [{ ...CONFIG, hub: '100.101.102.103:25584' }, /"hub"/],
    [withServer({ id: '' }), /server: "id"/],
    [withServer({ id: 'x'.repeat(257) }), /server: "id"/],
    [withServer({ unit: '--all' }), /"unit"/],
    [withServer({ unit: 'factorio.socket' }), /"unit"/],
    [withServer({ data: 'srv/factorio' }), /"data"/],
    [withServer({ data: '/srv/factorio/' }), /"data"/],
    [withServer({ data: '/srv/../etc' }), /"data"/],
    [withServer({ data: '/' }), /"data"/],
    [withServer({ data: '/srv/orrery-agent/data' }), /outside \/srv\/orrery-agent/],
    [withServer({ data: '/srv' }), /outside \/srv\/orrery-agent/],
    [withServer({ install: '/srv/factorio/game' }), /separate/],
    [withServer({ rconPort: 0 }), /"rconPort"/],
    [withServer({ agentUdpPort: 34198 }), /must differ/],
    [{ ...CONFIG, mounts: [] }, /"mounts"/],
    [{ ...CONFIG, mounts: ['relative'] }, /"mounts"/],
    [{ ...CONFIG, mounts: ['/', '/'] }, /twice/],
    [{ ...CONFIG, mounts: Array.from({ length: 33 }, (_, i) => `/m${i}`) }, /"mounts"/],
  ];
  for (const [raw, want] of cases) assert.match(errors(raw), want, JSON.stringify(raw));
  assert.match(errors(CONFIG, { RCON_PASSWORD: 'rcon' }), /ORRERY_AGENT_TOKEN/);
  assert.match(errors(CONFIG, { ...ENV, ORRERY_AGENT_TOKEN: 'k'.repeat(31) }), /32 to 256/);
  assert.match(errors(CONFIG, { ...ENV, ORRERY_AGENT_TOKEN: 'k'.repeat(257) }), /32 to 256/);
  assert.match(errors(CONFIG, { ORRERY_AGENT_TOKEN: ENV.ORRERY_AGENT_TOKEN }), /RCON_PASSWORD/);
  const all = errors({ id: 'X', hub: {}, server: {}, mounts: 'x' }, {});
  assert.ok(all.split('\n').length >= 10, all);
  assert.ok(!errors(CONFIG, { ...ENV, ORRERY_AGENT_TOKEN: 'secret-but-short' }).includes('secret-but-short'));
  assert.match(errors(CONFIG, ENV) || 'ok', /^ok$/);
});

test('the agent folder must be a plain absolute path, and state never lands under the server data', () => {
  assert.match(JSON.stringify(checkConfig(CONFIG, ENV, 'relative')), /absolute path/);
  assert.match(JSON.stringify(checkConfig(CONFIG, ENV, '/srv/factorio/agent')), /outside/);
});

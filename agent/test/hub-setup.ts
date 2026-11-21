// The `HubClient` tests' shared setup (`hub.test.ts`, `hub-retry.test.ts`, `hub-game.test.ts`): a `HubClient` against
// the fake hub on a temp agent folder, with fast reconnect waits, stopped in `t.after` (`setup`), the connection's lines
// after the hello by type (`sent`), a status reading, the server's config, and a unit state since a time (`unit`).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { HubClient, type HubOptions } from '../src/hub.ts';
import type { Reading } from '../src/status.ts';
import { fakeHub, type Answer, type HubConn } from './fake-hub.ts';

export const TOKEN = 'agent-token-'.padEnd(40, 'x');
export const VERSION = 'agent-v1.2.3';
export const READING: Reading = { ups: null, players: [], paused: true, modVersion: '0.1.0' };
export const SERVER = { id: 'factorio', unit: 'factorio.service', install: '/opt/factorio', data: '/srv/factorio', rconPort: 1, factorioUdpPort: 34198, agentUdpPort: 34199 };

export async function setup(t: TestContext, answer?: (hello: Record<string, unknown>, conn: HubConn) => Answer, options: Partial<HubOptions> = {}) {
  const hub = await fakeHub(answer);
  const root = await mkdtemp(join(tmpdir(), 'orrery-agent-'));
  const client = new HubClient({
    config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server: SERVER, token: TOKEN, root, state: join(root, 'state') },
    version: VERSION,
    backoffMs: 20,
    maxBackoffMs: 100,
    random: () => 1,
    ...options,
  });
  t.after(async () => {
    await client.stop();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  });
  return { hub, client, root };
}

/** The connection's lines after the hello, by type. */
export const sent = (conn: HubConn, type: string) => conn.lines.slice(1).filter((m) => m.type === type);

export const T0 = 1_793_475_900_000;
export const unit = (since: number, active = 'active') => ({ unit: 'factorio.service', active, sub: active === 'active' ? 'running' : 'dead', since, result: 'success' });

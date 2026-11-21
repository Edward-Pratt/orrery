// The Agent port tests' shared setup (`test/agents/agents*.test.ts`), on real sockets on 127.0.0.1 (an ephemeral
// port): Agent `vm`'s config (`AGENT_TOKEN`, `LIMITS_VM`, `VM`), its two first lines (`agentHello`, `gameHello`), a Host
// sample (`SAMPLE`), a hub with the Agent port (`setup`), the hub's side of each connection (`hubSides`), waits by the
// real clock (`waitFor`, `readAll`), and the Agent's two connections welcomed (`agentUp`, `gameUp`).

import assert from 'node:assert/strict';
import { Socket } from 'node:net';
import type { TestContext } from 'node:test';
import { Agents, type AgentsOptions } from '../../src/agents/agents.ts';
import { Db } from '../../src/stats/db.ts';
import { Hosts } from '../../src/agents/host.ts';
import { ServerHub, type HubEvent, type HubOptions, type TargetEvent } from '../../src/servers/servers.ts';
import { fakeMod, sleep, TOKEN } from '../fake-mod.ts';

export const AGENT_TOKEN = 'agent-token-0123456789abcdef-0123456789';
export const LIMITS_VM = { memoryMaxPercent: 90, memoryMinutes: 5, diskMinFreeGB: 10 };
export const VM = { id: 'vm', name: 'Factorio VM', token: AGENT_TOKEN, address: '127.0.0.1', server: 'space', host: LIMITS_VM };

export const agentHello = (token = AGENT_TOKEN, agentId = 'vm', protocol = 1) => ({ type: 'agentHello', protocol, agentId, token, agentVersion: 'agent-v1.0.0' });
export const gameHello = (token = AGENT_TOKEN, serverId = 'space') => ({ type: 'hello', protocol: 1, serverId, token, modVersion: '0.1.0' });
export const SAMPLE = { ts: 1_000, cpu: 0.25, load: [1, 0.5, 0.25], memory: { used: 1, total: 4 }, disks: [{ mount: '/', free: 3, total: 9 }] };

/**
 * A hub with a minecraft server (`gtnh`, on no port here) and a factorio one (`space`) run by Agent `vm`, whose
 * address is `address` (default the tests' own, 127.0.0.1); the Agent port on an ephemeral port, welcoming a
 * reconnect at once unless `agents.handshakeMs` says otherwise.
 */
export async function setup(t: TestContext, { address = '127.0.0.1', hub: hubOpts = {}, agents: agentOpts = {} }: { address?: string; hub?: HubOptions; agents?: AgentsOptions } = {}) {
  const hub = new ServerHub(
    [
      { id: 'gtnh', name: 'GTNH', game: 'minecraft', token: TOKEN },
      { id: 'space', name: 'Space Age', game: 'factorio' },
    ],
    { settleMs: 100, ...hubOpts },
  );
  hub.start();
  const db = new Db(':memory:');
  const hosts = new Hosts(hub, db);
  hosts.add({ id: 'vm', mounts: [], ...LIMITS_VM });
  const agents = new Agents(hub, hosts, { listen: { host: '127.0.0.1', port: 0 }, agents: [{ ...VM, address }] }, { silenceMs: 5_000, handshakeMs: 0, ...agentOpts });
  const port = await agents.start();
  const events: HubEvent[] = [];
  hub.on('event', (e) => events.push(e));
  const targets: TargetEvent[] = [];
  hub.on('target', (e) => targets.push(e));
  t.after(async () => {
    await agents.close();
    await hub.close();
    db.close();
  });
  const notices = () => targets.flatMap((e) => (e.type === 'notice' ? [e.kind] : []));
  return { hub, agents, hosts, db, port, events, targets, notices, types: () => events.map((e) => e.type) };
}

/**
 * The hub's side of each connection the Agent port goes on to read (it resumes each one it accepts), in order: so a
 * test can wait until the hub has read what it sent, even lines the hub drops.
 */
export function hubSides(t: TestContext, port: number): Socket[] {
  const sides: Socket[] = [];
  const resume = Socket.prototype.resume;
  t.mock.method(Socket.prototype, 'resume', function (this: Socket) {
    if (this.localPort === port && !sides.includes(this)) sides.push(this);
    return resume.call(this);
  });
  return sides;
}

/** Waits for `cond` by the real clock (`Date` may be mocked), failing after 2 s. */
export async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const end = performance.now() + 2000;
  while (!cond()) {
    if (performance.now() > end) throw new Error(`${what}: not in time`);
    await sleep(2);
  }
}

/** Waits until the hub's side has read every byte `client` wrote (its lines are handled as they are read), or is gone. */
export const readAll = (side: Socket, client: Socket) => waitFor(() => side.destroyed || side.bytesRead >= client.bytesWritten, 'the hub reading');

export async function agentUp(port: number) {
  const agent = fakeMod(port);
  agent.send(agentHello());
  assert.deepEqual(await agent.next(), { type: 'welcome' });
  return agent;
}

export async function gameUp(port: number) {
  const game = fakeMod(port);
  game.send(gameHello());
  assert.deepEqual(await game.next(), { type: 'welcome' });
  return game;
}

// The `startHub` tests' shared setup (`test/start-*.test.ts`), each hub started with stub frontends and its web API
// driven through `app.request`: the Minecraft and Discord integrations' config (`MINECRAFT`, `DISCORD`), a Minecraft +
// Discord + web hub with a logged-in owner and two servers (`apiHub`), the event stream (`openStream`, `Sse`,
// `unstamped`), server cards (`cardsOf`), the dashboard's POST and its audit (`post`, `ORIGIN`, `webAudit`), a check
// (`SITE`, `UP`), Host samples (`GB`, `VM`, `vmSample`), a fake systemctl/journalctl (`UNITS`, `fakeSystemd`), and the
// agents integration: its config (`AGENTS`, `agentConfig`), an Agent online (`agentOnline`) and a hub whose Agent runs
// `factorio` as a service (`agentServicesHub`, with `FACTORIO_UNIT`, `flush`, `eventually` and `asked`).

import assert from 'node:assert/strict';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import type { AuditLog, HostSample, LiveEvent, ServerCard, TargetEvent } from '../src/api.ts';
import type { Config } from '../src/config.ts';
import type { Run } from '../src/services/services.ts';
import type { RestartScheduler } from '../src/servers/restarts.ts';
import type { HubEvent, ServerHub } from '../src/servers/servers.ts';
import { startHub } from '../src/start.ts';
import type { Stats } from '../src/stats/stats.ts';
import type { WebApi } from '../src/web/web.ts';
import { fakeMod, TOKEN, until } from './fake-mod.ts';
import { config, loginCookie, WEB } from './web/web-hub.ts';

export const MINECRAFT = { listenPort: 0, tokens: { gtnh: TOKEN } };
export const DISCORD = { guildId: '1'.repeat(18), adminRoleId: '2'.repeat(18), channels: { gtnh: '3'.repeat(18) } };

export type Sse = { id: number; at: number; data: HubEvent | TargetEvent };
/** A live event without the feed's time, to compare with what was sent. */
export const unstamped = ({ at: _, ...e }: LiveEvent) => e as HubEvent | TargetEvent;

/** Opens /api/events and reads its frames (comments skipped) as they arrive. */
export async function openStream(app: WebApi, cookie: string, lastEventId?: number) {
  const headers: Record<string, string> = { cookie };
  if (lastEventId !== undefined) headers['last-event-id'] = String(lastEventId);
  const res = await app.request('/api/events', { headers });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const events: Sse[] = [];
  let buf = '';
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += value;
      let end;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, end).split('\n');
        buf = buf.slice(end + 2);
        const field = (name: string) => frame.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
        const data = field('data');
        if (data) {
          const event = JSON.parse(data) as LiveEvent;
          events.push({ id: Number(field('id')), at: event.at, data: unstamped(event) });
        }
      }
    }
  })();
  return { events, close: async () => (await reader.cancel(), await pump) };
}

/**
 * A Minecraft + Discord + web hub with a logged-in owner and two servers: `gtnh` (with the mod and a Backup folder
 * holding two backups a day apart) and `web` (no mod token).
 */
export async function apiHub(t: TestContext) {
  const cfg = config(t, { minecraft: MINECRAFT, discord: DISCORD, web: WEB });
  const backupDir = join(dirname(cfg.dbPath), 'backups');
  mkdirSync(backupDir);
  for (const [name, bytes, mtime] of [
    ['2026-09-24-06-00-00.zip', 100, Date.now() - 24 * 60 * 60_000],
    ['2026-09-25-06-00-00.zip', 300, Date.now()],
  ] as const) {
    writeFileSync(join(backupDir, name), 'x'.repeat(bytes));
    utimesSync(join(backupDir, name), mtime / 1000, mtime / 1000);
  }
  cfg.servers = [{ ...cfg.servers[0]!, backupDir }, { ...cfg.servers[0]!, id: 'web', name: 'Website' }];
  let hub: ServerHub | undefined;
  let restarts: RestartScheduler | undefined;
  const handle = await startHub(cfg, {
    startFrontend: async (h, _s, r) => {
      hub = h;
      restarts = r;
      return { stop: () => {} };
    },
    get: async () => ({ ok: true, status: 200 }),
  });
  t.after(() => handle.close());
  const app = handle.web!.app;
  const cookie = await loginCookie(handle.web!);
  const get = async <T>(path: string): Promise<T> => {
    const res = await app.request(path, { headers: { cookie } });
    assert.equal(res.status, 200, path);
    return res.json() as Promise<T>;
  };
  return { app, cookie, get, hub: hub!, restarts: restarts!, port: handle.port!, live: handle.live };
}

export async function cardsOf(app: WebApi, cookie: string) {
  return (await (await app.request('/api/servers', { headers: { cookie } })).json()) as ServerCard[];
}

export const ORIGIN = 'https://dash.orrery.run';

/** A POST the way the dashboard sends it: same origin, JSON. */
export function post(app: WebApi, cookie: string, path: string, body?: object, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: body && JSON.stringify(body),
  });
}

/** The dashboard's actions in the audit, but for the test login's own `invite accepted`. */
export const webAudit = (log: AuditLog) => log.entries.filter((e) => e.actor.startsWith('web:') && !e.target.startsWith('user:')).map(({ ts: _, id: __, ...e }) => e);

export const SITE = { id: 'site', url: 'https://site.example', intervalSeconds: 60 };

export const UP = { ok: true, status: 200 };

export const GB = 1024 ** 3;

/** Another Host, `vm` (mount `/`, memory warning at 50% for 1 sample, disk at 10 GB), its samples reported to the hub. */
export const VM = { id: 'vm', mounts: ['/'], memoryMaxPercent: 50, memoryMinutes: 1, diskMinFreeGB: 10 };
export const vmSample = (memUsed: number, free = 50 * GB): HostSample => ({
  ts: Date.now(),
  cpu: 0.5,
  load: [1, 1, 1],
  memory: { used: memUsed, total: 16 * GB },
  disks: [{ mount: '/', free, total: 100 * GB }],
});

export const UNITS = [
  { id: 'gtnh', unit: 'gtnh.service' },
  { id: 'caddy', unit: 'caddy.service' },
];

/** A fake systemctl/journalctl: `states` holds each listed unit's ActiveState and SubState; every call is recorded. */
export function fakeSystemd() {
  const states: Record<string, [string, string]> = { 'gtnh.service': ['active', 'running'], 'caddy.service': ['active', 'running'] };
  const calls: string[][] = [];
  const fake = { fails: false };
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    if (fake.fails) throw new Error('permission denied');
    if (command === 'journalctl') return '2026-09-27T10:00:00+0000 host gtnh[1]: one\n2026-09-27T10:00:01+0000 host gtnh[1]: two\n';
    const [active, sub] = states[args.at(-1)!] ?? assert.fail(`unlisted unit ${args.at(-1)}`);
    return `ActiveState=${active}\nSubState=${sub}\n`;
  };
  /** The units every call named. */
  const units = () => calls.map((c) => (c[0] === 'journalctl' ? c.find((a) => a.startsWith('--unit='))!.slice(7) : c.at(-1)!));
  return Object.assign(fake, { run, calls, states, units });
}

const AGENT_TOKEN = 'agent-token-0123456789abcdef-0123456789';
const VM_LIMITS = { memoryMaxPercent: 90, memoryMinutes: 5, diskMinFreeGB: 10 };
export const AGENTS = {
  listen: { host: '127.0.0.1', port: 0 },
  agents: [{ id: 'vm', name: 'Factorio VM', token: AGENT_TOKEN, address: '127.0.0.1', server: 'space', host: VM_LIMITS }],
};

/** A config with `integrations` plus the agents one, and factorio server `space` run by Agent `vm`. */
export function agentConfig(t: TestContext, integrations: Config['integrations']): Config {
  const cfg = config(t, { agents: AGENTS, ...integrations });
  cfg.servers.push({ id: 'space', name: 'Space Age', game: 'factorio', backupMinFreeGB: 10, lag: { tps: 50, minutes: 2, enabled: true }, quests: 'batched' });
  return cfg;
}

/** An Agent (`agentHello`) and its game connection (`hello`) on the Agent port, both welcomed. */
export async function agentOnline(port: number) {
  const agent = fakeMod(port);
  agent.send({ type: 'agentHello', protocol: 1, agentId: 'vm', token: AGENT_TOKEN, agentVersion: 'agent-v1.0.0' });
  assert.deepEqual(await agent.next(), { type: 'welcome' });
  const game = fakeMod(port);
  game.send({ type: 'hello', protocol: 1, serverId: 'space', token: AGENT_TOKEN, modVersion: '0.1.0' });
  assert.deepEqual(await game.next(), { type: 'welcome' });
  return { agent, game };
}

export const FACTORIO_UNIT = { id: 'factorio', unit: 'factorio.service' };

/** A connection's messages as they arrive, apart from `next()`, so a test can see what has (not) come yet. */
function recorded(conn: ReturnType<typeof fakeMod>) {
  const got: unknown[] = [];
  createInterface({ input: conn.socket }).on('line', (line) => got.push(JSON.parse(line)));
  return got;
}

/** Lets loopback sockets deliver what was just written, without timers (setTimeout may be mocked). */
export async function flush() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** Waits for `cond` without timers (setTimeout may be mocked). */
export async function eventually(cond: () => Promise<boolean>) {
  for (let i = 0; i < 500; i++) {
    if (await cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail('condition not met');
}

/**
 * A web hub with systemd (the local units and `factorio`, the service of `space`, which Agent `vm` backs) and Discord
 * (to hand out its ServerHub, Stats and RestartScheduler), with the Agent and its game connection up and `players`
 * online. No restore script: only the Agent can restore.
 */
export async function agentServicesHub(t: TestContext, players: string[]) {
  const cfg = agentConfig(t, { web: WEB, systemd: [...UNITS, FACTORIO_UNIT], discord: DISCORD });
  delete cfg.healthcheckUrl;
  cfg.servers.find((s) => s.id === 'space')!.service = 'factorio';
  const systemd = fakeSystemd();
  let frontend: { hub: ServerHub; stats: Stats; restarts: RestartScheduler } | undefined;
  const handle = await startHub(cfg, {
    startFrontend: async (hub, stats, restarts) => {
      frontend = { hub, stats, restarts };
      return { stop: () => {} };
    },
    get: () => assert.fail('nothing to request'),
    run: systemd.run,
  });
  t.after(() => handle.close());
  const app = handle.web!.app;
  const cookie = await loginCookie(handle.web!);
  const get = async <T>(path: string) => (await app.request(path, { headers: { cookie } })).json() as Promise<T>;
  const { agent, game } = await agentOnline(await handle.agentPort!);
  const agentGot = recorded(agent);
  const gameGot = recorded(game);
  game.send({ type: 'heartbeat', tps: 60, players });
  await until(() => handle.live.since().some(([, e]) => 'serverId' in e && e.serverId === 'space' && e.type === 'tps'));
  /** Answers the Agent's next request (ok, with `data` if given) and returns it. */
  const answer = async (data?: object) => {
    const req = (await agent.next()) as { id: string; type: string };
    agent.send({ type: 'reply', id: req.id, ok: true, ...(data && { data }) });
    return req;
  };
  // An Agent's unit is never this machine's: the hub's systemctl and journalctl never see it.
  t.after(() => assert.ok(!systemd.units().includes('factorio.service'), systemd.units().join(' ')));
  return { app, cookie, get, agent, game, agentGot, gameGot, answer, ...frontend!, live: handle.live };
}

/** What a request to the Agent asked for, without its fresh id. */
export const asked = (req: unknown) => {
  const { id, ...rest } = req as { id: string };
  assert.match(id, /^[0-9a-f-]{36}$/);
  return rest;
};

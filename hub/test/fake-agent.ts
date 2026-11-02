// A whole hub with a fake Agent on its Agent port and a fake factorio.com and mod portal (`PortalFetch`): the
// factorio server `space` run by Agent `vm`, for game update and Agent deploy tests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { TestContext } from 'node:test';
import type { GameState, LiveEvent, ServerCard } from '../src/api.ts';
import type { AgentsOptions } from '../src/agents/agents.ts';
import type { Config, ServerSettings } from '../src/config.ts';
import type { DeploysOptions } from '../src/updates/deploys.ts';
import type { PortalFetch } from '../src/updates/factorio.ts';
import type { RestartScheduler } from '../src/servers/restarts.ts';
import { startHub, type HubDeps } from '../src/start.ts';
import type { FactorioMod, Notice } from '../src/types.ts';
import type { OAuth } from '../src/web/web.ts';
import { fakeMod } from './fake-mod.ts';

export const WEB = { listenPort: 0, publicUrl: 'https://dash.orrery.run', clientId: '4'.repeat(18), guildId: '7'.repeat(18), adminRoleId: '8'.repeat(18), sessionDays: 7 };
export const ADMIN = { id: '5'.repeat(18), username: 'alex', avatar: null, roles: [WEB.adminRoleId] };
export const ACTOR = `web:alex (${ADMIN.id})`;
export const AGENT_TOKEN = 'agent-token-0123456789abcdef-0123456789';
export const ACCOUNT = { username: 'owner', token: 'secret-token-0123456789' };
export const AGENTS = {
  listen: { host: '127.0.0.1', port: 0 },
  agents: [{ id: 'vm', name: 'Factorio VM', token: AGENT_TOKEN, address: '127.0.0.1', server: 'space', host: { memoryMaxPercent: 90, memoryMinutes: 5, diskMinFreeGB: 10 } }],
};
export const oauth: OAuth = { token: async () => 'access', member: async () => ADMIN };

/** What the Agent says the server runs: Factorio 2.1.24, the game's own mods and `orrery`. */
export const INSTALLED: FactorioMod[] = [
  { name: 'base', version: '2.1.24' },
  { name: 'elevated-rails', version: '2.1.24' },
  { name: 'quality', version: '2.1.24' },
  { name: 'space-age', version: '2.1.24' },
  { name: 'orrery', version: '0.1.0' },
];
export const PICK = { factorio: '2.1.24', mods: [{ name: 'orrery', version: null }, { name: 'helmod', version: null }] };
export const sha = (s: string, kind = 'sha1') => createHash(kind).update(s).digest('hex');
export const rel = (name: string, version: string, deps: string[] = ['base >= 2.1.0']) => ({
  version,
  sha1: sha(`${name}@${version}`),
  download_url: `/download/${name}/${sha(name).slice(0, 24)}`,
  info_json: { factorio_version: '2.1', dependencies: deps },
});
export const MODS: Record<string, unknown[]> = {
  orrery: [rel('orrery', '0.1.0', ['base >= 2.1.0', '? space-age'])],
  helmod: [rel('helmod', '2.0.0', ['base >= 2.1.0', 'flib >= 0.16.0'])],
  flib: [rel('flib', '0.15.0'), rel('flib', '0.16.2')],
  needy: [rel('needy', '1.0.0', ['nowhere'])],
};
export const SHA256 = sha('factorio-2.1.24', 'sha256');
/** A signed link as dl-mod.factorio.com's: its only query key `secure`. */
export const signed = (name: string) => `https://dl-mod.factorio.com/files/${sha(name).slice(0, 2)}/${name}.zip?secure=sig-${name},1730393211`;

/** The mod browser's: the portal's list for 2.1 (each row the newest release for it), and the thumbnails. */
export const LISTED = [
  { name: 'helmod', title: 'Helmod', owner: 'Helfima', summary: 'Plan your factory.', downloads_count: 500_000, category: 'tweaks', latest_release: { version: '2.0.0', released_at: '2026-10-02T00:00:00.000Z', info_json: { factorio_version: '2.1' } } },
  { name: 'flib', title: 'Factorio Library', owner: 'raiguard', summary: 'A library.', downloads_count: 1_080_000, category: 'internal', latest_release: { version: '0.16.2', released_at: '2026-10-01T00:00:00.000Z', info_json: { factorio_version: '2.1' } } },
  { name: 'Squeak Through', title: 'Squeak Through', owner: 'someone', summary: 'Squeeze.', downloads_count: 3, category: 'tweaks', latest_release: { version: '1.0.0', info_json: { factorio_version: '2.1' } } },
];
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a thumbnail')]);
const THUMB = `/assets/${'a'.repeat(40)}.thumb.png`;

/** factorio.com and the mod portal: a download link only with the account, as a redirect. */
export const portal: PortalFetch = async (url, init) => {
  if (url === 'https://factorio.com/api/latest-releases') return Response.json({ stable: { headless: '2.1.24' }, experimental: { headless: '2.1.25' } });
  if (url === 'https://mods.factorio.com/api/mods?page_size=max&version=2.1&hide_deprecated=true') return Response.json({ pagination: null, results: LISTED });
  if (url === 'https://mods.factorio.com/api/categories') return Response.json([['tweaks', 'Tweaks', ''], ['internal', 'Internal', ''], ['mod-packs', 'Mod packs', '']]);
  const short = /^https:\/\/mods\.factorio\.com\/api\/mods\/([^/]+)$/.exec(url);
  if (short) {
    const name = decodeURIComponent(short[1]!);
    if (name === 'down') return new Response('', { status: 503 });
    return LISTED.some((m) => m.name === name) ? Response.json({ name, ...(name !== 'flib' && { thumbnail: THUMB }) }) : new Response('', { status: 404 });
  }
  if (url === `https://assets-mod.factorio.com${THUMB}`) return new Response(new Uint8Array(PNG), { headers: { 'content-type': 'image/png' } });
  if (url === 'https://www.factorio.com/download/sha256sums/') return new Response(`${SHA256}  factorio-headless_linux-arm64_2.1.24.tar.xz\n`);
  const mod = /^https:\/\/mods\.factorio\.com\/api\/mods\/([^/]+)\/full$/.exec(url);
  if (mod) return MODS[mod[1]!] ? Response.json({ name: mod[1], title: mod[1], releases: MODS[mod[1]!] }) : new Response('', { status: 404 });
  const link = /^https:\/\/mods\.factorio\.com\/download\/([^/]+)\/[0-9a-f]+\?/.exec(url);
  if (link && init.redirect === 'manual') {
    const q = new URL(url).searchParams;
    if (q.get('username') !== ACCOUNT.username || q.get('token') !== ACCOUNT.token) return new Response('', { status: 403 });
    return new Response(null, { status: 302, headers: { location: signed(link[1]!) } });
  }
  return new Response('', { status: 404 });
};

export const github: HubDeps['github'] = {
  releases: async () => [{ tag: 'hub-v2.7.0', draft: false, prerelease: false, publishedAt: 1, assets: [] }],
  download: async () => new Uint8Array(),
};

/** The factorio server `space` run by Agent `vm`, its service `factorio`, with the web and systemd integrations. */
export function gameConfig(t: TestContext, integrations: Partial<Config['integrations']> = {}, server: Partial<ServerSettings> = {}): Config {
  const dir = mkdtempSync(join(tmpdir(), 'hub-game-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    environment: 'production',
    dbPath: join(dir, 'hub.db'),
    servers: [
      { id: 'gtnh', name: 'GTNH', game: 'minecraft', backupMinFreeGB: 10, lag: { tps: 15, minutes: 2, enabled: true }, quests: 'batched' },
      { id: 'space', name: 'Space Age', game: 'factorio', service: 'factorio', backupMinFreeGB: 10, lag: { tps: 50, minutes: 2, enabled: true }, quests: 'batched', ...server },
    ],
    integrations: { agents: AGENTS, systemd: [{ id: 'factorio', unit: 'factorio.service' }], web: WEB, ...integrations },
  };
}

/**
 * A whole hub on `cfg` (a fresh one by default), logged in, with every pack-update notice of `space` kept. Its Agent
 * port welcomes a reconnect at once unless `agents.handshakeMs` says otherwise: the fake Agent comes back in
 * milliseconds, a real one's deploy restart or Factorio's restart long after the 5 s throttle.
 */
export async function gameHub(
  t: TestContext,
  {
    cfg = gameConfig(t),
    account = true,
    quietMs,
    releases = github,
    deploys,
    agents = { handshakeMs: 0 },
  }: { cfg?: Config; account?: boolean; quietMs?: number; releases?: HubDeps['github']; deploys?: DeploysOptions; agents?: AgentsOptions } = {},
) {
  let restarts: RestartScheduler | undefined;
  const handle = await startHub(cfg, {
    startFrontend: async (_hub, _stats, r) => {
      restarts = r;
      return { stop: () => {} };
    },
    get: async () => ({ ok: true, status: 200 }),
    oauth,
    run: async () => '',
    portal,
    factorioAccount: account ? ACCOUNT : undefined,
    github: cfg.integrations.github ? releases : undefined,
    deploys,
    agents,
    gameUpdates: { pollMs: 5, ...(quietMs && { quietMs }) },
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  t.after(close);
  const app = handle.web!.app;
  const login = await app.request('/api/login');
  const state = new URL(login.headers.get('location')!).searchParams.get('state');
  const callback = await app.request(`/api/callback?code=x&state=${state}`, { headers: { cookie: login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') } });
  const cookie = callback.headers.getSetCookie().find((c) => c.startsWith('session='))!.split(';')[0]!;
  const notices: Notice[] = [];
  handle.live.on('event', (_, { at: _at, ...e }: LiveEvent) => {
    if ('serverId' in e && e.serverId === 'space' && e.type === 'notice') {
      const { type: _t, serverId: _s, ...n } = e;
      notices.push(n as Notice);
    }
  });
  const req = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: method === 'GET' ? { cookie } : { cookie, origin: WEB.publicUrl, 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
  const json = async <T>(res: Response | Promise<Response>, status = 200): Promise<T> => {
    const r = await res;
    if (r.status !== status) assert.fail(`HTTP ${r.status} (wanted ${status}): ${await r.text()}`);
    return r.json() as Promise<T>;
  };
  const game = () => json<GameState>(req('GET', '/api/servers/space/game'));
  return { app, req, json, game, notices, close, live: handle.live, agentPort: await handle.agentPort!, restarts: restarts!, cfg };
}

/** Waits up to 3 s for `cond`, without timers or Date (either may be mocked). */
export async function eventually(cond: () => boolean | Promise<boolean>) {
  const end = performance.now() + 3000;
  while (performance.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail('condition not met');
}

/**
 * The Agent (its connection as `version`, its service's state and what it runs pushed) and, while the unit is active,
 * its game connection.
 */
export async function agentUp(port: number, { unit = 'active', players = [] as string[], version = 'agent-v1.1.0' } = {}) {
  const agent = fakeMod(port);
  const got: { type: string; id: string }[] = [];
  createInterface({ input: agent.socket })
    .on('line', (line) => got.push(JSON.parse(line)))
    .on('error', () => {});
  agent.send({ type: 'agentHello', protocol: 1, agentId: 'vm', token: AGENT_TOKEN, agentVersion: version });
  assert.deepEqual(await agent.next(), { type: 'welcome' });
  agent.send({ type: 'serviceState', unit: 'factorio.service', active: unit, sub: unit === 'active' ? 'running' : 'dead', since: 1, result: 'success' });
  agent.send({ type: 'installed', factorio: '2.1.24', mods: INSTALLED });
  let game: ReturnType<typeof fakeMod> | undefined;
  if (unit === 'active') {
    game = fakeMod(port);
    game.send({ type: 'hello', protocol: 1, serverId: 'space', token: AGENT_TOKEN, modVersion: '0.1.0' });
    assert.deepEqual(await game.next(), { type: 'welcome' });
    game.send({ type: 'heartbeat', tps: 60, players });
  }
  /** Answers the Agent's next request (ok, or refused with `error`) and returns it. */
  const answer = async (error?: string) => {
    const r = (await agent.next()) as { id: string; type: string } & Record<string, unknown>;
    agent.send({ type: 'reply', id: r.id, ...(error === undefined ? { ok: true } : { ok: false, error }) });
    return r;
  };
  const step = (id: string, step: string, state: string, detail = '') => agent.send({ type: 'updateStep', id, step, state, detail });
  const done = (id: string, outcome: string, backup?: string) => agent.send({ type: 'updateDone', id, outcome, from: '2.1.24', to: '2.1.24', ...(backup && { backup }) });
  return { agent, gameConn: game, got, answer, step, done };
}

/** A hub with the Agent up and what it runs known. */
export async function ready(t: TestContext, o: Parameters<typeof agentUp>[1] = {}, hub: Parameters<typeof gameHub>[1] = {}) {
  const h = await gameHub(t, hub);
  const a = await agentUp(h.agentPort, o);
  await eventually(async () => (await h.game()).installed !== null && (o.unit === 'inactive' || (await h.json<ServerCard[]>(h.req('GET', '/api/servers'))).some((c) => c.id === 'space' && c.online && c.players.length === (o.players ?? []).length)));
  return { ...h, ...a };
}

// The deploy tests' shared setup (`test/updates/deploy*.test.ts`): GitHub's releases (`DAY`, `JARS`, `rel`,
// `RELEASES`) through a fake reader, a fake systemctl, a world (`world`: a temporary root, web dir and server folder with
// the old jar, and a config with GitHub, web and Minecraft on), a hub started on it and logged in (`start`), a fake Mod
// (`modRunning`), the status file a deploy unit writes (`status`) and the history's rows (`rows`).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { AuditLog, DeploysAnswer, LiveEvent, TargetEvent } from '../../src/api.ts';
import type { Config, ServerSettings } from '../../src/config.ts';
import type { GitHubRelease } from '../../src/updates/deploys.ts';
import type { RunRestore } from '../../src/backups/restore.ts';
import type { Run } from '../../src/services/services.ts';
import { startHub, type HubHandle } from '../../src/start.ts';
import type { WebApi } from '../../src/web/web.ts';
import { loginAs, WEB } from '../web/web-hub.ts';
import { fakeMod, hello, TOKEN } from '../fake-mod.ts';

export const DAY = 24 * 60 * 60_000;
export const JARS = (v: string) => [`gtnhdiscord-${v}.jar`, `gtnhdiscord-${v}-dev.jar`, `gtnhdiscord-${v}-sources.jar`];
export const rel = (tag: string, daysAgo: number, more: Partial<GitHubRelease> = {}): GitHubRelease => ({
  tag,
  draft: false,
  prerelease: false,
  publishedAt: Date.now() - daysAgo * DAY,
  assets: [],
  ...more,
});
export const RELEASES = [
  rel('hub-v2.6.0', 20),
  rel('hub-v2.7.0', 1),
  rel('hub-v2.5.1', 40),
  rel('hub-v2.8.0', 0, { draft: true }),
  rel('hub-v3.0.0', 0, { prerelease: true }),
  rel('web-v0.5.0', 2),
  rel('web-v0.4.1', 30),
  rel('mod-v1.4.0', 1, { assets: JARS('1.4.0') }),
  rel('mod-v1.3.0', 50, { assets: JARS('1.3.0') }),
  rel('v1.0.0', 1),
  rel('hub-v2.10.0-beta', 1),
];

/** A fake GitHub: `fails` makes listing fail, `downloadFails` the download; counts the listings. */
function fakeGitHub() {
  const fake = { list: RELEASES, fails: false, downloadFails: false, calls: 0, downloads: [] as string[], gate: Promise.resolve() };
  return Object.assign(fake, {
    releases: async () => {
      fake.calls++;
      if (fake.fails) throw new Error('GitHub: HTTP 503');
      return fake.list;
    },
    download: async (tag: string, asset: string) => {
      fake.downloads.push(`${tag} ${asset}`);
      await fake.gate;
      if (fake.downloadFails) throw new Error('GitHub: HTTP 404');
      return new TextEncoder().encode(`jar ${tag}`);
    },
  });
}

/** A fake systemctl: `states` holds each unit's ActiveState (default inactive); a start makes a unit activating. */
function fakeSystemd() {
  const states: Record<string, string> = { 'gtnh.service': 'inactive' };
  const calls: string[][] = [];
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    const unit = args.at(-1)!;
    if (args[0] === 'start') states[unit] = 'activating';
    return `ActiveState=${states[unit] ?? 'inactive'}\nSubState=dead\n`;
  };
  return { run, calls, states, starts: () => calls.filter((c) => c[1] === 'start').map((c) => c.at(-1)) };
}

type Setup = {
  servers?: (dir: string) => ServerSettings[];
  countdownMinutes?: number;
  restore?: RunRestore;
};

/** Makes the temporary root, web dir and server folder (with the old jar), and a config with GitHub, web and Minecraft on. */
export function world(t: TestContext, { servers, restore }: Setup = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-deploys-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'root');
  const serverDir = join(dir, 'gtnh');
  mkdirSync(join(serverDir, 'mods'), { recursive: true });
  mkdirSync(join(serverDir, 'backups'));
  mkdirSync(root);
  writeFileSync(join(serverDir, 'mods', 'gtnhdiscord-1.3.0.jar'), 'old jar');
  mkdirSync(join(serverDir, 'config'));
  writeFileSync(join(serverDir, 'config', 'gtnhdiscord.cfg'), 'token=old');
  writeFileSync(join(serverDir, 'backups', '2026-09-26-06-00-00.zip'), 'zip');
  const gtnh: ServerSettings = {
    id: 'gtnh',
    name: 'GTNH',
    game: 'minecraft',
    dir: serverDir,
    backupDir: join(serverDir, 'backups'),
    backupMinFreeGB: 10,
    lag: { tps: 15, minutes: 2, enabled: true },
    quests: 'batched',
    ...(restore && { service: 'gtnh' }),
  };
  const config: Config = {
    dbPath: join(root, 'hub.db'),
    servers: servers?.(dir) ?? [gtnh],
    integrations: {
      minecraft: { listenPort: 0, tokens: { gtnh: TOKEN } },
      web: WEB,
      github: {
        repo: 'Edward-Pratt/orrery',
        newerAfterDays: 14,
        deploys: { root, hubUnit: 'orrery-hub.service', hubTemplate: 'orrery-deploy', webTemplate: 'orrery-deploy-web', webDir: join(dir, 'www') },
      },
      ...(restore && { systemd: [{ id: 'gtnh', unit: 'gtnh.service' }] }),
    },
  };
  return { dir, root, serverDir, config, github: fakeGitHub(), systemd: fakeSystemd() };
}

export type World = ReturnType<typeof world>;

/** Starts a hub on a world, logs in, and waits for its first look at GitHub. */
export async function start(t: TestContext, w: World, setup: Setup = {}) {
  const handle: HubHandle = await startHub(w.config, {
    startFrontend: () => assert.fail('Discord is off'),
    get: () => assert.fail('nothing to request'),
    run: w.systemd.run,
    github: w.github,
    restore: setup.restore,
    deploys: { watchMs: 10, modTimeoutMs: 300, countdownMinutes: setup.countdownMinutes ?? 0 },
  });
  let closed = false;
  const close = () => (closed ? Promise.resolve() : ((closed = true), handle.close()));
  t.after(close);
  const notices: TargetEvent[] = [];
  handle.live.on('event', (_, { at: _at, ...e }: LiveEvent) => {
    if ('target' in e && e.target === 'deploy') notices.push(e);
  });
  const app: WebApi = handle.web!.app;
  const { cookie } = await loginAs(handle.web!);
  const get = async (path = '/api/deploys') => (await app.request(path, { headers: { cookie } })).json() as Promise<DeploysAnswer>;
  const post = (path: string, body?: object) =>
    app.request(path, { method: 'POST', headers: { cookie, origin: WEB.publicUrl, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const deploy = (body: object) => post('/api/deploys', body);
  const audit = async () =>
    ((await (await app.request('/api/audit', { headers: { cookie } })).json()) as AuditLog).entries
      .filter((e) => e.action === 'deploy')
      .map(({ actor, target, details }) => ({ actor, target, details }));
  while ((await get()).checkedAt === null) await new Promise((r) => setTimeout(r, 5));
  return { handle, app, get, post, deploy, audit, notices, close, port: handle.port! };
}

/** A fake Mod for server gtnh reporting `modVersion`; it stops (disconnects) when told to. */
export async function modRunning(port: number, modVersion: string) {
  const mod = fakeMod(port);
  mod.send({ ...hello(), modVersion });
  assert.deepEqual(await mod.next(), { type: 'welcome' });
  void (async () => {
    for (;;) {
      const msg = (await mod.next()) as { type: string; id: string; command: string };
      if (msg.type !== 'cmd') continue;
      if (msg.command === 'stop') return void mod.socket.end();
      mod.send({ type: 'cmdResult', id: msg.id, output: [] });
    }
  })();
  return mod;
}

export const status = (w: World, s: object) => writeFileSync(join(w.root, 'deploy-status.json'), JSON.stringify(s));
export const rows = async (s: Awaited<ReturnType<typeof start>>) =>
  (await s.get()).history.map(({ part, target, from, to, by, outcome, log }) => ({ part, target, from, to, by, outcome, log }));

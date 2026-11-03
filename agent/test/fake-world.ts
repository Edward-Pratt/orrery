// The Host every update-*.test.ts drives, with `fake-release.ts` (`tar`, a tar builder with GNU long names and pax
// headers; `fakeElf`, an ELF whose version needs ask for given `GLIBC_2.x`; `releaseTar`, a headless tarball of them):
// `world` builds a Host in a temp folder, a fake unit, a fake Factorio answering `/orrery-status` from the files while
// the unit is active (or not, for a `broken` version), real `Saves`, and factorio.com and the portal as injected
// routes (no network). `until` polls for a condition, `exists` for a path, and the constants name factorio.com's and
// the portal's URLs, signed as the real ones are.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AgentMsg, ServiceVerb } from '../../hub/src/types.ts';
import { HubClient } from '../src/hub.ts';
import { Saves } from '../src/saves.ts';
import type { UnitState } from '../src/service.ts';
import type { Status } from '../src/status.ts';
import { unpack } from '../src/unpack.ts';
import { installedOf, Updates, type Http, type InstalledMsg, type UpdatesOptions } from '../src/update.ts';
import type { Request } from '../src/wire.ts';
import { eventually } from './fake-hub.ts';
import { savedAs } from './fake-rcon.ts';
import { OWN_MODS, releaseTar, tar } from './fake-release.ts';

export const SUMS = 'https://www.factorio.com/download/sha256sums/';
export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
export const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');
export const tarball = (v: string) => `factorio-headless_linux_${v}.tar.xz`;
export const gameUrl = (v: string) => `https://www.factorio.com/get-download/${v}/headless/linux64`;
/** Where factorio.com's download redirects, signed: the query string must never show. */
export const signedGame = (v: string) => `https://dl.factorio.com/releases/${tarball(v)}?secure=SECRET-game,1761998400`;
export const modUrl = (name: string, version: string) => `https://dl-mod.factorio.com/files/${encodeURIComponent(name)}_${version}.zip?secure=SECRET-${name},1761998400`;
export const zip = (name: string, version: string) => Buffer.from(`PK zip of ${name} ${version}`);

export type Step = Extract<AgentMsg, { type: 'updateStep' }>;
export type Done = Extract<AgentMsg, { type: 'updateDone' }>;

/**
 * A Host for game updates in a temp folder: `/opt/factorio` with Factorio 2.1.24 (`current`), `/srv/factorio` with
 * a world save, `mods/` (orrery 0.1.0, its mod-list.json and a mod-settings.dat), the agent's `state/`, and setup's
 * `image.json` (glibc 2.39). A fake unit (`act` starts and stops it at once), a fake Factorio that, while the unit is
 * active, answers `/orrery-status` every 10 ms from the files (`current`, `mods/mod-list.json`, the zips) unless its
 * version is `broken`; real `Saves`; factorio.com and the mod portal as `routes` (nothing touches the network); and
 * `Updates` on all of it, sending into `sent`.
 */
export async function world(t: TestContext, o: Partial<UpdatesOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-update-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const install = join(dir, 'opt/factorio');
  const data = join(dir, 'srv/factorio');
  const state = join(dir, 'srv/orrery-agent/state');
  const image = join(dir, 'etc/orrery-agent/image.json');
  for (const d of [join(install, 'releases'), join(install, '.incoming'), join(data, 'saves'), join(data, 'mods'), join(data, '.incoming'), state, join(dir, 'etc/orrery-agent')]) {
    await mkdir(d, { recursive: true });
  }
  await writeFile(image, JSON.stringify({ image: 'container-registry.oracle.com/os/oraclelinux:10-slim@sha256:' + 'a'.repeat(64), glibc: '2.39' }));
  await unpack((async function* () { yield releaseTar('2.1.24'); })(), join(install, 'releases/2.1.24'));
  await symlink('releases/2.1.24', join(install, 'current'));
  await writeFile(join(data, 'saves/world.zip'), 'the world');
  await writeFile(join(data, 'mods/mod-list.json'), JSON.stringify({ mods: [...OWN_MODS, 'orrery'].map((name) => ({ name, enabled: true })) }));
  await writeFile(join(data, 'mods/orrery_0.1.0.zip'), zip('orrery', '0.1.0'));
  await writeFile(join(data, 'mods/mod-settings.dat'), 'startup settings v1');

  let since = 1000;
  const unit = {
    state: { unit: 'factorio.service', active: 'active', sub: 'running', since, result: 'success' } as UnitState,
    calls: [] as ServiceVerb[],
    /** `start` never returns: the agent dies there. */
    hang: false,
    read: async (): Promise<UnitState> => ({ ...unit.state }),
    act: async (verb: ServiceVerb): Promise<void> => {
      unit.calls.push(verb);
      if (verb === 'stop') unit.state = { ...unit.state, active: 'inactive', sub: 'dead', since: ++since };
      else {
        if (unit.hang) return new Promise(() => {});
        unit.state = { ...unit.state, active: 'active', sub: 'running', since: ++since };
      }
    },
  };

  /** Routes by URL as `new URL` writes it (the agent requests `href`s). */
  const routes = {
    map: new Map<string, Http>(),
    set: (url: string, route: Http) => routes.map.set(new URL(url).href, route),
    get: (url: string) => routes.map.get(new URL(url).href),
  };
  const sums = new Map<string, string>();
  const portal = new Map<string, { version: string; sha1: string }[]>();
  routes.set(SUMS, async () => new Response([...sums].map(([name, h]) => `${h}  ${name}`).join('\n') + '\n'));
  const w = {
    dir,
    install,
    data,
    state,
    image,
    unit,
    routes,
    requests: [] as string[],
    sent: [] as AgentMsg[],
    connected: true,
    /** Whether a delivered message's write succeeds (false: it failed, as on a connection that just dropped). */
    written: true,
    /** The latest `installed`, as `HubClient` keeps it: the fake Factorio's last answer. */
    installed: null as InstalledMsg | null,
    /** A deploy unit of the agent that hasn't ended (`Deploys.idle` rejects): null for none. */
    deploying: null as string | null,
    /** Versions the fake Factorio won't run (it crashes at start). */
    broken: new Set<string>(),
    statuses: 0,
    u: null as unknown as Updates,
    saves: null as unknown as Saves,
    http: (async (url, signal) => {
      w.requests.push(url);
      const route = routes.get(url);
      return route ? route(url, signal) : new Response('no such file', { status: 404 });
    }) as Http,
    /** Factorio `v` on factorio.com: in the sha256 list, behind a redirect to a signed link. */
    offer(v: string, file: Buffer = releaseTar(v)) {
      sums.set(tarball(v), sha256(file));
      routes.set(gameUrl(v), async () => new Response(null, { status: 302, headers: { location: signedGame(v) } }));
      routes.set(signedGame(v), async () => new Response(new Uint8Array(file)));
    },
    /** A mod release on the portal, its API and its signed download. */
    mod(name: string, version: string, file: Buffer = zip(name, version)) {
      portal.set(name, [...(portal.get(name) ?? []), { version, sha1: sha1(file) }]);
      routes.set(`https://mods.factorio.com/api/mods/${encodeURIComponent(name)}/full`, async () =>
        Response.json({ name, releases: portal.get(name)!.map((r) => ({ version: r.version, sha1: r.sha1, download_url: `/download/${name}/x` })) }),
      );
      routes.set(modUrl(name, version), async () => new Response(new Uint8Array(file)));
    },
    /** The hub's `update` for Factorio `v` and `mods`, with the hashes the lists hold. */
    request(v: string, mods: [string, string][], id = 'u1'): Request<'update'> {
      return {
        type: 'update',
        id,
        factorio: { version: v, url: gameUrl(v), sha256: sums.get(tarball(v)) ?? '0'.repeat(64) },
        mods: mods.map(([name, version]) => ({ name, version, url: modUrl(name, version), sha1: portal.get(name)?.find((r) => r.version === version)?.sha1 ?? '0'.repeat(40) })),
      };
    },
    steps: () => w.sent.filter((m): m is Step => m.type === 'updateStep'),
    step: (step: string, state: string) => eventually(() => w.steps().find((m) => m.step === step && m.state === state), 5000, `${step} ${state}`),
    done: () => eventually(() => w.sent.find((m): m is Done => m.type === 'updateDone'), 8000, 'updateDone'),
    options: null as unknown as UpdatesOptions,
    /** A new `Updates` on the same Host, as after a restart of the agent. */
    restart(): Updates {
      w.u.stop();
      w.u = new Updates(w.options);
      return w.u;
    },
  };
  w.saves = new Saves({
    dir: join(data, 'saves'),
    log: join(data, 'factorio-current.log'),
    run: async (command) => {
      const name = command.slice('/orrery-save '.length);
      await writeFile(join(data, 'saves', savedAs(name)), `save of ${await readlink(join(install, 'current'))}`);
      return JSON.stringify({ ok: true, name });
    },
    unit: () => unit.read(),
    pollMs: 10,
    stableMs: 30,
    waitMs: 2000,
  });
  w.options = {
    install,
    data,
    state,
    image,
    unit,
    saves: w.saves,
    send: (msg) => {
      if (!w.connected) return false;
      w.sent.push(msg);
      return true;
    },
    deliver: async (msg) => {
      if (!w.connected) return false;
      w.sent.push(msg);
      return w.written;
    },
    gameUp: () => w.connected && unit.state.active === 'active' && game !== null,
    connected: () => w.connected,
    installed: () => w.installed,
    idle: async () => {
      if (w.deploying) throw new Error(`a deploy is running (${w.deploying})`);
    },
    http: (url, signal) => w.http(url, signal),
    decompress: (file) => createReadStream(file), // the test tarballs are plain tar
    arch: 'x64',
    gateMs: 1500,
    stopWaitMs: 1000,
    pollMs: 10,
    ...o,
  };
  w.u = new Updates(w.options);

  // The fake Factorio: what runs is what the files say.
  let game: Status | null = null;
  let tick = 0;
  const running = async (): Promise<Status | null> => {
    const version = (await readlink(join(install, 'current'))).slice('releases/'.length);
    if (w.broken.has(version)) return null;
    const own: Record<string, string> = {};
    for (const name of await readdir(join(install, 'releases', version, 'data'))) {
      const info = JSON.parse(await readFile(join(install, 'releases', version, 'data', name, 'info.json'), 'utf8')) as { version: string };
      if (name !== 'core') own[name] = info.version;
    }
    const zips: Record<string, string> = {};
    for (const f of await readdir(join(data, 'mods'))) {
      const m = /^(.+)_(\d+\.\d+\.\d+)\.zip$/.exec(f);
      if (m) zips[m[1]!] = m[2]!;
    }
    const list = JSON.parse(await readFile(join(data, 'mods/mod-list.json'), 'utf8')) as { mods: { name: string; enabled: boolean }[] };
    const mods: Record<string, string> = {};
    for (const { name, enabled } of list.mods) {
      const v = own[name] ?? zips[name];
      if (!enabled) continue;
      if (v === undefined) return null; // Factorio stops at a missing mod
      mods[name] = v;
    }
    return { tick: (tick += 1), tickPaused: false, players: [], version, mods, modVersion: mods.orrery ?? '' };
  };
  const timer = setInterval(() => {
    if (unit.state.active !== 'active') return void (game = null);
    void running()
      .then((s) => {
        game = s;
        if (s) {
          w.statuses++;
          w.u.status(s);
          w.installed = installedOf(s);
        }
      })
      .catch(() => (game = null));
  }, 10);
  t.after(() => {
    clearInterval(timer);
    w.u.stop();
  });
  await eventually(() => w.statuses > 0, 2000, "the fake Factorio's first status");
  return w;
}

export const exists = (path: string) => lstat(path).then(() => true, () => false);

/** Waits until `fn` resolves to something other than undefined, null or false, polling every 5 ms; throws after `ms`. */
export async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 3000, what = 'the condition'): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v !== undefined && v !== null && v !== false) return v;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

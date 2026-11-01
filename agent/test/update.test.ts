import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseAgentLine } from '../../hub/src/protocol.ts';
import type { AgentMsg, ServiceVerb } from '../../hub/src/types.ts';
import { HubClient } from '../src/hub.ts';
import { AgentLog, logTo } from '../src/logs.ts';
import { Saves } from '../src/saves.ts';
import type { UnitState } from '../src/service.ts';
import type { Status } from '../src/status.ts';
import { compareGlibc, glibcNeed, Refused, unpack, unxz } from '../src/unpack.ts';
import { GAME_MODS as HUB_GAME_MODS } from '../../hub/src/factorio.ts';
import { ALLOWED_HOSTS, GAME_MODS, checkUpdate, installedOf, labels, Updates, type Http, type InstalledMsg, type UpdatesOptions } from '../src/update.ts';
import type { Request } from '../src/wire.ts';
import { eventually, fakeHub } from './fake-hub.ts';
import { fakeElf, OWN_MODS, releaseTar, tar, type Entry } from './fake-release.ts';

const SUMS = 'https://www.factorio.com/download/sha256sums/';
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const sha1 = (b: Buffer) => createHash('sha1').update(b).digest('hex');
const tarball = (v: string) => `factorio-headless_linux_${v}.tar.xz`;
const gameUrl = (v: string) => `https://www.factorio.com/get-download/${v}/headless/linux64`;
/** Where factorio.com's download redirects, signed: the query string must never show. */
const signedGame = (v: string) => `https://dl.factorio.com/releases/${tarball(v)}?secure=SECRET-game,1761998400`;
const modUrl = (name: string, version: string) => `https://dl-mod.factorio.com/files/${encodeURIComponent(name)}_${version}.zip?secure=SECRET-${name},1761998400`;
const zip = (name: string, version: string) => Buffer.from(`PK zip of ${name} ${version}`);

type Step = Extract<AgentMsg, { type: 'updateStep' }>;
type Done = Extract<AgentMsg, { type: 'updateDone' }>;

/**
 * A Host for game updates in a temp folder: `/opt/factorio` with Factorio 2.1.24 (`current`), `/srv/factorio` with
 * a world save, `mods/` (orrery 0.1.0, its mod-list.json and a mod-settings.dat), the agent's `state/`, and setup's
 * `image.json` (glibc 2.39). A fake unit (`act` starts and stops it at once), a fake Factorio that, while the unit is
 * active, answers `/orrery-status` every 10 ms from the files (`current`, `mods/mod-list.json`, the zips) unless its
 * version is `broken`; real `Saves`; factorio.com and the mod portal as `routes` (nothing touches the network); and
 * `Updates` on all of it, sending into `sent`.
 */
async function world(t: TestContext, o: Partial<UpdatesOptions> = {}) {
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
      await writeFile(join(data, 'saves', `${name}.zip`), `save of ${await readlink(join(install, 'current'))}`);
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

const exists = (path: string) => lstat(path).then(() => true, () => false);

/** Waits until `fn` resolves to something other than undefined, null or false, polling every 5 ms; throws after `ms`. */
async function until<T>(fn: () => Promise<T | undefined | null | false>, ms = 3000, what = 'the condition'): Promise<T> {
  const end = performance.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v !== undefined && v !== null && v !== false) return v;
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('a version of ../../x, a mod name with .., an http URL and an unlisted host are each refused', async (t) => {
  const w = await world(t);
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  const good = w.request('2.1.25', [['orrery', '0.2.0']]);
  assert.doesNotThrow(() => checkUpdate(good, 'x64'));
  const bad: [string, Request<'update'>, RegExp][] = [
    ['version ../../x', { ...good, factorio: { ...good.factorio, version: '../../x' } }, /"\.\.\/\.\.\/x" is not a Factorio version/],
    ['mod version ../../x', { ...good, mods: [{ ...good.mods[0]!, version: '../../x' }] }, /is not a version of orrery/],
    ['mod name with ..', { ...good, mods: [...good.mods, { ...good.mods[0]!, name: 'flib..x' }] }, /"flib\.\.x" is not a mod name/],
    ['mod name ..', { ...good, mods: [...good.mods, { ...good.mods[0]!, name: '..' }] }, /"\.\." is not a mod name/],
    ['mod name with a slash', { ...good, mods: [...good.mods, { ...good.mods[0]!, name: '../mods' }] }, /is not a mod name/],
    ['http URL', { ...good, factorio: { ...good.factorio, url: 'http://www.factorio.com/get-download/2.1.25/headless/linux64' } }, /is not https/],
    ['unlisted host', { ...good, mods: [{ ...good.mods[0]!, url: 'https://mods.example.com/orrery.zip?token=SECRET' }] }, /is on mods\.example\.com, not a host updates come from/],
    ['look-alike host', { ...good, factorio: { ...good.factorio, url: 'https://dl.factorio.com.example.net/x' } }, /not a host updates come from/],
    ['a port', { ...good, factorio: { ...good.factorio, url: 'https://dl.factorio.com:8443/x' } }, /names a port or a user/],
    ['a user', { ...good, factorio: { ...good.factorio, url: 'https://bob:pw@dl.factorio.com/x' } }, /names a port or a user/],
    ['no orrery', { ...good, mods: [] }, /must include orrery/],
    ['a bad sha256', { ...good, factorio: { ...good.factorio, sha256: 'ab' } }, /sha256 is not 64 hex/],
    ['a mod twice', { ...good, mods: [good.mods[0]!, good.mods[0]!] }, /in the mods twice/],
  ];
  for (const [what, req, why] of bad) {
    await assert.rejects(w.u.update(req), why, what);
    await assert.rejects(w.u.update(req), (err: Error) => !/SECRET|token=/.test(err.message), `${what}: no query string in the error`);
  }
  assert.deepEqual(ALLOWED_HOSTS, ['www.factorio.com', 'dl.factorio.com', 'dl-mod.factorio.com']);
  assert.equal(w.requests.length, 0, 'nothing downloaded');
  assert.equal(w.sent.length, 0);
  assert.equal(await exists(join(w.state, 'update.json')), false, 'nothing recorded');
  assert.throws(() => checkUpdate(good, 'riscv64'), /no Factorio headless build/);

  // A redirect to a host off the list: followed no further, prepare fails.
  w.routes.set(gameUrl('2.1.25'), async () => new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/f.tar.xz?secure=SECRET' } }));
  await w.u.update(good);
  const done = await w.done();
  assert.equal(done.outcome, 'failed in staging');
  const failed = await w.step('prepare', 'failed');
  assert.match(failed.detail, /redirect is on cdn\.example\.com, not a host updates come from/);
  assert.ok(!w.requests.some((u) => u.includes('cdn.example.com')), 'the redirect was not followed');
  assert.ok(!JSON.stringify(w.sent).includes('SECRET'));
});

test("a hash that differs from factorio.com's list, or the mod portal's, fails prepare before any download", async (t) => {
  const w = await world(t);
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  const req = w.request('2.1.25', [['orrery', '0.2.0']]);
  await w.u.update({ ...req, factorio: { ...req.factorio, sha256: 'b'.repeat(64) } });
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.match((await w.step('prepare', 'failed')).detail, /The hub's sha256 for factorio-headless_linux_2\.1\.25\.tar\.xz is not factorio\.com's/);
  assert.deepEqual(w.requests, [SUMS], 'only the sha256 list was read');
  assert.equal(await exists(join(w.install, 'releases/2.1.25')), false);
  assert.deepEqual(w.unit.calls, [], 'the server was left alone');

  w.sent.length = 0;
  w.requests.length = 0;
  await w.u.update({ ...req, id: 'u2', mods: [{ ...req.mods[0]!, sha1: 'c'.repeat(40) }] });
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.match((await w.step('prepare', 'failed')).detail, /The hub's sha1 for orrery 0\.2\.0 is not the mod portal's/);
  assert.ok(!w.requests.some((u) => u.startsWith('https://dl')), 'nothing downloaded');

  // A download that doesn't match the list it was checked against: refused after the download.
  w.sent.length = 0;
  w.routes.set(signedGame('2.1.25'), async () => new Response(new Uint8Array(releaseTar('2.1.25', { extra: [{ name: 'factorio/tampered', data: 'x' }] }))));
  await w.u.update({ ...req, id: 'u3' });
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.match((await w.step('prepare', 'failed')).detail, /doesn't match factorio\.com's sha256/);
  assert.deepEqual(await readdir(join(w.install, '.incoming')), []);
  assert.equal(await exists(join(w.install, 'releases/2.1.25')), false);
});

test('an update is refused while a deploy of the agent runs, before anything is written; not once it ended', async (t) => {
  const w = await world(t);
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  await w.u.start();
  w.deploying = 'orrery-agent-deploy@agent-v1.2.5.service is active';
  await assert.rejects(w.u.update(w.request('2.1.25', [['orrery', '0.2.0']])), /^Error: a deploy is running \(orrery-agent-deploy@agent-v1\.2\.5\.service is active\)$/);
  assert.equal(w.u.busy, false);
  assert.equal(await exists(join(w.state, 'update.json')), false);
  assert.deepEqual([w.requests, w.sent], [[], []]);
  w.deploying = null;
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  await w.u.cancel();
  assert.equal((await w.done()).outcome, 'cancelled');
});

test("an updateDone whose write failed stays pending: update.json kept, sent again on each connect until a write succeeds, refusing a new update meanwhile", async (t) => {
  const w = await world(t);
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  w.written = false; // the connection drops as the updateDone goes out
  await w.u.cancel();
  const done = await w.done();
  assert.equal(done.outcome, 'cancelled');
  await sleep(50);
  assert.equal(JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).outcome, 'cancelled', 'kept');
  await assert.rejects(w.u.update(w.request('2.1.25', [['orrery', '0.2.0']], 'u2')), /the update u1 has not been reported yet/);

  w.u.connected(); // a reconnect whose write fails too
  await eventually(() => w.sent.filter((m) => m.type === 'updateDone').length === 2, 2000, 'sent again');
  await sleep(50);
  assert.ok(await exists(join(w.state, 'update.json')));

  w.written = true;
  w.u.connected();
  await until(async () => !(await exists(join(w.state, 'update.json'))), 2000, 'update.json removed once a write succeeded');
  const dones = w.sent.filter((m) => m.type === 'updateDone');
  assert.equal(dones.length, 3);
  for (const d of dones) assert.deepEqual(d, done, 'the same each time: the hub ignores a repeat');
  w.u.connected();
  await sleep(50);
  assert.equal(w.sent.filter((m) => m.type === 'updateDone').length, 3, 'not again once written');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']], 'u2'));
  await eventually(() => w.steps().find((m) => m.id === 'u2' && m.step === 'stop'), 5000, "u2's stop");
  await w.u.cancel();
  await eventually(() => w.sent.find((m) => m.type === 'updateDone' && m.id === 'u2'), 5000, "u2's updateDone");
});

test('a binary needing a newer glibc than the image fails at prepare', async (t) => {
  const w = await world(t);
  w.offer('2.1.30', releaseTar('2.1.30', { glibc: ['GLIBC_2.17', 'GLIBC_2.41', 'GLIBC_2.38'] }));
  w.mod('orrery', '0.2.0');
  await w.u.update(w.request('2.1.30', [['orrery', '0.2.0']]));
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.match(
    (await w.step('prepare', 'failed')).detail,
    /^Factorio 2\.1\.30 needs glibc 2\.41; the friend must re-run setup with a newer image \(it has glibc 2\.39\)$/,
  );
  assert.equal(await exists(join(w.install, 'releases/2.1.30')), false, 'never a release');
  assert.deepEqual(await readdir(join(w.install, '.incoming')), [], 'nothing left in .incoming');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');

  // The reader itself: the highest GLIBC_X.Y, compared as numbers, in 64-bit LE and 32-bit BE files.
  const elf = join(w.dir, 'elf');
  await writeFile(elf, fakeElf(['GLIBC_2.4', 'GLIBC_2.38', 'GLIBC_2.17', 'GLIBC_PRIVATE', 'GLIBC_2.38.1']));
  assert.equal(await glibcNeed(elf), '2.38');
  await writeFile(elf, fakeElf(['GLIBC_2.9', 'GLIBC_2.10'], { wide: false, le: false }));
  assert.equal(await glibcNeed(elf), '2.10');
  await writeFile(elf, fakeElf([]));
  assert.equal(await glibcNeed(elf), null);
  await writeFile(elf, '#!/bin/sh\necho not an ELF\n'.repeat(4));
  await assert.rejects(glibcNeed(elf), /not a well-formed ELF/);
  assert.ok(compareGlibc('2.4', '2.38') < 0 && compareGlibc('2.41', '2.39') > 0 && compareGlibc('3.0', '2.99') > 0);
});

test('an update while the server runs: a pre-update save, the hub stops it, the swap, the gate; mod-settings.dat survives', async (t) => {
  const w = await world(t);
  for (const v of ['2.1.21', '2.1.22', '2.1.23']) await mkdir(join(w.install, 'releases', v, 'data'), { recursive: true });
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.mod('flib', '0.16.2');
  w.mod('Squeak Through', '1.8.2');
  await w.u.start();
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2'], ['Squeak Through', '1.8.2']]));
  await assert.rejects(w.u.update(w.request('2.1.25', [['orrery', '0.2.0']], 'u2')), /the update u1 is running/);
  await assert.rejects(w.u.resume(), /is not waiting for the server to stop/);

  await w.step('stop', 'waiting');
  const prepared = await w.step('prepare', 'done');
  assert.equal(prepared.detail, 'Staged Factorio 2.1.25 and 3 mods, mod-settings.dat carried over');
  const backup = await w.step('backup', 'done');
  assert.match(backup.detail, /^Saved orrery-pre-update-2\.1\.24-\d{8}T\d{6}Z\.zip$/);
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24', 'nothing swapped before the stop');
  assert.ok(await exists(join(w.install, 'releases/2.1.25/bin/x64/factorio')));
  assert.equal(JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).phase, 'stop', 'the bookkeeping is in the agent state folder');
  assert.equal(await exists(join(w.data, 'update.json')), false, 'never under the data folder');

  // The hub's stop, with its countdown, then updateResume. Factorio writes its settings as it stops.
  await w.unit.act('stop');
  await writeFile(join(w.data, 'mods/mod-settings.dat'), 'startup settings v2');
  await w.u.resume();
  const done = await w.done();
  // Counted as the hub counts them: every enabled mod, the game's own (base, space-age) included.
  assert.deepEqual(done, { type: 'updateDone', id: 'u1', outcome: 'ok', from: '2.1.24 · 3 mods', to: '2.1.25 · 5 mods', backup: done.backup });
  assert.match(done.backup!, /^orrery-pre-update-2\.1\.24-\d{8}T\d{6}Z\.zip$/);
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.25');
  assert.deepEqual((await readdir(join(w.data, 'mods'))).sort(), ['Squeak Through_1.8.2.zip', 'flib_0.16.2.zip', 'mod-list.json', 'mod-settings.dat', 'orrery_0.2.0.zip']);
  assert.equal(await readFile(join(w.data, 'mods/mod-settings.dat'), 'utf8'), 'startup settings v2', 'mod-settings.dat survives the swap');
  assert.deepEqual(JSON.parse(await readFile(join(w.data, 'mods/mod-list.json'), 'utf8')).mods.map((m: { name: string }) => m.name), ['base', 'space-age', 'orrery', 'flib', 'Squeak Through']);
  assert.ok(await exists(join(w.data, 'mods.prev/orrery_0.1.0.zip')), 'the old mods kept as mods.prev');
  assert.deepEqual(w.unit.calls, ['stop', 'start'], 'the hub stopped it; the agent started it');
  assert.deepEqual(
    w.steps().filter((m) => m.state !== 'running').map((m) => `${m.step} ${m.state}`),
    ['prepare done', 'backup done', 'stop waiting', 'swap done', 'gate done'],
  );
  assert.deepEqual(new Set(w.steps().filter((m) => m.step === 'stop').map((m) => m.state)), new Set(['waiting']), "the stop is the hub's: its step is only ever waiting");
  assert.ok(w.steps().some((m) => m.step === 'swap' && m.state === 'running' && m.detail === 'Checking that the server is stopped'));
  assert.deepEqual((await readdir(join(w.install, 'releases'))).sort(), ['2.1.23', '2.1.24', '2.1.25'], 'the newest 3 releases kept');
  assert.deepEqual(await readdir(join(w.install, '.incoming')), []);
  assert.deepEqual(await readdir(join(w.data, '.incoming')), []);
  await until(async () => !(await exists(join(w.state, 'update.json'))), 2000, 'update.json removed once reported');
  for (const m of w.sent) assert.ok(parseAgentLine(JSON.stringify(m)), `the hub takes ${JSON.stringify(m)}`);
  assert.ok(!JSON.stringify(w.sent).includes('SECRET'));
});

test("the game's own mods keep their enabled state from the current mod-list.json; one new in the release is enabled; the gate expects exactly that", async (t) => {
  const w = await world(t);
  // space-age off by hand; a mod the update drops listed too.
  const list = { mods: [{ name: 'base', enabled: true }, { name: 'space-age', enabled: false }, { name: 'orrery', enabled: true }, { name: 'old-mod', enabled: false }] };
  await writeFile(join(w.data, 'mods/mod-list.json'), JSON.stringify(list));
  await eventually(() => w.installed && w.installed.mods.length === 2, 2000, 'installed without space-age');
  // 2.1.25 ships one more of the game's own mods.
  const info = JSON.stringify({ name: 'quality', version: '2.1.25', title: 'quality' });
  w.offer('2.1.25', releaseTar('2.1.25', { extra: [{ name: 'factorio/data/quality/info.json', data: info }] }));
  w.mod('orrery', '0.2.0');
  w.mod('flib', '0.16.2');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']]));
  await w.step('stop', 'waiting');
  const staged = JSON.parse(await readFile(join(w.data, 'mods.next/mod-list.json'), 'utf8'));
  assert.deepEqual(staged.mods, [
    { name: 'base', enabled: true },
    { name: 'quality', enabled: true },
    { name: 'space-age', enabled: false },
    { name: 'orrery', enabled: true },
    { name: 'flib', enabled: true },
  ]);
  assert.deepEqual(JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).expect, { base: '2.1.25', quality: '2.1.25', orrery: '0.2.0', flib: '0.16.2' });
  await w.unit.act('stop');
  await w.u.resume();
  const done = await w.done();
  assert.equal(done.outcome, 'ok', JSON.stringify(w.steps().at(-1)));
  // As the hub names its row: the game's own mods enabled in the latest installed (base), and the update's.
  assert.deepEqual([done.from, done.to], ['2.1.24 · 2 mods', '2.1.25 · 3 mods']);
  assert.match((await w.step('gate', 'done')).detail, /exactly its 4 mods/);
  await eventually(() => w.installed?.factorio === '2.1.25', 2000, 'installed after the update');
  assert.deepEqual(w.installed!.mods.map((m) => m.name), ['base', 'flib', 'orrery', 'quality'], 'installed reports what runs: no space-age');
});

test("a current mod-list.json that isn't Factorio's list fails prepare: nothing changed", async (t) => {
  const w = await world(t);
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  for (const bad of ['not json', JSON.stringify({ mods: [{ name: 'space-age', enabled: 'no' }] }), JSON.stringify([])]) {
    await writeFile(join(w.data, 'mods/mod-list.json'), bad);
    w.sent.length = 0;
    await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
    const done = await w.done();
    assert.equal(done.outcome, 'failed in staging');
    assert.match((await w.step('prepare', 'failed')).detail, /^mods\/mod-list\.json is not Factorio's mod list/);
    assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
    assert.equal(await readFile(join(w.data, 'mods/mod-list.json'), 'utf8'), bad, 'left as it was');
    assert.equal(await exists(join(w.data, 'mods.next')), false);
    assert.deepEqual(w.unit.calls, [], 'the server never stopped');
    await until(async () => !(await exists(join(w.state, 'update.json'))), 2000, 'reported');
  }
  // A symlink in its place is not followed.
  await rm(join(w.data, 'mods/mod-list.json'));
  await writeFile(join(w.dir, 'elsewhere.json'), JSON.stringify({ mods: [] }));
  await symlink(join(w.dir, 'elsewhere.json'), join(w.data, 'mods/mod-list.json'));
  w.sent.length = 0;
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.equal((await w.step('prepare', 'failed')).detail, 'mods/mod-list.json is not a regular file');
});

test('a gate failure rolls back to the old release, mods.prev with its mod-settings.dat, and the pre-update save', async (t) => {
  const w = await world(t, { gateMs: 300 });
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.broken.add('2.1.25');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  await w.unit.act('stop');
  // Factorio saves into the world it loaded as it stops: newer than the pre-update save.
  await writeFile(join(w.data, 'saves/world.zip'), 'the world, saved at the stop');
  await w.u.resume();
  const done = await w.done();
  assert.equal(done.outcome, 'rolled back');
  assert.match((await w.step('gate', 'failed')).detail, /^Not up within \d+ s: no \/orrery-status answer$/);
  assert.match((await w.step('rollback', 'done')).detail, /^Back on Factorio 2\.1\.24 with its mods, orrery-pre-update-2\.1\.24-\S+\.zip copied as the newest save$/);
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24', 'the old release');
  assert.deepEqual((await readdir(join(w.data, 'mods'))).sort(), ['mod-list.json', 'mod-settings.dat', 'orrery_0.1.0.zip'], 'the old mods');
  assert.equal(await readFile(join(w.data, 'mods/mod-settings.dat'), 'utf8'), 'startup settings v1', 'mod-settings.dat survives the rollback');
  assert.equal(await exists(join(w.data, 'mods.prev')), false);
  assert.equal(await exists(join(w.data, 'mods.next')), false);
  // The pre-update save, copied as the newest: --start-server-load-latest loads it.
  const saves = await w.saves.list();
  assert.equal(saves.saves[0]!.name, `restored-${saves.saves[0]!.name.split('-')[1]}-${done.backup}`);
  assert.equal(await readFile(join(w.data, 'saves', saves.saves[0]!.name), 'utf8'), 'save of releases/2.1.24');
  assert.ok(saves.saves[0]!.mtime > (await stat(join(w.data, 'saves/world.zip'))).mtimeMs);
  assert.deepEqual(w.unit.calls, ['stop', 'start', 'stop', 'start']);
  for (const m of w.sent) assert.ok(parseAgentLine(JSON.stringify(m)), `the hub takes ${JSON.stringify(m)}`);
});

test('a restart of the agent mid-swap rolls back from state/update.json', async (t) => {
  const w = await world(t);
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.mod('flib', '0.16.2');
  w.unit.hang = true; // the agent dies as it starts the new Factorio
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']]));
  await w.step('stop', 'waiting');
  await w.unit.act('stop');
  await w.u.resume();
  await eventually(() => w.unit.calls.includes('start') || null, 3000, 'the swap to start the server');
  assert.equal(JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).phase, 'gate');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.25', 'swapped');

  w.unit.hang = false;
  w.sent.length = 0;
  const u = w.restart();
  await u.start();
  const done = await w.done();
  assert.equal(done.outcome, 'rolled back');
  assert.equal(done.id, 'u1');
  assert.match((await w.step('gate', 'failed')).detail, /The agent restarted before the health gate passed/);
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
  assert.deepEqual((await readdir(join(w.data, 'mods'))).sort(), ['mod-list.json', 'mod-settings.dat', 'orrery_0.1.0.zip']);
  assert.equal(await readFile(join(w.data, 'mods/mod-settings.dat'), 'utf8'), 'startup settings v1');
  assert.match((await w.saves.list()).saves[0]!.name, /^restored-\d{8}T\d{6}Z-orrery-pre-update-2\.1\.24-/);
  assert.equal(w.unit.state.active, 'active');
  await until(async () => !(await exists(join(w.state, 'update.json'))), 2000, 'update.json removed once reported');

  // Not connected when it ends: the updateDone waits for the next connect.
  const before = w.sent.length;
  w.connected = false;
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']], 'u2'));
  await until(async () => JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).phase === 'stop', 5000, 'u2 at its stop');
  await w.u.cancel();
  await until(async () => JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).phase === 'done', 3000, 'u2 done');
  assert.equal(w.sent.length, before, 'nothing sent while not connected');
  w.connected = true;
  w.u.connected();
  const late = w.sent.slice(before);
  assert.deepEqual(late.map((m) => m.type), ['updateDone']);
  assert.equal((late[0] as Done).outcome, 'cancelled');
});

test('a planted /srv/factorio/update.json is ignored', async (t) => {
  const w = await world(t);
  const planted = {
    id: 'evil',
    factorio: '2.1.25',
    mods: [],
    expect: null,
    from: { factorio: '2.1.20', mods: null, count: null },
    previous: 'releases/2.1.20',
    backup: 'world.zip',
    phase: 'gate',
    outcome: null,
    resumed: true,
  };
  await writeFile(join(w.data, 'update.json'), JSON.stringify(planted));
  await mkdir(join(w.data, 'state'));
  await writeFile(join(w.data, 'state/update.json'), JSON.stringify(planted));
  await w.u.start();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(w.sent, [], 'no step, no updateDone');
  assert.deepEqual(w.unit.calls, [], 'the server untouched');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
  assert.equal(await readFile(join(w.data, 'update.json'), 'utf8'), JSON.stringify(planted), 'not even removed');
  assert.equal(w.u.busy, false);

  // The agent's own file in another shape is no update either: removed, nothing done.
  await writeFile(join(w.state, 'update.json'), JSON.stringify({ ...planted, previous: '../../etc' }));
  await w.restart().start();
  assert.equal(await exists(join(w.state, 'update.json')), false);
  assert.deepEqual(w.unit.calls, []);
});

test('a failing download leaves no query string in step details or agent.log', async (t) => {
  const w = await world(t);
  const log = join(w.dir, 'agent.log');
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const out: string[] = [];
  t.after(() => Object.assign(console, original));
  for (const level of ['log', 'info', 'warn', 'error'] as const) console[level] = (...args: unknown[]) => void out.push(args.join(' '));
  logTo(new AgentLog(log));

  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.mod('flib', '0.16.2');
  // The mod's CDN fails with an error naming the signed link, as an HTTP client's might.
  w.routes.set(modUrl('flib', '0.16.2'), async () => {
    throw new TypeError('fetch failed', { cause: new Error(`connect ECONNREFUSED for ${modUrl('flib', '0.16.2')}`) });
  });
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']]));
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.equal((await w.step('prepare', 'failed')).detail, "Can't download https://dl-mod.factorio.com/files/flib_0.16.2.zip: connect ECONNREFUSED for https://dl-mod.factorio.com/files/flib_0.16.2.zip");

  // The game's signed link, after factorio.com's redirect, answering 403.
  w.sent.length = 0;
  w.offer('2.1.26');
  w.routes.set(signedGame('2.1.26'), async () => new Response('expired', { status: 403 }));
  await w.u.update(w.request('2.1.26', [['orrery', '0.2.0']], 'u2'));
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.equal((await w.step('prepare', 'failed')).detail, 'https://dl.factorio.com/releases/factorio-headless_linux_2.1.26.tar.xz answered HTTP 403');

  Object.assign(console, original);
  const written = await readFile(log, 'utf8');
  assert.match(written, /prepare failed: Can't download https:\/\/dl-mod\.factorio\.com\/files\/flib_0\.16\.2\.zip/);
  for (const [what, text] of [['steps', JSON.stringify(w.sent)], ['agent.log', written], ['the journal', out.join('\n')]] as const) {
    assert.ok(!/SECRET|secure=|\?/.test(text), `no query string in ${what}: ${text}`);
  }
  assert.deepEqual(await readdir(join(w.data, '.incoming')), []);
});

test('an archive entry escaping the target is refused, and so is the release', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-unpack-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chunks = (b: Buffer) =>
    (async function* () {
      for (let i = 0; i < b.length; i += 700) yield b.subarray(i, i + 700); // headers split across chunks
    })();
  let n = 0;
  const into = async (entries: Entry[]) => {
    const target = join(dir, `t${n++}`);
    await mkdir(target);
    await unpack(chunks(tar([{ name: 'factorio/' }, ...entries])), target);
    return target;
  };
  const refused: [string, Entry[], RegExp][] = [
    ['a .. path', [{ name: 'factorio/../../evil', data: 'x' }], /leads out of the release/],
    ['an absolute path', [{ name: '/etc/evil', data: 'x' }], /is an absolute path/],
    ['a symlink out', [{ name: 'factorio/out', type: '2', link: '../../../etc' }], /the symlink out leads out of the release/],
    ['an absolute symlink', [{ name: 'factorio/abs', type: '2', link: '/etc/passwd' }], /points at an absolute path/],
    ['a write through a symlink', [{ name: 'factorio/sub/', type: '5' }, { name: 'factorio/l', type: '2', link: 'sub' }, { name: 'factorio/l/x', data: 'x' }], /below a symlink of the archive/],
    ['a chain of symlinks out', [{ name: 'factorio/a/', type: '5' }, { name: 'factorio/b', type: '2', link: 'a/c/../..' }, { name: 'factorio/a/c', type: '2', link: '..' }], /leads out of the release, or nowhere/],
    ['a hard link to a path outside', [{ name: 'factorio/h', type: '1', link: '/etc/passwd' }], /is an absolute path/],
    ['a hard link to nothing unpacked', [{ name: 'factorio/h', type: '1', link: 'factorio/missing' }], /not to a file unpacked before it/],
    ['a device', [{ name: 'factorio/dev', type: '3' }], /a kind of entry a release never has/],
    ['a FIFO', [{ name: 'factorio/fifo', type: '6' }], /a kind of entry a release never has/],
    ['a pax path out', [{ name: 'factorio/fine', data: 'x', pax: { path: 'factorio/../../evil' } }], /leads out of the release/],
    ['a file outside the top folder', [{ name: 'top-level-file', data: 'x' }], /is not in the release's folder/],
    ['a file there twice', [{ name: 'factorio/x', data: 'a' }, { name: 'factorio/x', data: 'b' }], /EEXIST/],
  ];
  for (const [what, entries, why] of refused) await assert.rejects(into(entries), why, what);
  assert.deepEqual((await readdir(dir)).filter((f) => !f.startsWith('t')), [], 'nothing written outside the targets');
  const corrupt = tar([{ name: 'factorio/x', data: 'x' }]);
  corrupt[150] ^= 1;
  await assert.rejects(unpack(chunks(corrupt), await mkdtemp(join(dir, 'c'))), Refused);
  await assert.rejects(unpack(chunks(tar([{ name: 'factorio/x', data: 'x'.repeat(2000) }]).subarray(0, 1536)), await mkdtemp(join(dir, 'c'))), /ends in the middle/);

  // What a real tarball has unpacks: long names, pax paths, links inside, modes.
  const long = `factorio/data/base/graphics/${'entity/'.repeat(14)}sprite.png`;
  const ok = await into([
    { name: long, data: 'png' },
    { name: 'factorio/pax-name', data: 'p', pax: { path: 'factorio/data/ünïcode name.txt' } },
    { name: 'factorio/bin/x64/factorio', data: 'elf', mode: 0o755 },
    { name: 'factorio/bin/current', type: '2', link: 'x64' },
    { name: 'factorio/bin/again', type: '1', link: 'factorio/bin/x64/factorio' },
  ]);
  assert.equal(await readFile(join(ok, long.slice('factorio/'.length)), 'utf8'), 'png');
  assert.equal(await readFile(join(ok, 'data/ünïcode name.txt'), 'utf8'), 'p');
  assert.equal((await stat(join(ok, 'bin/x64/factorio'))).mode & 0o777, 0o755);
  assert.equal(await readlink(join(ok, 'bin/current')), 'x64');
  assert.equal(await readFile(join(ok, 'bin/again'), 'utf8'), 'elf');

  // A tarball from factorio.com's list with such an entry: prepare fails, no release, nothing left behind.
  const w = await world(t);
  w.offer('2.1.25', releaseTar('2.1.25', { extra: [{ name: 'factorio/../../../srv/orrery-agent/state/update.json', data: '{}' }] }));
  w.mod('orrery', '0.2.0');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.match((await w.step('prepare', 'failed')).detail, /^Factorio 2\.1\.25's tarball is refused: .* leads out of the release$/);
  assert.equal(await exists(join(w.install, 'releases/2.1.25')), false);
  assert.deepEqual(await readdir(join(w.install, '.incoming')), []);
});

test('updateCancel before the swap cleans .incoming; after it, it is refused', async (t) => {
  const w = await world(t);
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.mod('flib', '0.16.2');
  // flib's download sends a little, then hangs until the agent gives up on it.
  w.routes.set(modUrl('flib', '0.16.2'), async (_url, signal) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(1000));
        signal.addEventListener('abort', () => c.error(signal.reason));
      },
    });
    return new Response(body);
  });
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']]));
  await until(async () => (await readdir(join(w.data, '.incoming'))).includes('flib_0.16.2.zip'), 3000, 'the download under way');
  assert.ok(await exists(join(w.data, 'mods.next/orrery_0.2.0.zip')), 'orrery staged');
  await w.u.cancel();
  const done = await w.done();
  assert.deepEqual(done, { type: 'updateDone', id: 'u1', outcome: 'cancelled', from: '2.1.24 · 3 mods', to: '2.1.25 · 4 mods' });
  assert.equal((await w.step('prepare', 'failed')).detail, 'Cancelled by the hub');
  assert.deepEqual(await readdir(join(w.data, '.incoming')), [], "the data folder's .incoming is clean");
  assert.deepEqual(await readdir(join(w.install, '.incoming')), [], "the install folder's .incoming is clean");
  assert.equal(await exists(join(w.data, 'mods.next')), false);
  assert.deepEqual((await readdir(join(w.data, 'mods'))).sort(), ['mod-list.json', 'mod-settings.dat', 'orrery_0.1.0.zip'], 'mods untouched');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
  assert.deepEqual(w.unit.calls, []);

  // Cancelled while it waits for the hub's stop: the same; then once swapped, too late.
  w.sent.length = 0;
  w.routes.set(modUrl('flib', '0.16.2'), async () => new Response(new Uint8Array(zip('flib', '0.16.2'))));
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']], 'u2'));
  await w.step('stop', 'waiting');
  await w.u.cancel();
  assert.equal((await w.done()).outcome, 'cancelled');
  assert.equal(await exists(join(w.data, 'mods.next')), false);
  assert.deepEqual(w.unit.calls, []);
  assert.ok(!w.steps().some((m) => m.step === 'stop' && m.state !== 'waiting'), "the stop is the hub's: its end is not a step");

  // Cancelled after updateResume, while the agent checks the stop (the hub giving up): it never starts or stops the
  // unit, as the hub starts a server it stopped itself.
  w.sent.length = 0;
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']], 'u2b'));
  await w.step('stop', 'waiting');
  w.unit.state = { ...w.unit.state, active: 'deactivating', sub: 'stop-sigterm' };
  await w.u.resume();
  await w.step('swap', 'running');
  await w.u.cancel();
  w.unit.state = { ...w.unit.state, active: 'inactive', sub: 'dead' };
  assert.equal((await w.done()).outcome, 'cancelled');
  assert.deepEqual(w.unit.calls, [], 'a cancel never starts or stops the unit');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
  await w.unit.act('start');

  w.sent.length = 0;
  w.broken.add('2.1.25');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']], 'u3'));
  await w.step('stop', 'waiting');
  await w.unit.act('stop');
  await w.u.resume();
  await w.step('gate', 'running');
  await assert.rejects(w.u.cancel(), /past the swap: too late to cancel/);
  assert.equal((await w.done()).outcome, 'rolled back');
});

test('an update on a stopped server keeps the newest save for a rollback', async (t) => {
  const w = await world(t);
  await w.unit.act('stop');
  w.unit.calls.length = 0;
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  assert.equal((await w.step('backup', 'done')).detail, 'The server is stopped: no save made; a rollback loads world.zip, the newest');
  await w.step('stop', 'waiting');
  await w.u.resume();
  const done = await w.done();
  assert.equal(done.outcome, 'ok');
  assert.equal(done.backup, 'world.zip');
  assert.equal(done.from, '2.1.24 · 3 mods');
  assert.equal(done.to, '2.1.25 · 3 mods');
  assert.deepEqual(w.unit.calls, ['start']);
  assert.deepEqual((await w.saves.list()).saves.map((s) => s.name), ['world.zip'], 'no save made');
});

test("updateDone's from and to as the hub names its row: every enabled mod, the game's own included, from the latest installed", async (t) => {
  assert.deepEqual([...GAME_MODS].sort(), [...HUB_GAME_MODS].sort(), "the hub's list of the game's own mods");
  // docs/protocol.md's example, and a server with its game mods partly off.
  const mods = (...names: string[]) => names.map((name) => ({ name, version: '1.0.0' }));
  const req = (n: number): Request<'update'> => ({
    type: 'update',
    id: 'u',
    factorio: { version: '2.1.25', url: '', sha256: '' },
    mods: Array.from({ length: n }, (_, i) => ({ name: `m${i}`, version: '1.0.0', sha1: '', url: '' })),
  });
  assert.deepEqual(labels({ factorio: '2.1.24', mods: mods('base', 'elevated-rails', 'quality', 'space-age', 'orrery') }, '2.1.24', req(2)), { from: '2.1.24 · 5 mods', to: '2.1.25 · 6 mods' });
  assert.deepEqual(labels({ factorio: '2.1.24', mods: mods('base') }, '2.1.24', req(1)), { from: '2.1.24 · 1 mod', to: '2.1.25 · 2 mods' });
  assert.deepEqual(labels(null, '2.1.24', req(1)), { from: '2.1.24', to: '2.1.25' }, 'nothing to count yet');

  // A restarted agent with its server stopped: no /orrery-status answer, but the installed it kept names the from.
  const w = await world(t);
  await w.unit.act('stop');
  w.restart();
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.mod('flib', '0.16.2');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0'], ['flib', '0.16.2']]));
  await w.step('stop', 'waiting');
  await w.u.cancel();
  const done = await w.done();
  assert.deepEqual([done.from, done.to], ['2.1.24 · 3 mods', '2.1.25 · 4 mods']);
});

test('steps go out at most once per second per step unless their state changes, and again on connect', async (t) => {
  const sentAt: [number, Step][] = [];
  const w = await world(t, { stepMs: 200 });
  const send = w.options.send;
  w.u = new Updates({ ...w.options, send: (m) => (m.type === 'updateStep' && sentAt.push([performance.now(), m]), send(m)) });
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  // A slow download: 30 chunks, 20 ms apart.
  const file = zip('orrery', '0.2.0');
  w.routes.set(modUrl('orrery', '0.2.0'), async () => {
    let i = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(c) {
          await new Promise((r) => setTimeout(r, 20));
          if (i < file.length) c.enqueue(file.subarray(i, (i += 1)));
          else c.close();
        },
      }),
    );
  });
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  const prepare = sentAt.filter(([, m]) => m.step === 'prepare' && m.state === 'running');
  assert.ok(prepare.length >= 2, 'progress went out');
  for (let i = 1; i < prepare.length; i++) assert.ok(prepare[i]![0] - prepare[i - 1]![0] >= 190, `${prepare[i]![0] - prepare[i - 1]![0]} ms apart`);
  assert.ok(prepare.length < 10, `not one per chunk: ${prepare.length}`);
  const latest = w.sent.at(-1);
  w.sent.length = 0;
  w.u.connected();
  assert.deepEqual(w.sent, [latest], 'the latest step again on connect');
  await w.u.cancel();
  await w.done();
});

test('HubClient sends installed on connect and on change, and update messages only while connected', async (t) => {
  const hub = await fakeHub();
  t.after(() => hub.close());
  const dir = await mkdtemp(join(tmpdir(), 'orrery-installed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let welcomes = 0;
  const client = new HubClient({
    config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server: {} as never, token: 't'.repeat(32), root: dir, state: join(dir, 'state') },
    version: 'agent-v0.0.0',
    welcomed: () => welcomes++,
    backoffMs: 10,
  });
  t.after(() => client.stop());
  const step: AgentMsg = { type: 'updateStep', id: 'u1', step: 'prepare', state: 'running', detail: 'x' };
  assert.equal(client.send(step), false, 'not connected');
  const installed = { factorio: '2.1.24', mods: [{ name: 'base', version: '2.1.24' }, { name: 'orrery', version: '0.1.0' }] };
  client.installed(installed);
  client.start();
  const [conn] = await eventually(() => hub.of('agentHello').length === 1 && hub.of('agentHello'));
  await eventually(() => conn!.lines.some((l) => l.type === 'installed'));
  assert.equal(welcomes, 1);
  client.installed({ ...installed, mods: [...installed.mods] });
  assert.equal(client.send(step), true);
  await eventually(() => conn!.lines.some((l) => l.type === 'updateStep'));
  client.installed({ factorio: '2.1.25', mods: installed.mods });
  await eventually(() => conn!.lines.filter((l) => l.type === 'installed').length === 2);
  assert.deepEqual(
    conn!.lines.filter((l) => l.type === 'installed'),
    [{ type: 'installed', ...installed }, { type: 'installed', factorio: '2.1.25', mods: installed.mods }],
    'the same twice is sent once',
  );
  conn!.socket.destroy();
  await eventually(() => hub.of('agentHello').length === 2);
  const again = hub.of('agentHello')[1]!;
  await eventually(() => again.lines.some((l) => l.type === 'installed'));
  assert.equal(welcomes, 2);
  assert.deepEqual(again.invalid, []);
  assert.deepEqual(conn!.invalid, []);
});

test('installed is kept in state/installed.json: a restarted agent sends it on connect with its server stopped, never twice the same', async (t) => {
  const hub = await fakeHub();
  t.after(() => hub.close());
  const dir = await mkdtemp(join(tmpdir(), 'orrery-installed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const state = join(dir, 'state');
  const file = join(state, 'installed.json');
  const make = () =>
    new HubClient({
      config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server: {} as never, token: 't'.repeat(32), root: dir, state },
      version: 'agent-v0.0.0',
      backoffMs: 10,
    });
  const mods = [{ name: 'base', version: '2.1.24' }, { name: 'orrery', version: '0.1.0' }];
  const first = make();
  first.installed({ factorio: '2.1.24', mods });
  first.installed({ factorio: '2.1.25', mods });
  await until(async () => JSON.parse(await readFile(file, 'utf8')).factorio === '2.1.25', 2000, 'the newest kept');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { factorio: '2.1.25', mods });
  await first.stop();

  // A new agent on the same Host, its server stopped: no /orrery-status answer, yet the hub hears what it runs.
  const again = make();
  t.after(() => again.stop());
  again.start();
  const conn = (await eventually(() => hub.of('agentHello')[0]))!;
  await eventually(() => conn.lines.some((l) => l.type === 'installed'));
  again.installed({ factorio: '2.1.25', mods: mods.map((m) => ({ ...m })) }); // the server's first answer: the same
  await sleep(50);
  assert.deepEqual(conn.lines.filter((l) => l.type === 'installed'), [{ type: 'installed', factorio: '2.1.25', mods }], 'once');
  assert.deepEqual(conn.invalid, []);
  await again.stop();

  // A file that isn't one (not JSON, another shape, a field over the hub's limit) is never sent.
  for (const bad of ['not json', 'null', JSON.stringify({ factorio: 1, mods: [] }), JSON.stringify({ factorio: '2.1.25', mods: [{ name: 'x'.repeat(257), version: '1.0.0' }] })]) {
    await writeFile(file, bad);
    const n = hub.of('agentHello').length;
    const c = make();
    c.start();
    const other = (await eventually(() => hub.of('agentHello')[n]))!;
    await eventually(() => c.connected);
    await sleep(30);
    await c.stop();
    assert.deepEqual(other.lines.filter((l) => l.type === 'installed'), [], bad);
  }
});

test('a .tar.xz unpacks through xz -dc; what is not xz fails', async (t) => {
  const xz = spawnSync('xz', ['--version']);
  if (xz.error) return t.skip('no xz here (setup installs it on the Host)');
  const dir = await mkdtemp(join(tmpdir(), 'orrery-unxz-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'release.tar.xz');
  const packed = spawnSync('xz', ['-c'], { input: releaseTar('2.1.25') });
  await writeFile(file, packed.stdout);
  await unpack(unxz(file), join(dir, 'release'));
  assert.equal(await glibcNeed(join(dir, 'release/bin/x64/factorio')), '2.38');
  await writeFile(join(dir, 'plain.tar.xz'), releaseTar('2.1.25'));
  await assert.rejects(unpack(unxz(join(dir, 'plain.tar.xz')), join(dir, 'other')), /xz could not unpack it/);
});

test("the hub's updateResume and updateCancel carry request ids of their own: each acts on the one update running", async (t) => {
  const w = await world(t);
  const hub = await fakeHub();
  t.after(() => hub.close());
  // The handlers as src/index.ts has them.
  const client = new HubClient({
    config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server: {} as never, token: 't'.repeat(32), root: w.dir, state: w.state },
    version: 'agent-v0.0.0',
    handlers: { update: (req) => w.u.update(req), updateResume: () => w.u.resume(), updateCancel: () => w.u.cancel() },
    backoffMs: 10,
  });
  t.after(() => client.stop());
  client.start();
  const conn = (await eventually(() => hub.of('agentHello')[0]))!;
  await eventually(() => client.connected);
  const reply = (id: string) => eventually(() => conn.lines.find((l) => l.type === 'reply' && l.id === id), 3000, `the reply to ${id}`);

  conn.send({ type: 'updateResume', id: 'r1' });
  conn.send({ type: 'updateCancel', id: 'r2' });
  assert.deepEqual(await reply('r1'), { type: 'reply', id: 'r1', ok: false, error: 'no update is running' });
  assert.deepEqual(await reply('r2'), { type: 'reply', id: 'r2', ok: false, error: 'no update is running' });

  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  conn.send(w.request('2.1.25', [['orrery', '0.2.0']], 'U1'));
  assert.equal((await reply('U1')).ok, true);
  await w.step('stop', 'waiting');
  await w.unit.act('stop');
  conn.send({ type: 'updateResume', id: 'r3' }); // a fresh id, not U1
  assert.deepEqual(await reply('r3'), { type: 'reply', id: 'r3', ok: true });
  assert.deepEqual([(await w.done()).id, (await w.done()).outcome], ['U1', 'ok']);

  w.sent.length = 0;
  conn.send(w.request('2.1.25', [['orrery', '0.2.0']], 'U2'));
  await w.step('stop', 'waiting');
  conn.send({ type: 'updateCancel', id: 'r4' });
  assert.deepEqual(await reply('r4'), { type: 'reply', id: 'r4', ok: true });
  assert.deepEqual([(await w.done()).id, (await w.done()).outcome], ['U2', 'cancelled']);
  assert.deepEqual(conn.invalid, []);
});

test('a download that gets no byte for the stall time fails prepare with a clear step error; one over its cap is refused before it is read', async (t) => {
  const w = await world(t, { stallMs: 100 });
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.mod('flib', '0.16.2');
  const mods: [string, string][] = [['orrery', '0.2.0'], ['flib', '0.16.2']];
  /** An answer that never comes: aborted with the request, as fetch's is. */
  const silent: Http = (_url, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const failed = async () => {
    const done = await w.done();
    const step = await w.step('prepare', 'failed');
    w.sent.length = 0;
    return [done.outcome, step.detail];
  };

  // factorio.com's sha256 list never answers.
  const sums = w.routes.get(SUMS)!;
  w.routes.set(SUMS, silent);
  await w.u.update(w.request('2.1.25', mods));
  assert.deepEqual(await failed(), ['failed in staging', 'No data from https://www.factorio.com/download/sha256sums/ for 0.1 s: the download was stopped']);
  w.routes.set(SUMS, sums);

  // The game's signed link says it is over the 1 GiB cap: refused before anything is written.
  let created = false;
  w.routes.set(signedGame('2.1.25'), async () => {
    created = (await readdir(join(w.install, '.incoming'))).length > 0;
    return new Response(new Uint8Array(10), { headers: { 'content-length': String(2 * 1024 ** 3) } });
  });
  await w.u.update(w.request('2.1.25', mods, 'u2'));
  assert.deepEqual(await failed(), ['failed in staging', `https://dl.factorio.com/releases/${tarball('2.1.25')} is over 1073.7 MB`]);
  assert.equal(created, false);
  assert.deepEqual(await readdir(join(w.install, '.incoming')), []);
  w.offer('2.1.25');

  // flib's download sends a little, then nothing.
  w.routes.set(modUrl('flib', '0.16.2'), async (_url, signal) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(1000));
        signal.addEventListener('abort', () => c.error(signal.reason));
      },
    });
    return new Response(body);
  });
  await w.u.update(w.request('2.1.25', mods, 'u3'));
  assert.deepEqual(await failed(), ['failed in staging', 'No data from https://dl-mod.factorio.com/files/flib_0.16.2.zip for 0.1 s: the download was stopped']);
  assert.deepEqual(await readdir(join(w.data, '.incoming')), []);
  assert.equal(await exists(join(w.data, 'mods.next')), false);
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
  assert.deepEqual(w.unit.calls, []);
});

test('a running step goes out again when none went for the beat time (the hub gives an update up after 15 minutes without a word); stop waiting never', async (t) => {
  const w = await world(t, { beatMs: 50, stepMs: 20, gateMs: 500 });
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  w.broken.add('2.1.25'); // the gate waits its whole time
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  await sleep(300);
  assert.equal(w.steps().filter((m) => m.step === 'stop').length, 1, 'stop waiting once: it asks the hub to stop the server');
  await w.unit.act('stop');
  await w.u.resume();
  assert.equal((await w.done()).outcome, 'rolled back');
  const gate = w.steps().filter((m) => m.step === 'gate' && m.state === 'running');
  assert.ok(gate.length >= 4, `the gate's running step went out ${gate.length} times in 500 ms`);
  assert.ok(gate.every((m) => m.detail === gate[0]!.detail), 'the same step, as it is');
  for (const m of w.sent) assert.ok(parseAgentLine(JSON.stringify(m)), `the hub takes ${JSON.stringify(m)}`);
  const n = w.sent.length;
  await sleep(200);
  assert.equal(w.sent.length, n, 'nothing once it ended');
});

test('with the hub unreachable, a rollback whose old server answers with its version and mods is rolled back, not failed', async (t) => {
  const w = await world(t, { gateMs: 300 });
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  // The hub goes away right after its go-ahead: the new server's gate still needs the game connection, the rollback's
  // only while the Agent connection is up.
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  await w.unit.act('stop');
  await w.u.resume();
  w.connected = false;
  await until(async () => JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).phase === 'done', 5000, 'u1 done');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
  w.connected = true;
  w.u.connected();
  // Rolled back (2.1.25 itself runs: only the game connection was missing), and not failed (the old one ran).
  assert.equal((await w.done()).outcome, 'rolled back');
  await until(async () => !(await exists(join(w.state, 'update.json'))), 2000, 'update.json removed once reported');

  // The agent restarts mid-swap with no hub to reach: its recovery rollback ends rolled back too.
  w.sent.length = 0;
  w.unit.hang = true;
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']], 'u2'));
  await w.step('stop', 'waiting');
  await w.unit.act('stop');
  await w.u.resume();
  await eventually(() => w.unit.calls.at(-1) === 'start' || null, 3000, 'the swap to start the server');
  w.unit.hang = false;
  w.connected = false;
  await w.restart().start();
  assert.equal(JSON.parse(await readFile(join(w.state, 'update.json'), 'utf8')).outcome, 'rolled back');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
  w.connected = true;
  w.u.connected();
  assert.deepEqual([(await w.done()).id, (await w.done()).outcome], ['u2', 'rolled back']);
});

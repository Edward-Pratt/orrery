// The packs tests' hub, shared by `test/packs/`: `start` runs a whole hub on a `world` (`pack-world.ts`) and logs in,
// with fakes for systemd, the Mod and the download server that behave together; `uploaded` uploads a file, `updatable`
// adopts 2.7.4 with an Extra and edits and the Mod online, and `withGithub` does that with a fake GitHub (`github`: a
// hub and a Mod release). The library's and runtimes' hubs: `library-hub.ts`.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { AuditLog, LibraryState, LiveEvent, PackState, UploadAnswer, UploadProgress } from '../../src/api.ts';
import type { Fetch } from '../../src/packs/library.ts';
import type { Run } from '../../src/services/services.ts';
import { type HubDeps, startHub } from '../../src/start.ts';
import type { Notice } from '../../src/types.ts';
import { loginAs, WEB } from '../web/web-hub.ts';
import { fakeMod, hello, sleep, until } from '../fake-mod.ts';
import { type Setup, sha, URL_NEW, URL_OLD, world, type World } from './pack-world.ts';

/**
 * Starts a hub on a world and logs in. Systemd and the Mod are fakes that behave together: stopping the unit
 * disconnects the Mod, starting it brings a Mod back with a hello (unless `comesBack` says otherwise). The Mod answers
 * every command; `backup start` writes a backup and sends its event (`fake.backupFails` makes it fail).
 */
export async function start(t: TestContext, w: World, setup: Setup = {}) {
  if (setup.server) Object.assign(w.config.servers[0]!, setup.server);
  const fake = {
    comesBack: setup.comesBack ?? ((_n: number) => true),
    starts: 0,
    backupFails: false,
    players: [] as string[],
    /** A stop that never ends: the unit stays active. */
    stopHangs: false,
    downloadGate: Promise.resolve(),
    /** Every download request, with the headers it carried. */
    requests: [] as { url: string; headers: Record<string, string> }[],
    /** Redirects the fake server answers: from a URL to another. */
    redirects: {} as Record<string, string>,
    /** How many answers to cut short after `dropAt` bytes. */
    drops: 0,
    dropAt: 100,
    /** Answer a Range with the whole file (200). */
    ignoreRange: false,
    /** The unit's `Environment=` as systemctl shows it. */
    environment: '',
    /** Holds the Mod's answer to `backup start`: an update waits in Backup. */
    backupGate: Promise.resolve(),
    downloads: [] as string[],
    /** Units systemd knows besides the listed ones (a New server's id is refused when its unit is here). */
    units: [] as string[],
  };
  const state: Record<string, string> = { 'gtnh.service': setup.unit ?? 'active' };
  const calls: string[][] = [];
  let mod: ReturnType<typeof fakeMod> | undefined;
  let backups = 0;
  let port = 0;
  const connect = async () => {
    const m = fakeMod(port);
    mod = m;
    m.send(hello());
    assert.deepEqual(await m.next(), { type: 'welcome' });
    m.send({ type: 'heartbeat', tps: 20, players: fake.players });
    void (async () => {
      for (;;) {
        const msg = (await m.next()) as { type: string; id: string; command: string };
        if (msg.type !== 'cmd') continue;
        m.send({ type: 'cmdResult', id: msg.id, output: [] });
        if (msg.command !== 'backup start') continue;
        await fake.backupGate;
        if (fake.backupFails) m.send({ type: 'backup', ok: false, detail: 'disk full' });
        else {
          writeFileSync(join(w.backupDir, `2026-10-02-12-00-0${backups++}.zip`), 'backup');
          m.send({ type: 'backup', ok: true, detail: '1 s' });
        }
      }
    })();
    return m;
  };
  const run: Run = async (command, args) => {
    calls.push([command, ...args]);
    const unit = args.at(-1)!;
    if (args.includes('--property=Environment')) return `Environment=${fake.environment}\n`;
    if (args.includes('--property=LoadState')) return `LoadState=${unit in state || fake.units.includes(unit) ? 'loaded' : 'not-found'}\n`;
    if (args[0] === 'stop') {
      if (!fake.stopHangs) state[unit] = 'inactive';
      mod?.send({ type: 'stopping' });
      mod?.socket.end();
    }
    if (args[0] === 'start') {
      state[unit] = 'active';
      if (unit !== 'gtnh.service') return `ActiveState=active\nSubState=running\n`; // a deploy unit
      fake.starts++;
      if (fake.comesBack(fake.starts)) setTimeout(() => void connect(), 20);
    }
    return `ActiveState=${state[unit] ?? 'inactive'}\nSubState=running\n`;
  };
  /** A fake HTTP server for downloads: `w.urls`' files, with an ETag, honouring Range with If-Range; it can redirect and drop. */
  const download: Fetch = async (url, { headers, signal }) => {
    fake.downloads.push(url);
    fake.requests.push({ url, headers });
    await Promise.race([fake.downloadGate, new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))]);
    if (fake.redirects[url]) return new Response(null, { status: 302, headers: { location: fake.redirects[url]! } });
    const from = w.urls[url];
    if (!from) return new Response('not found', { status: 404 });
    const data = readFileSync(from);
    const etag = `"${sha(from)}"`;
    const start = headers.range && headers['if-range'] === etag && !fake.ignoreRange ? Number(/^bytes=(\d+)-$/.exec(headers.range)![1]) : 0;
    const drop = fake.drops > 0 && start + fake.dropAt < data.length;
    if (drop) fake.drops--;
    let sent = false;
    const body = new ReadableStream({
      pull(c) {
        if (sent && !drop) return c.close();
        // The connection drops a moment after the bytes arrive, as a real one would, so they reach the disk.
        if (sent) return new Promise((r) => setTimeout(r, 20)).then(() => c.error(new Error('connection reset')));
        sent = true;
        c.enqueue(new Uint8Array(data.subarray(start, drop ? start + fake.dropAt : data.length)));
      },
    });
    return start
      ? new Response(body, { status: 206, headers: { etag, 'content-range': `bytes ${start}-${data.length - 1}/${data.length}` } })
      : new Response(body, { status: 200, headers: { etag, 'content-length': String(data.length) } });
  };
  const handle = await startHub(w.config, {
    startFrontend: () => assert.fail('Discord is off'),
    get: () => assert.fail('nothing to request'),
    run,
    download,
    restore: setup.restore,
    github: setup.github,
    packs: { gateMs: setup.gateMs ?? 1_000, pollMs: 10, backupMs: 2_000, ...(setup.stopMs && { stopMs: setup.stopMs }), ...(setup.compareMs && { compareMs: setup.compareMs }) },
    deploys: { watchMs: 10, countdownMinutes: 60 },
    uploadIdleMs: setup.uploadIdleMs,
    githubToken: setup.githubToken,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  t.after(close);
  port = handle.port!;
  const events: Notice[] = [];
  const libraryEnds: number[] = [];
  handle.live.on('event', (_, { at: _at, ...e }: LiveEvent) => {
    if ('target' in e && e.type === 'libraryAdd' && e.phase === 'finished') libraryEnds.push(e.add);
    if ('serverId' in e && e.type === 'notice' && e.kind.startsWith('pack')) {
      const { type: _t, serverId: _s, ...n } = e;
      events.push(n as Notice);
    }
  });
  const app = handle.web!.app;
  const { cookie } = await loginAs(handle.web!);
  const headers = { cookie, origin: WEB.publicUrl, 'content-type': 'application/json' };
  const req = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: method === 'GET' ? { cookie } : headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const json = async <T>(res: Response | Promise<Response>, status = 200): Promise<T> => {
    const r = await res;
    if (r.status !== status) assert.fail(`HTTP ${r.status} (wanted ${status}): ${await r.text()}`);
    return r.json() as Promise<T>;
  };
  const pack = () => json<PackState>(req('GET', '/api/servers/gtnh/pack'));
  /** A raw chunk at `offset` of an upload, as the dashboard sends it. */
  const chunk = (upload: string, offset: number, body: BodyInit, headers: Record<string, string> = {}) =>
    app.request(`/api/uploads/${upload}?offset=${offset}`, {
      method: 'PUT',
      headers: { cookie, origin: WEB.publicUrl, 'content-type': 'application/octet-stream', ...headers },
      body,
    });
  /** Uploads a file in chunks of `size` bytes; returns its upload id. */
  const upload = async (file: string, name = 'GTNH_2.7.5.zip', size = 1000) => {
    const data = readFileSync(file);
    const { upload: id } = await json<UploadAnswer>(req('POST', '/api/uploads', { fileName: name, size: data.length }));
    for (let at = 0; at < data.length; at += size) await json<UploadProgress>(chunk(id, at, Buffer.from(data.subarray(at, at + size))));
    return id;
  };
  const audit = async (prefix = 'pack') =>
    ((await (await app.request('/api/audit', { headers: { cookie } })).json()) as AuditLog).entries
      .filter((e) => e.action.startsWith(prefix))
      .map(({ actor, action, target, details }) => ({ actor, action, target, details }))
      .reverse();
  const entries = new Map<string, number>();
  /** A library entry for a URL's zip (added once per hub), as a pack source. */
  const entry = async (url: string, version: string, mc = '1.7.10') => {
    if (!entries.has(url)) {
      const { add } = await json<{ add: number }>(req('POST', '/api/library/packs', { url, name: 'GT New Horizons', version, mc, loader: 'forge' }), 202);
      await until(() => libraryEnds.includes(add));
      const found = (await json<LibraryState>(req('GET', '/api/library'))).packs.find((p) => p.version === version);
      if (!found) assert.fail(`${url} wasn't added`);
      entries.set(url, found.id);
    }
    return { library: entries.get(url)! };
  };
  /** 2.7.5 from the library. */
  const toNew = () => entry(URL_NEW, '2.7.5');
  /** Adopts 2.7.4 from the library, keeping the third-party jar, our own config, and the changed forge.cfg. */
  const adopt = async (keep = ['config/custom.cfg', 'config/forge.cfg', 'mods/journeymap-fairplay.jar']) => {
    await json(req('POST', '/api/servers/gtnh/pack/compare', await entry(URL_OLD, '2.7.4')));
    return json<PackState>(req('POST', '/api/servers/gtnh/pack/adopt', { keep }));
  };
  /** Waits for the running update to finish; returns its history row. */
  const finished = async (ms = 10_000) => {
    await until(() => events.some((e) => e.kind === 'packUpdateFinished'), ms);
    return (await pack()).history[0]!;
  };
  const systemctl = () => calls.filter((c) => c[0] === 'systemctl' && c[1] !== 'show').map((c) => `${c[1]} ${c.at(-1)}`);
  return { handle, app, cookie, req, json, pack, chunk, upload, audit, entry, toNew, adopt, finished, events, fake, state, calls, systemctl, connect, close, mod: () => mod! };
}

/** Uploads `content` as a file and returns its upload id. */
export async function uploaded(s: Awaited<ReturnType<typeof start>>, w: World, name: string, content: string): Promise<string> {
  const file = join(w.root, name);
  writeFileSync(file, content);
  return s.upload(file, name);
}

/** Adopts 2.7.4, adds an Extra replacing a 2.7.5 file and an edit on an Extra's file, with the Mod online. */
export async function updatable(t: TestContext, setup: Setup = {}) {
  const w = world(t);
  const s = await start(t, w, setup);
  await s.connect();
  await s.adopt();
  await s.json(s.req('POST', '/api/servers/gtnh/pack/extras', { upload: await uploaded(s, w, 'bq.jar', 'bq pinned'), target: 'mods/bq.jar', label: '3.4' }));
  await s.json(s.req('POST', '/api/servers/gtnh/pack/edits', { path: 'startserver.sh', find: '-Xmx(\\d+)G', replace: '-Xmx12G -Dold=$1', note: 'heap' }));
  await s.json(s.req('POST', '/api/servers/gtnh/pack/edits', { path: 'config/custom.cfg', find: '^our', replace: 'my' }));
  return { w, s };
}

/** A fake GitHub with a hub and a Mod release. */
export const github: HubDeps['github'] = {
  releases: async () => [
    { tag: 'hub-v2.7.0', draft: false, prerelease: false, publishedAt: 1, assets: [] },
    { tag: 'mod-v1.5.0', draft: false, prerelease: false, publishedAt: 1, assets: ['orrery-1.7.10-1.5.0.jar'] },
  ],
  download: async () => new TextEncoder().encode('jar'),
};

export async function withGithub(t: TestContext) {
  const w = world(t);
  w.config.integrations.github = {
    repo: 'Edward-Pratt/orrery',
    newerAfterDays: 14,
    deploys: { root: join(w.root, 'data'), hubUnit: 'orrery-hub.service', hubTemplate: 'orrery-deploy', webTemplate: 'orrery-deploy-web', webDir: join(w.root, 'www') },
  };
  const s = await start(t, w, { github });
  while (((await s.json<{ checkedAt: number | null }>(s.req('GET', '/api/deploys'))).checkedAt) === null) await sleep(5);
  await s.connect();
  await s.adopt();
  return { w, s };
}

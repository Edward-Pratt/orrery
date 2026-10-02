import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AuditLog, CompareReport, LiveEvent, PackState, ServerCard, ServerDetail, UploadAnswer } from '../src/api.ts';
import type { Config, ServerSettings } from '../src/config.ts';
import type { Download } from '../src/packs.ts';
import type { RunRestore } from '../src/restore.ts';
import type { Run } from '../src/services.ts';
import { startHub, type HubDeps } from '../src/start.ts';
import { formatEvent } from '../src/format.ts';
import type { Notice } from '../src/types.ts';
import type { OAuth } from '../src/web.ts';
import { fakeMod, hello, sleep, TOKEN, until } from './fake-mod.ts';

const WEB = {
  listenPort: 0,
  publicUrl: 'https://dash.orrery.run',
  clientId: '4'.repeat(18),
  guildId: '7'.repeat(18),
  adminRoleId: '8'.repeat(18),
  sessionDays: 7,
};
const ADMIN = { id: '5'.repeat(18), username: 'alex', avatar: null, roles: [WEB.adminRoleId] };
const ACTOR = `web:alex (${ADMIN.id})`;
const oauth: OAuth = { token: async (code) => code, member: async () => ADMIN };
const URL_OLD = 'https://packs.example/GTNH_2.7.4.zip';
const URL_NEW = 'https://packs.example/GTNH_2.7.5.zip';

/** Every file under a folder, with its sha256: what "byte-for-byte unchanged" compares. */
function snapshot(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, snapshot(dir, p));
    else out[p] = createHash('sha256').update(readFileSync(join(dir, p))).digest('hex');
  }
  return out;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** The 2.7.4 pack as the server runs it, and 2.7.5. */
const PACK_OLD = {
  'mods/gregtech.jar': 'gt 1',
  'mods/old-only.jar': 'gone in 2.7.5',
  'mods/bq.jar': 'bq 3.4',
  'config/gregtech.cfg': 'pollution=true\nheap=6G\n',
  'config/forge.cfg': 'forge defaults',
  'startserver.sh': 'java -Xmx6G -jar forge.jar\n',
  'server.properties': 'level-name=world\nmotd=pack default\n',
  'World/level.dat': 'the pack must never ship this',
};
const PACK_NEW = {
  'mods/gregtech.jar': 'gt 2',
  'mods/new-only.jar': 'new in 2.7.5',
  'mods/bq.jar': 'bq 3.5',
  'config/gregtech.cfg': 'pollution=true\nheap=6G\nnew=1\n',
  'config/forge.cfg': 'forge defaults',
  'startserver.sh': 'java -Xmx6G -jar forge.jar\n',
  'server.properties': 'level-name=world\nmotd=pack default\n',
};
/** What the server folder holds besides the pack: its own files, an Extra-to-be, a local change, and the Mod. */
const SERVER_OWN = {
  'server.properties': 'level-name=World\nmotd=GTNH main\n',
  'World/level.dat': 'the world',
  'World/region/r.0.0.mca': 'chunks',
  'ops.json': '[]',
  'logs/latest.log': 'log',
  'journeymap/data.dat': 'map',
  'config/JourneyMapServer/world.cfg': 'kept by config',
  'mods/journeymap-fairplay.jar': 'a third-party mod',
  'config/custom.cfg': 'our own config',
  'mods/gtnhdiscord-1.4.0.jar': 'the Mod',
};

type Setup = {
  server?: Partial<ServerSettings>;
  /** Whether the fake Mod comes back after the nth start of the unit (1 is the first); default: always. */
  comesBack?: (n: number) => boolean;
  restore?: RunRestore;
  github?: HubDeps['github'];
  gateMs?: number;
  /** The unit's state when the hub starts (default active). */
  unit?: string;
};

/**
 * A temporary world: a server folder holding pack 2.7.4 plus its own files, the backup folder beside it, both packs
 * as zips (built with the real zip) behind fake URLs, and a config with Minecraft, web and systemd on.
 */
function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'hub-packs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'gtnh');
  const backupDir = join(root, 'backups');
  mkdirSync(backupDir);
  write(dir, { ...PACK_OLD, ...SERVER_OWN, 'config/forge.cfg': 'changed on the server' });
  const zips = join(root, 'zips');
  const zip = (name: string, files: Record<string, string>, prefix = '') => {
    const src = join(zips, name.replace(/\.zip$/, ''));
    write(join(src, prefix), files);
    execFileSync('zip', ['-qry', join(zips, name), '.'], { cwd: src });
    return join(zips, name);
  };
  const urls: Record<string, string> = {
    [URL_OLD]: zip('GTNH_2.7.4.zip', PACK_OLD, 'GT_New_Horizons_2.7.4_Server'),
    [URL_NEW]: zip('GTNH_2.7.5.zip', PACK_NEW),
  };
  const gtnh: ServerSettings = {
    id: 'gtnh',
    name: 'GTNH',
    dir,
    backupDir,
    backupMinFreeGB: 10,
    lag: { tps: 15, minutes: 2, enabled: true },
    quests: 'batched',
    service: 'gtnh',
    keep: ['config/JourneyMapServer', 'journeymap/'],
  };
  const config: Config = {
    dbPath: join(root, 'data', 'hub.db'),
    servers: [gtnh],
    integrations: {
      minecraft: { listenPort: 0, tokens: { gtnh: TOKEN } },
      web: WEB,
      systemd: [{ id: 'gtnh', unit: 'gtnh.service' }],
    },
  };
  mkdirSync(dirname(config.dbPath));
  return { root, dir, backupDir, zips, zip, urls, config };
}

type World = ReturnType<typeof world>;

/**
 * Starts a hub on a world and logs in. Systemd and the Mod are fakes that behave together: stopping the unit
 * disconnects the Mod, starting it brings a Mod back with a hello (unless `comesBack` says otherwise). The Mod answers
 * every command; `backup start` writes a backup and sends its event (`fake.backupFails` makes it fail).
 */
async function start(t: TestContext, w: World, setup: Setup = {}) {
  if (setup.server) Object.assign(w.config.servers[0]!, setup.server);
  const fake = {
    comesBack: setup.comesBack ?? ((_n: number) => true),
    starts: 0,
    backupFails: false,
    players: [] as string[],
    downloadGate: Promise.resolve(),
    downloads: [] as string[],
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
    if (args[0] === 'stop') {
      state[unit] = 'inactive';
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
  const download: Download = async (url, dest, onProgress, signal) => {
    fake.downloads.push(url);
    await Promise.race([fake.downloadGate, new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))]);
    const from = w.urls[url];
    if (!from) throw new Error('HTTP 404');
    onProgress(1, 2);
    copyFileSync(from, dest);
  };
  const handle = await startHub(w.config, {
    startFrontend: () => assert.fail('Discord is off'),
    get: () => assert.fail('nothing to request'),
    oauth,
    run,
    download,
    restore: setup.restore,
    github: setup.github,
    packs: { gateMs: setup.gateMs ?? 1_000, pollMs: 10, backupMs: 2_000 },
    deploys: { watchMs: 10, countdownMinutes: 60 },
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
  handle.live.on('event', (_, { at: _at, ...e }: LiveEvent) => {
    if ('serverId' in e && e.type === 'notice' && e.kind.startsWith('pack')) {
      const { type: _t, serverId: _s, ...n } = e;
      events.push(n as Notice);
    }
  });
  const app = handle.web!.app;
  const login = await app.request('/api/callback?code=x&state=s', { headers: { cookie: 'state=s' } });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('session='))!.split(';')[0]!;
  const headers = { cookie, origin: WEB.publicUrl, 'content-type': 'application/json' };
  const req = (method: string, path: string, body?: unknown) =>
    app.request(path, { method, headers: method === 'GET' ? { cookie } : headers, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const json = async <T>(res: Response | Promise<Response>, status = 200): Promise<T> => {
    const r = await res;
    if (r.status !== status) assert.fail(`HTTP ${r.status} (wanted ${status}): ${await r.text()}`);
    return r.json() as Promise<T>;
  };
  const pack = () => json<PackState>(req('GET', '/api/servers/gtnh/pack'));
  const upload = async (file: string, name = 'GTNH_2.7.5.zip', type = 'application/zip') =>
    app.request('/api/servers/gtnh/pack/uploads', {
      method: 'POST',
      headers: { cookie, origin: WEB.publicUrl, 'content-type': type, 'x-file-name': encodeURIComponent(name) },
      body: readFileSync(file),
    });
  const audit = async (prefix = 'pack') =>
    ((await (await app.request('/api/audit', { headers: { cookie } })).json()) as AuditLog).entries
      .filter((e) => e.action.startsWith(prefix))
      .map(({ actor, action, target, details }) => ({ actor, action, target, details }))
      .reverse();
  /** Adopts 2.7.4 from its URL, keeping the third-party jar, our own config, and the changed forge.cfg. */
  const adopt = async (keep = ['config/custom.cfg', 'config/forge.cfg', 'mods/journeymap-fairplay.jar']) => {
    await json(req('POST', '/api/servers/gtnh/pack/compare', { url: URL_OLD, name: 'GT New Horizons', version: '2.7.4' }));
    return json<PackState>(req('POST', '/api/servers/gtnh/pack/adopt', { keep }));
  };
  /** Waits for the running update to finish; returns its history row. */
  const finished = async (ms = 10_000) => {
    await until(() => events.some((e) => e.kind === 'packUpdateFinished'), ms);
    return (await pack()).history[0]!;
  };
  const systemctl = () => calls.filter((c) => c[0] === 'systemctl' && c[1] !== 'show').map((c) => `${c[1]} ${c.at(-1)}`);
  return { handle, app, cookie, req, json, pack, upload, audit, adopt, finished, events, fake, state, calls, systemctl, connect, close, mod: () => mod! };
}

test('a server with a folder, a service and a Mod has a Pack: Kept paths from keep first, then the built-in ones', async (t) => {
  const w = world(t);
  const s = await start(t, w, { server: { backupDir: join(w.dir, 'backups') } });
  const p = await s.pack();
  assert.equal(p.installed, null);
  assert.deepEqual(p.kept, {
    server: ['config/JourneyMapServer', 'journeymap/'],
    builtIn: [
      'World/',
      'server.properties',
      'ops.json',
      'whitelist.json',
      'banned-players.json',
      'banned-ips.json',
      'usercache.json',
      'eula.txt',
      'server-icon.png',
      'logs/',
      'crash-reports/',
      'backups/',
      '.pre-update-*/',
      '.orrery-staging/',
      'mods/gtnhdiscord-*.jar',
    ],
  });
  assert.deepEqual([p.history, p.extras, p.edits, p.pending, p.running, p.rolledBack], [[], [], [], [], null, null]);
  assert.equal(p.mod, 'mods/gtnhdiscord-1.4.0.jar');
  assert.deepEqual(p.packFiles, []);
  assert.equal((await s.json<ServerDetail>(s.req('GET', '/api/servers/gtnh'))).pack, true);
});

test('the world defaults to "world" without a level-name; a backup folder outside the server folder is not listed', async (t) => {
  const w = world(t);
  rmSync(join(w.dir, 'server.properties'));
  const s = await start(t, w);
  const { builtIn } = (await s.pack()).kept;
  assert.equal(builtIn[0], 'world/');
  assert.ok(!builtIn.includes('backups/'));
});

test('no Pack without a folder, a linked service or a Mod token', async (t) => {
  for (const without of ['dir', 'service', 'token'] as const) {
    const w = world(t);
    if (without === 'token') {
      w.config.servers.push({ ...w.config.servers[0]!, id: 'other', name: 'Other', service: undefined });
      w.config.integrations.systemd!.push({ id: 'other', unit: 'other.service' });
      w.config.servers[1]!.service = 'other';
    }
    const s = await start(t, w, without === 'dir' ? { server: { dir: undefined } } : without === 'service' ? { server: { service: undefined } } : {});
    const id = without === 'token' ? 'other' : 'gtnh';
    assert.equal((await s.req('GET', `/api/servers/${id}/pack`)).status, 404, without);
    assert.equal((await s.req('POST', `/api/servers/${id}/pack/compare`, { url: URL_OLD, name: 'x', version: '1' })).status, 404, without);
    assert.equal((await s.json<ServerDetail>(s.req('GET', `/api/servers/${id}`))).pack, false, without);
    await s.close();
  }
});

test('without systemd there are no pack routes', async (t) => {
  const w = world(t);
  delete w.config.integrations.systemd;
  const s = await start(t, w, { server: { service: undefined } });
  assert.equal((await s.req('GET', '/api/servers/gtnh/pack')).status, 404);
  assert.equal((await s.json<ServerDetail>(s.req('GET', '/api/servers/gtnh'))).pack, false);
});

test('Compare reports matching, the Mod, files not in the pack and different ones, skipping Kept paths; nothing on disk changes', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  const before = snapshot(w.dir);
  const report = await s.json<CompareReport>(s.req('POST', '/api/servers/gtnh/pack/compare', { url: URL_OLD, name: 'GT New Horizons', version: '2.7.4' }));
  assert.deepEqual(report, {
    name: 'GT New Horizons',
    version: '2.7.4',
    // gregtech.jar, old-only.jar, bq.jar, gregtech.cfg, startserver.sh; server.properties and World/ are kept
    matching: 5,
    mod: ['mods/gtnhdiscord-1.4.0.jar'],
    notInPack: [
      { path: 'config/custom.cfg', size: 14 },
      { path: 'mods/journeymap-fairplay.jar', size: 17 },
    ],
    different: [{ path: 'config/forge.cfg', size: 21 }],
  } satisfies CompareReport);
  assert.deepEqual(snapshot(w.dir), before);
  assert.deepEqual(await s.audit(), [{ actor: ACTOR, action: 'pack compare', target: 'gtnh', details: 'GT New Horizons 2.7.4: 5 files match' }]);
});

test('Adopt keeps the ticked files as Extras and records the pack, changing nothing on disk; a second Adopt is 409', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  const before = snapshot(w.dir);
  assert.equal((await s.req('POST', '/api/servers/gtnh/pack/adopt', { keep: [] })).status, 409); // compare first
  const p = await s.adopt();
  assert.deepEqual(snapshot(w.dir), before);
  const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
  assert.deepEqual(p.installed && { ...p.installed, at: 0 }, {
    name: 'GT New Horizons',
    version: '2.7.4',
    source: URL_OLD,
    sha256: sha(readFileSync(w.urls[URL_OLD]!)),
    by: 'alex',
    at: 0,
    how: 'adopted',
  });
  assert.deepEqual(
    p.extras.map(({ target, sha256, replaces, change, removed }) => ({ target, sha256, replaces, change, removed })),
    [
      { target: 'config/custom.cfg', sha256: sha('our own config'), replaces: false, change: null, removed: false },
      { target: 'config/forge.cfg', sha256: sha('changed on the server'), replaces: true, change: null, removed: false },
      { target: 'mods/journeymap-fairplay.jar', sha256: sha('a third-party mod'), replaces: false, change: null, removed: false },
    ],
  );
  assert.deepEqual(p.pending, []);
  assert.deepEqual(p.packFiles, ['config/forge.cfg', 'config/gregtech.cfg', 'mods/bq.jar', 'mods/gregtech.jar', 'mods/old-only.jar', 'startserver.sh']);
  // Each Extra is stored under its row id, outside the server folder.
  const stored = join(w.root, 'data', 'extras', 'gtnh');
  assert.deepEqual(readdirSync(stored).sort(), p.extras.map((e) => String(e.id)).sort());
  assert.equal(readFileSync(join(stored, String(p.extras[0]!.id)), 'utf8'), 'our own config');
  const again = await s.req('POST', '/api/servers/gtnh/pack/compare', { url: URL_OLD, name: 'x', version: '1' });
  assert.equal(again.status, 409);
  assert.deepEqual(await s.audit('pack adopt'), [{ actor: ACTOR, action: 'pack adopt', target: 'gtnh', details: 'GT New Horizons 2.7.4, keeping 3 files' }]);
});

test('Adopt takes only paths from the report', async (t) => {
  const s = await start(t, world(t));
  await s.json(s.req('POST', '/api/servers/gtnh/pack/compare', { url: URL_OLD, name: 'GT New Horizons', version: '2.7.4' }));
  for (const keep of [['ops.json'], ['../etc/passwd'], ['mods/gtnhdiscord-1.4.0.jar'], 'config/custom.cfg']) {
    assert.equal((await s.req('POST', '/api/servers/gtnh/pack/adopt', { keep })).status, 400, String(keep));
  }
  assert.equal((await s.pack()).installed, null);
});

/** A zip with entries python's zipfile writes as given (zip itself strips `..` and leading slashes). */
function rawZip(w: World, name: string, entries: Record<string, string>, symlink?: string): string {
  const path = join(w.zips, name);
  const script = `import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1], 'w')
for n, c in json.loads(sys.argv[2]).items(): z.writestr(n, c)
if sys.argv[3]:
    i = zipfile.ZipInfo(sys.argv[3]); i.external_attr = 0o120777 << 16; z.writestr(i, '/etc/passwd')
z.close()`;
  execFileSync('python3', ['-c', script, path, JSON.stringify(entries), symlink ?? '']);
  return path;
}

test('a zip with "..", an absolute path or a symlink is refused before anything is extracted', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  const ok = { 'mods/a.jar': 'a' };
  w.urls['https://x/dots.zip'] = rawZip(w, 'dots.zip', { ...ok, 'mods/../../../evil.txt': 'x' });
  w.urls['https://x/abs.zip'] = rawZip(w, 'abs.zip', { ...ok, '/tmp/evil.txt': 'x' });
  w.urls['https://x/link.zip'] = rawZip(w, 'link.zip', ok, 'config/link');
  for (const [url, why] of [
    ['https://x/dots.zip', 'The zip has a path outside its folder (mods/../../../evil.txt): refused.'],
    ['https://x/abs.zip', 'The zip has a path outside its folder (/tmp/evil.txt): refused.'],
    ['https://x/link.zip', 'The zip has a symlink (config/link): refused.'],
  ]) {
    const res = await s.req('POST', '/api/servers/gtnh/pack/compare', { url, name: 'x', version: '1' });
    assert.equal(res.status, 400, url);
    assert.equal(await res.text(), why);
  }
  assert.ok(!existsSync(join(w.root, 'evil.txt')) && !existsSync('/tmp/evil.txt'));
  assert.deepEqual(readdirSync(join(w.root, 'data')).sort(), ['hub.db', 'uploads']);
  assert.deepEqual(readdirSync(join(w.root, 'data', 'uploads')), []); // each download deleted once refused
});

test('a zip with no mods/ or config/ is refused; a nested content root is found', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  w.urls['https://x/client.zip'] = w.zip('client.zip', { 'readme.txt': 'not a server pack', 'docs/mods.txt': 'no folder' });
  const res = await s.req('POST', '/api/servers/gtnh/pack/compare', { url: 'https://x/client.zip', name: 'x', version: '1' });
  assert.equal(res.status, 400);
  assert.equal(await res.text(), 'The zip has no mods/ or config/ folder: is it a server pack?');
  w.urls['https://x/deep.zip'] = w.zip('deep.zip', PACK_OLD, 'a/b/c');
  const report = await s.json<CompareReport>(s.req('POST', '/api/servers/gtnh/pack/compare', { url: 'https://x/deep.zip', name: 'x', version: '1' }));
  assert.equal(report.matching, 5);
});

test('a failed download is 502; a source needs an https URL or an upload, a name and a version', async (t) => {
  const s = await start(t, world(t));
  const res = await s.req('POST', '/api/servers/gtnh/pack/compare', { url: 'https://packs.example/missing.zip', name: 'x', version: '1' });
  assert.equal(res.status, 502);
  assert.equal(await res.text(), 'Downloading the pack failed: HTTP 404');
  for (const body of [{ url: 'http://packs.example/a.zip', name: 'x', version: '1' }, { url: URL_OLD, version: '1' }, { url: URL_OLD, name: 'x' }, { upload: 'nope', name: 'x', version: '1' }]) {
    assert.equal((await s.req('POST', '/api/servers/gtnh/pack/compare', body)).status, 400, JSON.stringify(body));
  }
});

test('an upload streams to <data>/uploads and can be adopted from, once; uploads are cleared at start; only zips and jars', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  const res = await s.upload(w.urls[URL_OLD]!, 'GT_New_Horizons_2.7.4_Server_Java_17-21.zip');
  const up = await s.json<UploadAnswer>(res);
  assert.equal(up.fileName, 'GT_New_Horizons_2.7.4_Server_Java_17-21.zip');
  assert.equal(up.size, statSync(w.urls[URL_OLD]!).size);
  assert.deepEqual(readdirSync(join(w.root, 'data', 'uploads')), [up.upload]);
  assert.equal((await s.upload(w.urls[URL_OLD]!, 'a.zip', 'application/json')).status, 415);
  assert.equal((await s.upload(w.urls[URL_OLD]!, 'a.zip', 'text/plain')).status, 415);
  const elsewhere = { cookie: s.cookie, origin: 'https://evil.example', 'content-type': 'application/zip' };
  assert.equal((await s.app.request('/api/servers/gtnh/pack/uploads', { method: 'POST', headers: elsewhere, body: 'x' })).status, 403);
  const report = await s.json<CompareReport>(s.req('POST', '/api/servers/gtnh/pack/compare', { upload: up.upload, name: 'GT New Horizons', version: '2.7.4' }));
  assert.equal(report.matching, 5);
  assert.equal((await s.req('POST', '/api/servers/gtnh/pack/compare', { upload: up.upload, name: 'x', version: '1' })).status, 400); // used
  const p = await s.json<PackState>(s.req('POST', '/api/servers/gtnh/pack/adopt', { keep: [] }));
  assert.equal(p.installed!.source, 'GT_New_Horizons_2.7.4_Server_Java_17-21.zip');
  await s.json<UploadAnswer>(s.upload(w.urls[URL_NEW]!));
  assert.equal(readdirSync(join(w.root, 'data', 'uploads')).length, 1);
  await s.close();
  await start(t, w);
  assert.ok(!existsSync(join(w.root, 'data', 'uploads')));
});

/** Uploads `content` as a file and returns its upload id. */
async function uploaded(s: Awaited<ReturnType<typeof start>>, w: World, name: string, content: string): Promise<string> {
  const file = join(w.root, name);
  writeFileSync(file, content);
  return (await s.json<UploadAnswer>(s.upload(file, name, 'application/java-archive'))).upload;
}

test('adding, replacing and removing Extras and edits gives exactly the pending changes, each audited', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  let p = await s.adopt();
  const id = (target: string) => p.extras.find((e) => e.target === target)!.id;
  const extras = '/api/servers/gtnh/pack/extras';
  p = await s.json(s.req('POST', extras, { upload: await uploaded(s, w, 'pregen.jar', 'pregen'), target: 'mods/pregen.jar', label: '4.4.4', note: 'chunk pregen' }));
  p = await s.json(s.req('PUT', `${extras}/${id('config/custom.cfg')}`, { upload: await uploaded(s, w, 'custom.cfg', 'our own config, v2') }));
  p = await s.json(s.req('PUT', `${extras}/${id('mods/journeymap-fairplay.jar')}`, { label: '5.2.6', note: 'fairplay build' })); // not a file change
  p = await s.json(s.req('DELETE', `${extras}/${id('config/forge.cfg')}`));
  p = await s.json(s.req('POST', '/api/servers/gtnh/pack/edits', { path: 'startserver.sh', find: '-Xmx6G', replace: '-Xmx12G', note: 'heap' }));
  assert.deepEqual(p.pending, [
    { path: 'config/custom.cfg', kind: 'extra', change: 'replaced' },
    { path: 'config/forge.cfg', kind: 'extra', change: 'removed' },
    { path: 'mods/pregen.jar', kind: 'extra', change: 'added' },
    { path: 'startserver.sh', kind: 'edit', change: 'added' },
  ]);
  assert.deepEqual(
    p.extras.map(({ target, label, note, by, removed, change, replaces }) => ({ target, label, note, by, removed, change, replaces })),
    [
      { target: 'config/custom.cfg', label: '', note: 'kept at adopt', by: 'alex', removed: false, change: 'replaced', replaces: false },
      { target: 'config/forge.cfg', label: '', note: 'kept at adopt', by: 'alex', removed: true, change: 'removed', replaces: true },
      { target: 'mods/journeymap-fairplay.jar', label: '5.2.6', note: 'fairplay build', by: 'alex', removed: false, change: null, replaces: false },
      { target: 'mods/pregen.jar', label: '4.4.4', note: 'chunk pregen', by: 'alex', removed: false, change: 'added', replaces: false },
    ],
  );
  assert.deepEqual(
    p.edits.map(({ path, find, replace, note, failedOn }) => ({ path, find, replace, note, failedOn })),
    [{ path: 'startserver.sh', find: '-Xmx6G', replace: '-Xmx12G', note: 'heap', failedOn: null }],
  );
  // An Extra never applied goes at once; an edit changed and removed again leaves nothing pending.
  p = await s.json(s.req('DELETE', `${extras}/${id('mods/pregen.jar')}`));
  p = await s.json(s.req('PUT', `/api/servers/gtnh/pack/edits/${p.edits[0]!.id}`, { path: 'startserver.sh', find: '-Xmx6G', replace: '-Xmx16G' }));
  assert.equal(p.edits[0]!.replace, '-Xmx16G');
  p = await s.json(s.req('DELETE', `/api/servers/gtnh/pack/edits/${p.edits[0]!.id}`));
  assert.deepEqual(p.pending.map((x) => x.path), ['config/custom.cfg', 'config/forge.cfg']);
  assert.ok(!p.extras.some((e) => e.target === 'mods/pregen.jar'));
  assert.deepEqual((await s.audit('pack e')).map((e) => `${e.action}: ${e.details}`), [
    'pack extra add: mods/pregen.jar',
    'pack extra change: config/custom.cfg: new file',
    'pack extra change: mods/journeymap-fairplay.jar',
    'pack extra remove: config/forge.cfg',
    'pack edit add: startserver.sh: -Xmx6G → -Xmx12G',
    'pack extra remove: mods/pregen.jar',
    'pack edit change: startserver.sh: -Xmx6G → -Xmx16G',
    'pack edit remove: startserver.sh: -Xmx6G → -Xmx16G',
  ]);
});

test('Extras and edits are refused outside the folder, at a Kept path, at the Mod jar or a .pre-update folder; a bad regex is 400', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  assert.equal((await s.req('POST', '/api/servers/gtnh/pack/edits', { path: 'startserver.sh', find: 'x', replace: 'y' })).status, 409); // adopt first
  await s.adopt();
  mkdirSync(join(w.root, 'elsewhere'));
  symlinkSync(join(w.root, 'elsewhere'), join(w.dir, 'outside'));
  for (const target of ['../evil.jar', '/etc/passwd', 'mods/../../evil.jar', 'outside/evil.jar', 'World/level.dat', 'server.properties', 'journeymap/x', 'config/JourneyMapServer/a.cfg', 'mods/gtnhdiscord-9.9.9.jar', '.pre-update-20261002-120000/mods/a.jar', '.orrery-staging/a', '', '.']) {
    const extra = await s.req('POST', '/api/servers/gtnh/pack/extras', { upload: await uploaded(s, w, 'x.jar', 'x'), target });
    assert.equal(extra.status, 400, `extra at ${target}: ${await extra.text()}`);
    const edit = await s.req('POST', '/api/servers/gtnh/pack/edits', { path: target, find: 'a', replace: 'b' });
    assert.equal(edit.status, 400, `edit of ${target}`);
  }
  assert.equal(await (await s.req('POST', '/api/servers/gtnh/pack/extras', { upload: await uploaded(s, w, 'x.jar', 'x'), target: 'mods/gtnhdiscord-2.0.0.jar' })).text(), "mods/gtnhdiscord-2.0.0.jar is the Mod's jar: deploy the Mod from Host.");
  const bad = await s.req('POST', '/api/servers/gtnh/pack/edits', { path: 'startserver.sh', find: '-Xmx(6G', replace: 'y' });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /^Find isn't a valid regex/);
  assert.equal((await s.req('POST', '/api/servers/gtnh/pack/extras', { upload: 'nope', target: 'mods/a.jar' })).status, 400);
  const twice = await s.req('POST', '/api/servers/gtnh/pack/extras', { upload: await uploaded(s, w, 'x.jar', 'x'), target: 'config/custom.cfg' });
  assert.equal(twice.status, 409);
  assert.equal((await s.req('PUT', '/api/servers/gtnh/pack/extras/999', { label: 'x' })).status, 404);
  assert.equal((await s.req('DELETE', '/api/servers/gtnh/pack/edits/abc')).status, 404);
  assert.deepEqual((await s.pack()).pending, []);
});

test('the preview counts the matches in the file on the server', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  write(w.dir, { 'config/gregtech.cfg': 'pollution=true\nheap=6G\nother_pollution=true\n' });
  const preview = (body: object) => s.req('POST', '/api/servers/gtnh/pack/edits/preview', body);
  assert.deepEqual(await s.json(preview({ path: 'config/gregtech.cfg', find: 'pollution=true$' })), { matches: 2 });
  assert.deepEqual(await s.json(preview({ path: 'config/gregtech.cfg', find: 'o' })), { matches: 2 }); // lines, not hits
  assert.deepEqual(await s.json(preview({ path: 'config/gregtech.cfg', find: '^pollution=true$' })), { matches: 1 });
  assert.deepEqual(await s.json(preview({ path: 'config/gregtech.cfg', find: 'nothing' })), { matches: 0 });
  assert.equal((await preview({ path: 'config/missing.cfg', find: 'x' })).status, 404);
  assert.equal((await preview({ path: 'config/gregtech.cfg', find: '(' })).status, 400);
  assert.equal((await preview({ path: '../gtnh/config/gregtech.cfg', find: 'x' })).status, 400);
});

/** Adopts 2.7.4, adds an Extra replacing a 2.7.5 file and an edit on an Extra's file, with the Mod online. */
async function updatable(t: TestContext, setup: Setup = {}) {
  const w = world(t);
  const s = await start(t, w, setup);
  await s.connect();
  await s.adopt();
  await s.json(s.req('POST', '/api/servers/gtnh/pack/extras', { upload: await uploaded(s, w, 'bq.jar', 'bq pinned'), target: 'mods/bq.jar', label: '3.4' }));
  await s.json(s.req('POST', '/api/servers/gtnh/pack/edits', { path: 'startserver.sh', find: '-Xmx(\\d+)G', replace: '-Xmx12G -Dold=$1', note: 'heap' }));
  await s.json(s.req('POST', '/api/servers/gtnh/pack/edits', { path: 'config/custom.cfg', find: '^our', replace: 'my' }));
  return { w, s };
}
const toNew = { url: URL_NEW, name: 'GT New Horizons', version: '2.7.5' };

test('an update onto a new version swaps exactly the old manifest for the staged set, with a backup and a hello', async (t) => {
  const { w, s } = await updatable(t);
  const res = await s.req('POST', '/api/servers/gtnh/pack/update', toNew);
  assert.equal(res.status, 202);
  const { id } = (await res.json()) as { id: number };
  const row = await s.finished();
  assert.equal(row.id, id);
  assert.deepEqual({ ...row, started: 0, finished: 0, log: '' }, {
    id,
    from: '2.7.4',
    to: '2.7.5',
    changes: null,
    by: 'alex',
    started: 0,
    finished: 0,
    outcome: 'ok',
    step: 'gate',
    backup: '2026-10-02-12-00-00.zip',
    log: '',
  });
  const files = snapshot(w.dir);
  const read = (p: string) => readFileSync(join(w.dir, p), 'utf8');
  assert.ok(!('mods/old-only.jar' in files)); // only in the old pack
  assert.equal(read('mods/new-only.jar'), 'new in 2.7.5');
  assert.equal(read('mods/gregtech.jar'), 'gt 2');
  assert.equal(read('mods/bq.jar'), 'bq pinned'); // the Extra over the pack's file
  assert.equal(read('config/forge.cfg'), 'changed on the server'); // kept at adopt
  assert.equal(read('startserver.sh'), 'java -Xmx12G -Dold=6 -jar forge.jar\n'); // edits last, with $1
  assert.equal(read('config/custom.cfg'), 'my own config'); // an edit of an Extra's file
  assert.equal(read('mods/gtnhdiscord-1.4.0.jar'), 'the Mod');
  for (const kept of ['World/level.dat', 'World/region/r.0.0.mca', 'server.properties', 'ops.json', 'logs/latest.log', 'journeymap/data.dat', 'config/JourneyMapServer/world.cfg']) {
    assert.equal(read(kept), { ...SERVER_OWN, 'config/forge.cfg': '' }[kept], kept);
  }
  const pre = readdirSync(w.dir).find((f) => f.startsWith('.pre-update-'))!;
  assert.match(pre, /^\.pre-update-\d{8}-\d{6}$/);
  assert.equal(readFileSync(join(w.dir, pre, 'mods/old-only.jar'), 'utf8'), 'gone in 2.7.5');
  assert.equal(readFileSync(join(w.dir, pre, 'mods/gtnhdiscord-1.4.0.jar'), 'utf8'), 'the Mod');
  assert.ok(!existsSync(join(w.dir, '.orrery-staging')));
  const p = await s.pack();
  assert.deepEqual([p.installed!.version, p.installed!.how, p.installed!.source, p.pending, p.running], ['2.7.5', 'updated', URL_NEW, [], null]);
  assert.deepEqual(s.systemctl(), ['stop gtnh.service', 'start gtnh.service']);
  assert.deepEqual(
    s.events.filter((e) => e.kind !== 'packUpdateStep').map((e) => ({ ...e, ...('ms' in e && { ms: 0 }) })),
    [
      { severity: 'info', kind: 'packUpdateStarted', from: '2.7.4', to: '2.7.5', by: 'alex' },
      { severity: 'good', kind: 'packUpdateFinished', outcome: 'ok', from: '2.7.4', to: '2.7.5', ms: 0 },
    ],
  );
  assert.deepEqual(await s.audit('pack update'), [
    { actor: ACTOR, action: 'pack update', target: 'gtnh', details: '2.7.4 → 2.7.5' },
    { actor: ACTOR, action: 'pack update', target: 'gtnh', details: '2.7.4 → 2.7.5: ok' },
  ]);
  // The next update replaces this .pre-update folder.
  await s.json(s.req('POST', '/api/servers/gtnh/pack/edits', { path: 'config/gregtech.cfg', find: 'new=1', replace: 'new=2' }));
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', { pending: true }), 202);
  s.events.length = 0;
  assert.equal((await s.finished()).outcome, 'ok');
  assert.equal(readdirSync(w.dir).filter((f) => f.startsWith('.pre-update-')).length, 1);
});

test('applying pending changes onto the installed version, and refusing with nothing pending', async (t) => {
  const { w, s } = await updatable(t);
  const p = await s.pack();
  assert.deepEqual(p.pending.map((x) => `${x.path} ${x.change}`), ['mods/bq.jar added', 'config/custom.cfg added', 'startserver.sh added']);
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', { pending: true }), 202);
  const row = await s.finished();
  assert.deepEqual([row.from, row.to, row.outcome, row.changes], ['2.7.4', '2.7.4', 'ok', ['mods/bq.jar added', 'config/custom.cfg added', 'startserver.sh added']]);
  assert.equal(readFileSync(join(w.dir, 'mods/bq.jar'), 'utf8'), 'bq pinned');
  assert.equal(readFileSync(join(w.dir, 'mods/old-only.jar'), 'utf8'), 'gone in 2.7.5'); // still 2.7.4
  assert.equal(readFileSync(join(w.dir, 'startserver.sh'), 'utf8'), 'java -Xmx12G -Dold=6 -jar forge.jar\n');
  assert.deepEqual((await s.pack()).pending, []);
  const again = await s.req('POST', '/api/servers/gtnh/pack/update', { pending: true });
  assert.equal(again.status, 409);
  assert.equal(await again.text(), 'Nothing is pending: 2.7.4 is installed as it is.');
  // The same zip and version, by upload or from the same URL, with nothing pending, is refused as well.
  const same = await s.req('POST', '/api/servers/gtnh/pack/update', { url: URL_OLD, name: 'GT New Horizons', version: '2.7.4' });
  assert.equal(same.status, 409);
  assert.equal(await same.text(), 'GT New Horizons 2.7.4 is installed already, with nothing pending.');
  const up = await s.json<UploadAnswer>(s.upload(w.urls[URL_OLD]!));
  assert.equal((await s.req('POST', '/api/servers/gtnh/pack/update', { upload: up.upload, name: 'GT New Horizons', version: '2.7.4' })).status, 409);
  assert.match(await s.audit('pack update').then((a) => a[0]!.details), /^changes applied to 2\.7\.4: mods\/bq\.jar added/);
});

test('a removed Extra is deleted by the next apply, and its row and file go once it is ok', async (t) => {
  const { w, s } = await updatable(t);
  let p = await s.pack();
  p = await s.json(s.req('DELETE', `/api/servers/gtnh/pack/extras/${p.extras.find((e) => e.target === 'mods/journeymap-fairplay.jar')!.id}`));
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', { pending: true }), 202);
  assert.equal((await s.finished()).outcome, 'ok');
  assert.ok(!existsSync(join(w.dir, 'mods/journeymap-fairplay.jar')));
  p = await s.pack();
  assert.ok(!p.extras.some((e) => e.target === 'mods/journeymap-fairplay.jar'));
  assert.equal(readdirSync(join(w.root, 'data', 'extras', 'gtnh')).length, p.extras.length);
});

for (const [why, setup, expected] of [
  ['the download fails', (w: World) => delete w.urls[URL_NEW], 'Downloading the pack failed: HTTP 404'],
  ['the zip has no content root', (w: World) => (w.urls[URL_NEW] = w.zip('bad.zip', { 'readme.txt': 'x' })), 'The zip has no mods/ or config/ folder: is it a server pack?'],
  ['an edit matches nothing', null, 'The Config edit on config/gregtech.cfg (pollution=false) matched nothing in 2.7.5.'],
  ['the backup fails', null, 'The backup failed: disk full'],
] as const) {
  test(`when ${why}, the update fails in staging with the server folder unchanged and the server running`, async (t) => {
    const { w, s } = await updatable(t);
    if (typeof setup === 'function') setup(w);
    if (why === 'an edit matches nothing') await s.json(s.req('POST', '/api/servers/gtnh/pack/edits', { path: 'config/gregtech.cfg', find: 'pollution=false', replace: 'x' }));
    if (why === 'the backup fails') s.fake.backupFails = true;
    const before = snapshot(w.dir);
    await s.json(s.req('POST', '/api/servers/gtnh/pack/update', toNew), 202);
    const row = await s.finished();
    assert.equal(row.outcome, 'failed in staging');
    assert.ok(row.log.includes(expected), row.log);
    assert.deepEqual(snapshot(w.dir), before);
    assert.deepEqual(s.systemctl(), []);
    assert.equal((await s.json<ServerCard[]>(s.req('GET', '/api/servers')))[0]!.online, true);
    const p = await s.pack();
    assert.equal(p.installed!.version, '2.7.4');
    assert.equal(p.running, null);
    if (why === 'an edit matches nothing') assert.equal(p.edits.find((e) => e.path === 'config/gregtech.cfg')!.failedOn, '2.7.5');
    assert.deepEqual(readdirSync(join(w.root, 'data', 'uploads')), []);
    const finished = s.events.find((e) => e.kind === 'packUpdateFinished')!;
    assert.deepEqual([finished.severity, 'outcome' in finished && finished.outcome], ['info', 'failed in staging']);
  });
}

test('an update is refused while one runs, without a pack, offline, and for bad input', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  const update = (body: object = toNew) => s.req('POST', '/api/servers/gtnh/pack/update', body);
  assert.equal(await (await update()).text(), "orrery doesn't know GTNH's pack yet: adopt it first.");
  await s.adopt();
  const offline = await update();
  assert.equal(offline.status, 409);
  assert.equal(await offline.text(), 'GTNH is offline: an update needs it running, for the backup.');
  await s.connect();
  for (const body of [{}, { url: 'ftp://x', name: 'a', version: '1' }, { url: URL_NEW, name: '', version: '1' }, { pending: 'yes' }]) {
    assert.equal((await update(body)).status, 400, JSON.stringify(body));
  }
  s.fake.downloadGate = new Promise(() => {}); // holds the first update in Prepare
  assert.equal((await update()).status, 202);
  const twice = await update();
  assert.equal(twice.status, 409);
  assert.equal(await twice.text(), 'A pack update is already running on GTNH.');
  assert.equal((await s.req('POST', '/api/servers/nope/pack/update', toNew)).status, 404);
});

test('files the pack lacks that Adopt did not keep are dropped by the next update, into the .pre-update folder', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  await s.connect();
  await s.adopt(['mods/journeymap-fairplay.jar']);
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', toNew), 202);
  assert.equal((await s.finished()).outcome, 'ok');
  assert.ok(!existsSync(join(w.dir, 'config/custom.cfg')));
  assert.equal(readFileSync(join(w.dir, 'mods/journeymap-fairplay.jar'), 'utf8'), 'a third-party mod');
  assert.equal(readFileSync(join(w.dir, 'config/forge.cfg'), 'utf8'), 'forge defaults'); // the pack's again
  const pre = readdirSync(w.dir).find((f) => f.startsWith('.pre-update-'))!;
  assert.equal(readFileSync(join(w.dir, pre, 'config/custom.cfg'), 'utf8'), 'our own config');
});

test('each step goes on the stream, the replay keeps only the latest, none is posted, and the state shows the running update', async (t) => {
  const { s } = await updatable(t);
  let release!: () => void;
  s.fake.downloadGate = new Promise((r) => (release = r));
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', toNew), 202);
  await until(() => s.events.some((e) => e.kind === 'packUpdateStep'));
  const running = (await s.pack()).running!;
  assert.deepEqual({ ...running, id: 0, started: 0 }, {
    id: 0,
    name: 'GT New Horizons',
    version: '2.7.5',
    by: 'alex',
    started: 0,
    cancellable: true,
    steps: [
      { step: 'prepare', state: 'running', detail: 'Getting the pack' },
      { step: 'backup', state: 'waiting', detail: '' },
      { step: 'stop', state: 'waiting', detail: '' },
      { step: 'swap', state: 'waiting', detail: '' },
      { step: 'gate', state: 'waiting', detail: '' },
    ],
  });
  assert.deepEqual((await s.pack()).blocked, 'A pack update is running on GTNH.');
  assert.deepEqual((await s.json<ServerCard[]>(s.req('GET', '/api/servers')))[0]!.packUpdate, { running: true, rolledBack: null });
  release();
  await s.finished();
  const steps = s.events.filter((e) => e.kind === 'packUpdateStep');
  assert.ok(steps.length >= 10);
  const done = steps.flatMap((e) => (e.kind === 'packUpdateStep' && e.state === 'done' ? [`${e.step}: ${e.detail}`] : []));
  assert.deepEqual(done.slice(0, 3), ['prepare: Staged: 8 files', 'backup: 2026-10-02-12-00-00.zip', 'stop: Stopped']);
  assert.match(done[3]!, /^swap: Swapped: 9 files in, old ones in \.pre-update-\d{8}-\d{6}\/$/);
  assert.match(done[4]!, /^gate: Hello after 0:0\d$/);
  for (const e of steps) assert.equal(formatEvent({ ...e, type: 'notice', serverId: 'gtnh' }), null);
  const replay = s.handle.live.since().map(([, e]) => e).filter((e) => 'serverId' in e && e.type === 'notice' && e.kind === 'packUpdateStep');
  assert.deepEqual(replay, []); // the finished update took its latest step with it
});

test("a running update's latest step is replayed, and only that", async (t) => {
  const { s } = await updatable(t);
  s.fake.downloadGate = new Promise(() => {});
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', toNew), 202);
  await until(() => s.events.filter((e) => e.kind === 'packUpdateStep').length >= 1);
  const replay = s.handle.live.since().map(([, e]) => e).filter((e) => 'serverId' in e && e.type === 'notice' && e.kind === 'packUpdateStep');
  assert.equal(replay.length, 1);
});

test('Cancel while preparing stops the download and ends the update as cancelled with nothing touched', async (t) => {
  const { w, s } = await updatable(t);
  s.fake.downloadGate = new Promise(() => {}); // a download that would never end
  const before = snapshot(w.dir);
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', toNew), 202);
  await until(() => s.fake.downloads.length === 1);
  assert.equal((await s.pack()).running!.cancellable, true);
  assert.equal((await s.req('POST', '/api/servers/gtnh/pack/update/cancel')).status, 204);
  const row = await s.finished();
  assert.equal(row.outcome, 'cancelled');
  assert.deepEqual(snapshot(w.dir), before);
  assert.deepEqual(s.systemctl(), []);
  assert.deepEqual((await s.audit('pack update cancel')).map((e) => e.details), ['2.7.4 → 2.7.5']);
  assert.equal((await s.req('POST', '/api/servers/gtnh/pack/update/cancel')).status, 409); // nothing running
});

test('with players online the stop counts down; cancelling it, here or anywhere, ends the update as cancelled', async (t) => {
  for (const from of ['pack', 'restart']) {
    const { w, s } = await updatable(t);
    s.fake.players = ['Steve'];
    s.mod().send({ type: 'heartbeat', tps: 20, players: ['Steve'] });
    await sleep(20);
    const before = snapshot(w.dir);
    await s.json(s.req('POST', '/api/servers/gtnh/pack/update', toNew), 202);
    await until(() => s.events.some((e) => e.kind === 'packUpdateStep' && e.step === 'stop' && e.cancellable && e.detail.startsWith('1 player online: stopping in')), 5000);
    const card = (await s.json<ServerCard[]>(s.req('GET', '/api/servers')))[0]!;
    assert.equal(card.restart?.stop, true);
    assert.equal((await s.pack()).running!.cancellable, true);
    const cancel = from === 'pack' ? '/api/servers/gtnh/pack/update/cancel' : '/api/servers/gtnh/restart/cancel';
    assert.equal((await s.req('POST', cancel)).status, 204, from);
    const row = await s.finished();
    assert.equal(row.outcome, 'cancelled', from);
    assert.deepEqual(snapshot(w.dir), before, from); // the backup went to its folder, outside the server's
    assert.deepEqual(s.systemctl(), [], from);
    assert.equal(row.backup, '2026-10-02-12-00-00.zip');
    await s.close();
  }
});

test('Cancel after the server was stopped is 409', async (t) => {
  const { s } = await updatable(t, { comesBack: () => false, gateMs: 3_000 });
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', toNew), 202);
  await until(() => s.events.some((e) => e.kind === 'packUpdateStep' && e.step === 'gate' && e.state === 'running'), 5000);
  assert.equal((await s.pack()).running!.cancellable, false);
  const res = await s.req('POST', '/api/servers/gtnh/pack/update/cancel');
  assert.equal(res.status, 409);
  assert.equal(await res.text(), 'Too late to cancel: only while preparing or during the countdown.');
  s.fake.comesBack = () => true;
  await s.finished();
});

test('no hello within the gate rolls back to exactly the old files, offering the pre-update backup until a restore', async (t) => {
  let restored = 0;
  const restore: RunRestore = async () => (restored++, 'Restored.');
  // The new files never say hello (the 1st start); the old ones do (the 2nd).
  const { w, s } = await updatable(t, { gateMs: 300, restore, comesBack: (n) => n === 2 });
  const before = snapshot(w.dir);
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', toNew), 202);
  const row = await s.finished();
  assert.equal(row.outcome, 'rolled back', row.log);
  assert.equal(row.backup, '2026-10-02-12-00-00.zip');
  const after = snapshot(w.dir);
  const pre = Object.keys(after).find((f) => f.startsWith('.pre-update-'))!.split('/')[0]!;
  for (const f of Object.keys(after)) if (f.startsWith(`${pre}/`)) delete after[f];
  assert.deepEqual(after, before);
  assert.equal(readFileSync(join(w.dir, pre, 'mods/old-only.jar'), 'utf8'), 'gone in 2.7.5'); // kept for recovery by hand
  assert.deepEqual(s.systemctl(), ['stop gtnh.service', 'start gtnh.service', 'stop gtnh.service', 'start gtnh.service']);
  const p = await s.pack();
  assert.deepEqual([p.installed!.version, p.installed!.source], ['2.7.4', URL_OLD]);
  assert.deepEqual(p.pending.map((x) => x.path), ['mods/bq.jar', 'config/custom.cfg', 'startserver.sh']); // still pending
  assert.deepEqual(p.rolledBack, { to: '2.7.5', backup: '2026-10-02-12-00-00.zip' });
  assert.deepEqual((await s.json<ServerCard[]>(s.req('GET', '/api/servers')))[0]!.packUpdate, { running: false, rolledBack: p.rolledBack });
  const finished = s.events.find((e) => e.kind === 'packUpdateFinished')!;
  assert.deepEqual({ ...finished, ms: 0 }, { severity: 'problem', kind: 'packUpdateFinished', outcome: 'rolled back', from: '2.7.4', to: '2.7.5', ms: 0, backup: '2026-10-02-12-00-00.zip' });
  // A restore ends the offer. (The rollback's last read of the unit saw it stopped.)
  s.state['gtnh.service'] = 'inactive';
  assert.equal((await s.req('POST', '/api/servers/gtnh/restore', { name: '2026-10-02-12-00-00.zip' })).status, 200);
  assert.equal(restored, 1);
  assert.equal((await s.pack()).rolledBack, null);
  assert.deepEqual((await s.json<ServerCard[]>(s.req('GET', '/api/servers')))[0]!.packUpdate, { running: false, rolledBack: null });
});

test('no hello after the rollback either ends as failed, leaving the .pre-update folder and naming it', async (t) => {
  const { w, s } = await updatable(t, { gateMs: 200, comesBack: () => false });
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', toNew), 202);
  const row = await s.finished();
  assert.equal(row.outcome, 'failed');
  const pre = readdirSync(w.dir).find((f) => f.startsWith('.pre-update-'))!;
  assert.ok(row.log.includes(`The old files are in ${pre}/`), row.log);
  assert.equal(readFileSync(join(w.dir, 'mods/old-only.jar'), 'utf8'), 'gone in 2.7.5'); // the old files are back all the same
  assert.equal(readFileSync(join(w.dir, pre, 'mods/old-only.jar'), 'utf8'), 'gone in 2.7.5');
  const finished = s.events.find((e) => e.kind === 'packUpdateFinished')!;
  assert.deepEqual([finished.severity, 'outcome' in finished && finished.outcome], ['problem', 'failed']);
  assert.equal((await s.pack()).rolledBack, null);
});

test('an update left running by the last hub is closed as interrupted, naming its step and the .pre-update folder', async (t) => {
  const w = world(t);
  let s = await start(t, w);
  await s.connect();
  await s.adopt();
  s.fake.comesBack = () => false;
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', toNew), 202);
  await until(() => s.events.some((e) => e.kind === 'packUpdateStep' && e.step === 'gate' && e.state === 'running'), 5000);
  await s.close(); // mid-gate, as a hub restart would
  const pre = readdirSync(w.dir).find((f) => f.startsWith('.pre-update-'))!;
  s = await start(t, w);
  const row = (await s.pack()).history[0]!;
  assert.equal(row.outcome, 'failed', row.log);
  assert.ok(row.log.endsWith(`interrupted during gate: the hub restarted. The old files are in ${pre}/`), row.log);
  assert.equal((await s.pack()).running, null);
});

test('a pack update and a restore refuse each other (GitHub off: no deploys to ask)', async (t) => {
  // A pack update holds a restore off.
  let gate!: () => void;
  const restore: RunRestore = () => new Promise((r) => (gate = () => r('Restored.')));
  const { w: first, s } = await updatable(t, { restore });
  write(first.backupDir, { '2026-10-02-12-00-00.zip': 'backup' });
  s.fake.downloadGate = new Promise(() => {});
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', toNew), 202);
  const refused = await s.req('POST', '/api/servers/gtnh/restore', { name: '2026-10-02-12-00-00.zip' });
  assert.equal(refused.status, 409);
  assert.equal(await refused.text(), 'A pack update is running on GTNH: restore once it is done.');
  await s.close();

  // A restore holds a pack update off (and says so in the state).
  const w = world(t);
  write(w.backupDir, { '2026-10-01-06-00-00.zip': 'backup' });
  const r = await start(t, w, { restore, unit: 'inactive' });
  await r.adopt();
  const restoring = r.req('POST', '/api/servers/gtnh/restore', { name: '2026-10-01-06-00-00.zip' });
  await until(() => gate !== undefined);
  await sleep(20);
  assert.equal((await r.pack()).blocked, 'A restore is running on GTNH.');
  const update = await r.req('POST', '/api/servers/gtnh/pack/update', toNew);
  assert.equal(update.status, 409);
  assert.equal(await update.text(), 'A restore is running on GTNH.');
  gate();
  assert.equal((await restoring).status, 200);
});

/** A fake GitHub with a hub and a Mod release. */
const github: HubDeps['github'] = {
  releases: async () => [
    { tag: 'hub-v2.7.0', draft: false, prerelease: false, publishedAt: 1, assets: [] },
    { tag: 'mod-v1.5.0', draft: false, prerelease: false, publishedAt: 1, assets: ['gtnhdiscord-1.5.0.jar'] },
  ],
  download: async () => new TextEncoder().encode('jar'),
};

async function withGithub(t: TestContext) {
  const w = world(t);
  mkdirSync(join(w.root, 'deploy-root'));
  w.config.integrations.github = {
    repo: 'Edward-Pratt/orrery',
    newerAfterDays: 14,
    deploys: { root: join(w.root, 'deploy-root'), hubUnit: 'orrery-hub.service', hubTemplate: 'orrery-deploy', webTemplate: 'orrery-deploy-web', webDir: join(w.root, 'www') },
  };
  const s = await start(t, w, { github });
  while (((await s.json<{ checkedAt: number | null }>(s.req('GET', '/api/deploys'))).checkedAt) === null) await sleep(5);
  await s.connect();
  await s.adopt();
  return { w, s };
}

test('a pack update and a Mod deploy onto the same server refuse each other', async (t) => {
  const { s } = await withGithub(t);
  s.fake.downloadGate = new Promise(() => {});
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', toNew), 202);
  assert.deepEqual((await s.json<{ packing: string[] }>(s.req('GET', '/api/deploys'))).packing, ['gtnh']);
  const deploy = await s.req('POST', '/api/deploys', { part: 'mod', tag: 'mod-v1.5.0', server: 'gtnh' });
  assert.equal(deploy.status, 409);
  assert.equal(await deploy.text(), 'A pack update is running on GTNH: deploy the Mod once it is done.');
  await s.close();

  const other = await withGithub(t);
  assert.equal((await other.s.req('POST', '/api/deploys', { part: 'mod', tag: 'mod-v1.5.0', server: 'gtnh' })).status, 202); // counts down
  assert.equal((await other.s.pack()).blocked, 'A Mod deploy onto GTNH is running.');
  const update = await other.s.req('POST', '/api/servers/gtnh/pack/update', toNew);
  assert.equal(update.status, 409);
  assert.equal(await update.text(), 'A Mod deploy onto GTNH is running.');
});

test('a pack update and a hub deploy refuse each other', async (t) => {
  const { s } = await withGithub(t);
  s.fake.downloadGate = new Promise(() => {});
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', toNew), 202);
  const deploy = await s.req('POST', '/api/deploys', { part: 'hub', tag: 'hub-v2.7.0' });
  assert.equal(deploy.status, 409);
  assert.equal(await deploy.text(), 'A pack update is running: deploy the hub once it is done.');
  await s.close();

  const other = await withGithub(t);
  assert.equal((await other.s.req('POST', '/api/deploys', { part: 'hub', tag: 'hub-v2.7.0' })).status, 202);
  const update = await other.s.req('POST', '/api/servers/gtnh/pack/update', toNew);
  assert.equal(update.status, 409);
  assert.equal(await update.text(), 'A hub deploy is running.');
});

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { AuditLog, DeploysAnswer, LiveEvent, TargetEvent } from '../src/api.ts';
import type { Config, ServerSettings } from '../src/config.ts';
import type { GitHubRelease } from '../src/deploys.ts';
import type { RunRestore } from '../src/restore.ts';
import type { Run } from '../src/services.ts';
import { startHub, type HubHandle } from '../src/start.ts';
import type { OAuth, WebApi } from '../src/web.ts';
import { fakeMod, hello, TOKEN, until } from './fake-mod.ts';

const DAY = 24 * 60 * 60_000;
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
const JARS = (v: string) => [`gtnhdiscord-${v}.jar`, `gtnhdiscord-${v}-dev.jar`, `gtnhdiscord-${v}-sources.jar`];
const rel = (tag: string, daysAgo: number, more: Partial<GitHubRelease> = {}): GitHubRelease => ({
  tag,
  draft: false,
  prerelease: false,
  publishedAt: Date.now() - daysAgo * DAY,
  assets: [],
  ...more,
});
const RELEASES = [
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
  const fake = { list: RELEASES, fails: false, downloadFails: false, calls: 0, downloads: [] as string[] };
  return Object.assign(fake, {
    releases: async () => {
      fake.calls++;
      if (fake.fails) throw new Error('GitHub: HTTP 503');
      return fake.list;
    },
    download: async (tag: string, asset: string) => {
      fake.downloads.push(`${tag} ${asset}`);
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
function world(t: TestContext, { servers, restore }: Setup = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-deploys-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'root');
  const serverDir = join(dir, 'gtnh');
  mkdirSync(join(serverDir, 'mods'), { recursive: true });
  mkdirSync(join(serverDir, 'backups'));
  mkdirSync(root);
  writeFileSync(join(serverDir, 'mods', 'gtnhdiscord-1.3.0.jar'), 'old jar');
  writeFileSync(join(serverDir, 'backups', '2026-09-26-06-00-00.zip'), 'zip');
  const gtnh: ServerSettings = {
    id: 'gtnh',
    name: 'GTNH',
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

type World = ReturnType<typeof world>;

/** Starts a hub on a world, logs in, and waits for its first look at GitHub. */
async function start(t: TestContext, w: World, setup: Setup = {}) {
  const handle: HubHandle = await startHub(w.config, {
    startFrontend: () => assert.fail('Discord is off'),
    get: () => assert.fail('nothing to request'),
    oauth,
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
  const login = await app.request('/api/callback?code=x&state=s', { headers: { cookie: 'state=s' } });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('session='))!.split(';')[0]!;
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
async function modRunning(port: number, modVersion: string) {
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

const status = (w: World, s: object) => writeFileSync(join(w.root, 'deploy-status.json'), JSON.stringify(s));
const rows = async (s: Awaited<ReturnType<typeof start>>) =>
  (await s.get()).history.map(({ part, target, from, to, by, outcome, log }) => ({ part, target, from, to, by, outcome, log }));

test('releases per part, newest first, without drafts, prereleases or foreign tags; a plain checkout runs dev', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  const a = await s.get();
  assert.deepEqual(a.hub.releases.map((r) => r.tag), ['hub-v2.7.0', 'hub-v2.6.0', 'hub-v2.5.1']);
  assert.deepEqual(a.hub, { running: 'dev', latest: 'hub-v2.7.0', releases: a.hub.releases });
  assert.deepEqual(a.web.releases.map((r) => r.tag), ['web-v0.5.0', 'web-v0.4.1']);
  assert.equal(a.web.running, null); // no stamp, no deploy yet: unknown
  assert.deepEqual(a.mod.releases[0]!.assets, JARS('1.4.0'));
  assert.deepEqual(a.mod.servers, [{ id: 'gtnh', name: 'GTNH', running: null }]);
  assert.equal(a.error, null);
  assert.equal(a.newerAfterDays, 14);
  assert.deepEqual(a.history, []);
});

test('the hub runs the release `current` points at, the dashboard its stamp, a Mod its hello', async (t) => {
  const w = world(t);
  mkdirSync(join(w.root, 'releases', 'hub-v2.6.0'), { recursive: true });
  symlinkSync(join(w.root, 'releases', 'hub-v2.6.0'), join(w.root, 'current'));
  writeFileSync(`${w.config.integrations.github!.deploys.webDir}.release`, 'web-v0.4.1\n');
  const s = await start(t, w);
  const mod = await modRunning(s.port, '1.3.0');
  let a = await s.get();
  assert.equal(a.hub.running, 'hub-v2.6.0');
  assert.equal(a.web.running, 'web-v0.4.1');
  assert.deepEqual(a.mod.servers, [{ id: 'gtnh', name: 'GTNH', running: 'mod-v1.3.0' }]);
  mod.socket.destroy();
  await modRunning(s.port, '1.3.0-2-gabc123'); // a build between releases shows as it is
  a = await s.get();
  assert.equal(a.mod.servers[0]!.running, '1.3.0-2-gabc123');
});

test('a failed check is reported without failing, keeping the last list; Check now asks again', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  w.github.fails = true;
  const res = await s.post('/api/deploys/check');
  assert.equal(res.status, 200);
  const a = (await res.json()) as DeploysAnswer;
  assert.equal(a.error, 'GitHub: HTTP 503');
  assert.equal(a.hub.latest, 'hub-v2.7.0');
  assert.equal(w.github.calls, 2);
  w.github.fails = false;
  w.github.list = [...RELEASES, rel('hub-v2.9.0', 0)];
  assert.equal(((await (await s.post('/api/deploys/check')).json()) as DeploysAnswer).hub.latest, 'hub-v2.9.0');
});

test('with GitHub off there are no deploy routes and no reader is needed', async (t) => {
  const w = world(t);
  delete w.config.integrations.github;
  const handle = await startHub(w.config, { startFrontend: () => assert.fail(), get: () => assert.fail(), oauth });
  t.after(() => handle.close());
  const app = handle.web!.app;
  const login = await app.request('/api/callback?code=x&state=s', { headers: { cookie: 'state=s' } });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('session='))!.split(';')[0]!;
  assert.equal((await app.request('/api/deploys', { headers: { cookie } })).status, 404);
  assert.equal(((await (await app.request('/api/integrations', { headers: { cookie } })).json()) as { github: boolean }).github, false);
});

test('a hub deploy records a running row, copies the database, audits, announces, and starts exactly its unit', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  const res = await s.deploy({ part: 'hub', tag: 'hub-v2.7.0' });
  assert.equal(res.status, 202);
  assert.deepEqual(w.systemd.starts(), ['orrery-deploy@hub-v2.7.0.service']);
  assert.deepEqual(await rows(s), [{ part: 'hub', target: 'production', from: 'dev', to: 'hub-v2.7.0', by: ACTOR, outcome: 'running', log: '' }]);
  assert.ok(readdirSync(join(w.root, 'db-backups')).some((f) => f.startsWith('hub-before-hub-v2.7.0-')));
  assert.deepEqual(await s.audit(), [{ actor: ACTOR, target: 'production', details: 'hub dev → hub-v2.7.0' }]);
  assert.deepEqual(s.notices, [
    { target: 'deploy', id: 'production', type: 'notice', severity: 'info', kind: 'deployStarted', part: 'hub', from: 'dev', to: 'hub-v2.7.0', by: ACTOR },
  ]);
  // One at a time.
  assert.equal((await s.deploy({ part: 'web', tag: 'web-v0.5.0' })).status, 409);
});

test('the hub started by a deploy closes its row from the status file once the unit is done', async (t) => {
  const w = world(t);
  const first = await start(t, w);
  await first.deploy({ part: 'hub', tag: 'hub-v2.7.0' });
  await first.close();
  // The new hub comes up during the gate: the unit still runs, and an old status file isn't this deploy's.
  status(w, { tag: 'hub-v2.7.0', from: 'dev', outcome: 'rolled back', finished: new Date(Date.now() - DAY).toISOString(), log: 'old' });
  const s = await start(t, w);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await rows(s))[0]!.outcome, 'running');
  status(w, { tag: 'hub-v2.7.0', from: 'dev', outcome: 'ok', finished: new Date().toISOString(), log: 'cloned\nflipped\nstayed up' });
  w.systemd.states['orrery-deploy@hub-v2.7.0.service'] = 'inactive';
  await until(() => s.notices.length > 0);
  assert.deepEqual((await rows(s))[0], { part: 'hub', target: 'production', from: 'dev', to: 'hub-v2.7.0', by: ACTOR, outcome: 'ok', log: 'cloned\nflipped\nstayed up' });
  assert.deepEqual(s.notices, [
    { target: 'deploy', id: 'production', type: 'notice', severity: 'good', kind: 'deployFinished', part: 'hub', from: 'dev', to: 'hub-v2.7.0', outcome: 'ok' },
  ]);
});

test('a hub deploy that rolled back keeps its log; one that left no status is closed as interrupted', async (t) => {
  const w = world(t);
  const first = await start(t, w);
  await first.deploy({ part: 'hub', tag: 'hub-v2.7.0' });
  w.systemd.states['orrery-deploy@hub-v2.7.0.service'] = 'failed';
  status(w, { tag: 'hub-v2.7.0', from: 'dev', outcome: 'rolled back', finished: new Date().toISOString(), log: 'MainPID changed' });
  await until(() => first.notices.length === 2);
  assert.equal(first.notices[1]!.type === 'notice' && first.notices[1]!.severity, 'problem');
  assert.deepEqual((await rows(first))[0]!.log, 'MainPID changed');

  rmSync(join(w.root, 'deploy-status.json'));
  await first.deploy({ part: 'hub', tag: 'hub-v2.6.0' });
  await first.close();
  w.systemd.states['orrery-deploy@hub-v2.6.0.service'] = 'inactive'; // the host rebooted mid-way
  const s = await start(t, w); // closed while it started, before this test listened for notices
  assert.deepEqual((await rows(s)).map((r) => [r.to, r.outcome, r.log]), [
    ['hub-v2.6.0', 'failed', 'interrupted: the deploy unit ended without reporting'],
    ['hub-v2.7.0', 'rolled back', 'MainPID changed'],
  ]);
});

test('refusals: an unknown tag, the running tag, a release below the floor, a bad request', async (t) => {
  const w = world(t);
  mkdirSync(join(w.root, 'releases', 'hub-v2.6.0'), { recursive: true });
  symlinkSync(join(w.root, 'releases', 'hub-v2.6.0'), join(w.root, 'current'));
  const s = await start(t, w);
  const refused = async (body: object) => {
    const res = await s.deploy(body);
    return [res.status, await res.text()];
  };
  assert.deepEqual(await refused({ part: 'hub', tag: 'hub-v9.9.9' }), [404, 'No published release hub-v9.9.9.']);
  assert.deepEqual(await refused({ part: 'hub', tag: 'hub-v2.8.0' }), [404, 'No published release hub-v2.8.0.']); // a draft
  assert.deepEqual(await refused({ part: 'web', tag: 'hub-v2.7.0' }), [404, 'No published release hub-v2.7.0.']);
  assert.deepEqual(await refused({ part: 'hub', tag: 'hub-v2.6.0' }), [409, 'hub-v2.6.0 is already running.']);
  assert.deepEqual(await refused({ part: 'hub', tag: 'hub-v2.5.1' }), [409, 'hub-v2.5.1 is older than hub-v2.6.0, the first release that can deploy.']);
  assert.deepEqual(await refused({ part: 'web', tag: 'web-v0.4.1' }), [409, 'web-v0.4.1 is older than web-v0.5.0, the first release that can deploy.']);
  assert.equal((await s.deploy({ part: 'mod', tag: 'mod-v1.4.0' })).status, 400);
  assert.equal((await s.deploy({ part: 'hub; rm', tag: 'hub-v2.7.0' })).status, 400);
  assert.deepEqual(w.systemd.starts(), []);
  assert.deepEqual(await rows(s), []);
});

test('a dashboard deploy starts its unit and closes its row when the unit is done', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  assert.equal((await s.deploy({ part: 'web', tag: 'web-v0.5.0' })).status, 202);
  assert.deepEqual(w.systemd.starts(), ['orrery-deploy-web@web-v0.5.0.service']);
  assert.ok(!existsSync(join(w.root, 'db-backups'))); // only a hub deploy copies the database
  status(w, { tag: 'web-v0.5.0', from: null, outcome: 'ok', finished: new Date().toISOString(), log: 'installed' });
  w.systemd.states['orrery-deploy-web@web-v0.5.0.service'] = 'inactive';
  await until(() => s.notices.length === 2);
  const a = await s.get();
  assert.equal(a.web.running, 'web-v0.5.0');
  assert.deepEqual((await rows(s))[0], { part: 'web', target: 'production', from: null, to: 'web-v0.5.0', by: ACTOR, outcome: 'ok', log: 'installed' });
});

test('a deploy whose systemctl fails answers 502 and closes its row failed', async (t) => {
  const w = world(t);
  const run = w.systemd.run;
  w.systemd.run = async (command, args) => (args[0] === 'start' ? Promise.reject(new Error('Access denied')) : run(command, args));
  const s = await start(t, w);
  const res = await s.deploy({ part: 'web', tag: 'web-v0.5.0' });
  assert.deepEqual([res.status, await res.text()], [502, 'The deploy failed: Access denied']);
  assert.deepEqual((await rows(s)).map((r) => [r.outcome, r.log]), [['failed', 'systemctl failed: Access denied']]);
});

test('restores and hub deploys exclude each other', async (t) => {
  let release!: () => void;
  const restore: RunRestore = async () => new Promise<string>((r) => (release = () => r('restored')));
  const w = world(t, { restore });
  const s = await start(t, w, { restore });
  await until(() => w.systemd.calls.some((c) => c.at(-1) === 'gtnh.service'));
  await new Promise((r) => setImmediate(r)); // the hub has read that the server's service is stopped
  const restoring = s.post('/api/servers/gtnh/restore', { name: '2026-09-26-06-00-00.zip' });
  await until(() => release !== undefined);
  const refused = await s.deploy({ part: 'hub', tag: 'hub-v2.7.0' });
  assert.deepEqual([refused.status, await refused.text()], [409, 'A restore is running: deploy the hub once it is done.']);
  release();
  assert.equal((await restoring).status, 200);

  assert.equal((await s.deploy({ part: 'hub', tag: 'hub-v2.7.0' })).status, 202);
  const res = await s.post('/api/servers/gtnh/restore', { name: '2026-09-26-06-00-00.zip' });
  assert.deepEqual([res.status, await res.text()], [409, 'A hub deploy is running: restore once it is done.']);
});

const jars = (w: World) => readdirSync(join(w.serverDir, 'mods')).sort();

test('a Mod deploy onto a stopped server puts exactly the new jar in place', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  assert.equal((await s.deploy({ part: 'mod', tag: 'mod-v1.4.0', server: 'gtnh' })).status, 202);
  assert.deepEqual(w.github.downloads, ['mod-v1.4.0 gtnhdiscord-1.4.0.jar']);
  assert.deepEqual(jars(w), ['gtnhdiscord-1.4.0.jar']);
  assert.equal(readFileSync(join(w.serverDir, 'mods', 'gtnhdiscord-1.4.0.jar'), 'utf8'), 'jar mod-v1.4.0');
  assert.deepEqual(await rows(s), [{ part: 'mod', target: 'gtnh', from: null, to: 'mod-v1.4.0', by: ACTOR, outcome: 'ok', log: 'applied at next start' }]);
  assert.deepEqual(s.notices.map((n) => n.type === 'notice' && n.kind), ['deployStarted', 'deployFinished']);
});

test('a Mod deploy onto a running server swaps at the end of the countdown and is ok once the new Mod says hello', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  const old = await modRunning(s.port, '1.3.0');
  assert.equal((await s.deploy({ part: 'mod', tag: 'mod-v1.4.0', server: 'gtnh' })).status, 202);
  await old.closed; // told to stop
  assert.deepEqual(jars(w), ['gtnhdiscord-1.4.0.jar']);
  assert.equal((await rows(s))[0]!.outcome, 'running');
  await modRunning(s.port, '1.4.0');
  await until(() => s.notices.length === 2);
  assert.deepEqual((await rows(s)).map((r) => [r.from, r.outcome, r.log]), [['mod-v1.3.0', 'ok', 'GTNH runs mod-v1.4.0']]);
  assert.equal((await s.get()).mod.servers[0]!.running, 'mod-v1.4.0');
  // The tag that runs now is refused.
  assert.equal((await s.deploy({ part: 'mod', tag: 'mod-v1.4.0', server: 'gtnh' })).status, 409);
});

test('a Mod deploy fails if the server does not come back with the new Mod in time; nothing is swapped back', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  const old = await modRunning(s.port, '1.3.0');
  await s.deploy({ part: 'mod', tag: 'mod-v1.4.0', server: 'gtnh' });
  await old.closed;
  await modRunning(s.port, '1.3.0'); // somehow the old one
  await until(() => s.notices.length === 2, 3000);
  assert.deepEqual((await rows(s)).map((r) => [r.outcome, r.log]), [['failed', "GTNH didn't come back with mod-v1.4.0 in time"]]);
  assert.deepEqual(jars(w), ['gtnhdiscord-1.4.0.jar']);
});

test('cancelling the countdown leaves the old jar and no part file', async (t) => {
  const w = world(t);
  const s = await start(t, w, { countdownMinutes: 1 });
  await modRunning(s.port, '1.3.0');
  await s.deploy({ part: 'mod', tag: 'mod-v1.4.0', server: 'gtnh' });
  assert.ok(readdirSync(join(w.serverDir, 'mods')).includes('.gtnhdiscord-1.4.0.jar.part'));
  assert.equal((await s.post('/api/servers/gtnh/restart/cancel')).status, 204);
  await until(() => s.notices.length === 2);
  await until(() => jars(w).length === 1);
  assert.deepEqual(jars(w), ['gtnhdiscord-1.3.0.jar']);
  assert.deepEqual((await rows(s)).map((r) => [r.outcome, r.log]), [['failed', 'cancelled']]);
});

test('Mod deploy refusals: unknown server, no folder, no Mod token, a countdown running; a failed download is 502', async (t) => {
  const w = world(t, {
    servers: (dir) => [
      { id: 'gtnh', name: 'GTNH', dir: join(dir, 'gtnh'), backupMinFreeGB: 10, lag: { tps: 15, minutes: 2, enabled: true }, quests: 'batched' },
      { id: 'bare', name: 'Bare', backupMinFreeGB: 10, lag: { tps: 15, minutes: 2, enabled: true }, quests: 'batched' },
      { id: 'vanilla', name: 'Vanilla', dir, backupMinFreeGB: 10, lag: { tps: 15, minutes: 2, enabled: true }, quests: 'batched' },
    ],
  });
  w.config.integrations.minecraft!.tokens.bare = 'another-token-0123456';
  const s = await start(t, w, { countdownMinutes: 1 });
  const refused = async (server: string) => {
    const res = await s.deploy({ part: 'mod', tag: 'mod-v1.4.0', server });
    return [res.status, await res.text()];
  };
  assert.deepEqual(await refused('nope'), [404, 'No such server.']);
  assert.deepEqual(await refused('bare'), [409, 'Bare has no server folder.']);
  assert.deepEqual(await refused('vanilla'), [409, 'Vanilla has no Mod token.']);
  await modRunning(s.port, '1.3.0');
  assert.equal((await s.post('/api/servers/gtnh/restart', { minutes: 5 })).status, 204);
  assert.deepEqual(await refused('gtnh'), [409, 'A countdown is running on GTNH: cancel it first.']);
  assert.equal((await s.post('/api/servers/gtnh/restart/cancel')).status, 204);
  w.github.downloadFails = true;
  assert.deepEqual(await refused('gtnh'), [502, 'The deploy failed: GitHub: HTTP 404']);
  assert.deepEqual(jars(w), ['gtnhdiscord-1.3.0.jar']);
  assert.deepEqual((await rows(s)).map((r) => [r.outcome, r.log]), [['failed', 'download failed: GitHub: HTTP 404']]);
});

test('a Mod deploy left running by a hub that stopped is closed as interrupted', async (t) => {
  const w = world(t);
  const first = await start(t, w, { countdownMinutes: 1 });
  await modRunning(first.port, '1.3.0');
  await first.deploy({ part: 'mod', tag: 'mod-v1.4.0', server: 'gtnh' });
  await first.close();
  const s = await start(t, w);
  assert.deepEqual((await rows(s)).map((r) => [r.outcome, r.log]), [['failed', 'interrupted: the hub restarted']]);
});

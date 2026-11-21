// `Deploys`' answer and refusals (`deploys.ts`): each part's releases by the release rules (`release-rules.ts`), what
// each part runs (`running-release.ts`), a failed GitHub check (`github.ts`'s reader), GitHub off, the refusals, and
// restores and hub deploys excluding each other. The hub and dashboard deploys are `deploy-rows.test.ts`, a Mod's
// `deploy-mod.test.ts`; the shared setup is `deploys-world.ts`.

import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DeploysAnswer } from '../../src/api.ts';
import type { RunRestore } from '../../src/backups/restore.ts';
import { startHub } from '../../src/start.ts';
import { loginAs } from '../web/web-hub.ts';
import { until } from '../fake-mod.ts';
import { JARS, modRunning, rel, RELEASES, rows, start, world } from './deploys-world.ts';

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

test('a factorio server gets no Mod row', async (t) => {
  const w = world(t, {
    servers: (dir) => [
      { id: 'gtnh', name: 'GTNH', game: 'minecraft', dir: join(dir, 'gtnh'), backupMinFreeGB: 10, lag: { tps: 15, minutes: 2, enabled: true }, quests: 'batched' },
      { id: 'space', name: 'Space', game: 'factorio', backupMinFreeGB: 10, lag: { tps: 50, minutes: 2, enabled: true }, quests: 'batched' },
    ],
  });
  const s = await start(t, w);
  assert.deepEqual((await s.get()).mod.servers, [{ id: 'gtnh', name: 'GTNH', running: null }]);
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
  const handle = await startHub(w.config, { startFrontend: () => assert.fail(), get: () => assert.fail() });
  t.after(() => handle.close());
  const app = handle.web!.app;
  const { cookie } = await loginAs(handle.web!);
  assert.equal((await app.request('/api/deploys', { headers: { cookie } })).status, 404);
  assert.equal(((await (await app.request('/api/integrations', { headers: { cookie } })).json()) as { github: boolean }).github, false);
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

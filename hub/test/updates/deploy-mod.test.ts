// A Mod deploy (`deploy-mod.ts`): the jar put in place on a stopped server, a renamed release's jar and config, the
// swap at the end of a countdown and the new Mod's hello, a timeout, a cancel, the refusals, and a deploy left running
// by a hub that stopped.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ACTOR } from '../web/web-hub.ts';
import { until } from '../fake-mod.ts';
import { modRunning, rel, RELEASES, rows, start, world, type World } from './deploys-world.ts';

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

/** A renamed release: one jar per Minecraft target, besides its dev and sources jars. */
const ORRERY = rel('mod-v1.5.0', 0, {
  assets: ['orrery-1.12.2-1.5.0.jar', 'orrery-1.7.10-1.5.0.jar', 'orrery-1.7.10-1.5.0-dev.jar', 'orrery-1.7.10-1.5.0-sources.jar'],
});
const cfg = (w: World, name: string) => {
  const f = join(w.serverDir, 'config', name);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
};

test("a renamed Mod deploy picks 1.7.10's jar, removes every older Mod jar and copies the old config over", async (t) => {
  const w = world(t);
  w.github.list = [...RELEASES, ORRERY];
  writeFileSync(join(w.serverDir, 'mods', 'orrery-1.7.10-1.4.9.jar'), 'older orrery');
  const s = await start(t, w);
  assert.equal((await s.deploy({ part: 'mod', tag: 'mod-v1.5.0', server: 'gtnh' })).status, 202);
  assert.deepEqual(w.github.downloads, ['mod-v1.5.0 orrery-1.7.10-1.5.0.jar']);
  assert.deepEqual(jars(w), ['orrery-1.7.10-1.5.0.jar']);
  assert.deepEqual([cfg(w, 'gtnhdiscord.cfg'), cfg(w, 'orrery.cfg')], ['token=old', 'token=old']);
  assert.equal((await rows(s))[0]!.outcome, 'ok');
});

test("a renamed Mod deploy keeps an orrery.cfg that's there, and needs no old one", async (t) => {
  const w = world(t);
  w.github.list = [...RELEASES, ORRERY];
  writeFileSync(join(w.serverDir, 'config', 'orrery.cfg'), 'token=new');
  const s = await start(t, w);
  assert.equal((await s.deploy({ part: 'mod', tag: 'mod-v1.5.0', server: 'gtnh' })).status, 202);
  assert.equal(cfg(w, 'orrery.cfg'), 'token=new');
  rmSync(join(w.serverDir, 'config'), { recursive: true });
  // Back to a pre-rename release: no gtnhdiscord.cfg, so its jar would find no token.
  const old = await s.deploy({ part: 'mod', tag: 'mod-v1.4.0', server: 'gtnh' });
  assert.deepEqual([old.status, await old.text()], [409, "mod-v1.4.0 reads config/gtnhdiscord.cfg, which GTNH doesn't have."]);
  assert.equal((await rows(s)).length, 1);
  assert.deepEqual(jars(w), ['orrery-1.7.10-1.5.0.jar']);
  assert.equal(cfg(w, 'orrery.cfg'), null); // and no new one written
});

test('a pre-rename Mod deploy replaces a renamed jar; a release without a 1.7.10 build is refused', async (t) => {
  const w = world(t);
  w.github.list = [...RELEASES, rel('mod-v1.6.0', 0, { assets: ['orrery-1.12.2-1.6.0.jar'] })];
  writeFileSync(join(w.serverDir, 'mods', 'orrery-1.7.10-1.5.0.jar'), 'renamed');
  const s = await start(t, w);
  const none = await s.deploy({ part: 'mod', tag: 'mod-v1.6.0', server: 'gtnh' });
  assert.deepEqual([none.status, await none.text()], [409, 'mod-v1.6.0 has no Mod build for Minecraft 1.7.10.']);
  assert.equal((await s.deploy({ part: 'mod', tag: 'mod-v1.4.0', server: 'gtnh' })).status, 202);
  assert.deepEqual(jars(w), ['gtnhdiscord-1.4.0.jar']);
  assert.equal(cfg(w, 'orrery.cfg'), null);
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
      { id: 'gtnh', name: 'GTNH', game: 'minecraft', dir: join(dir, 'gtnh'), backupMinFreeGB: 10, lag: { tps: 15, minutes: 2, enabled: true }, quests: 'batched' },
      { id: 'bare', name: 'Bare', game: 'minecraft', backupMinFreeGB: 10, lag: { tps: 15, minutes: 2, enabled: true }, quests: 'batched' },
      { id: 'vanilla', name: 'Vanilla', game: 'minecraft', dir, backupMinFreeGB: 10, lag: { tps: 15, minutes: 2, enabled: true }, quests: 'batched' },
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

test('a countdown started during the download refuses the Mod deploy and closes its row', async (t) => {
  const w = world(t);
  const s = await start(t, w, { countdownMinutes: 1 });
  await modRunning(s.port, '1.3.0');
  let release!: () => void;
  w.github.gate = new Promise((r) => (release = r));
  const deploying = s.deploy({ part: 'mod', tag: 'mod-v1.4.0', server: 'gtnh' });
  await until(() => w.github.downloads.length === 1);
  assert.equal((await s.post('/api/servers/gtnh/restart', { minutes: 5 })).status, 204);
  release();
  const res = await deploying;
  assert.equal(res.status, 409);
  assert.deepEqual(jars(w), ['gtnhdiscord-1.3.0.jar']);
  assert.equal((await rows(s))[0]!.outcome, 'failed');
  assert.equal((await s.post('/api/servers/gtnh/restart/cancel')).status, 204);
  assert.equal((await s.deploy({ part: 'web', tag: 'web-v0.5.0' })).status, 202); // nothing left running
});

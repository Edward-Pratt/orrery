// Pack updates: the swap, pending changes, the steps on the stream and the refusals (`pack-update.ts`, `pack-job.ts`).

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ServerCard } from '../../src/api.ts';
import { formatEvent } from '../../src/discord/format.ts';
import { ACTOR } from '../web/web-hub.ts';
import { until } from '../fake-mod.ts';
import { SERVER_OWN, sha, snapshot, URL_NEW, URL_OLD, world, write } from './pack-world.ts';
import { start, updatable } from './pack-hub.ts';

test('an update onto a new version swaps exactly the old manifest for the staged set, with a backup and a hello', async (t) => {
  const { w, s } = await updatable(t);
  const res = await s.req('POST', '/api/servers/gtnh/pack/update', await s.toNew());
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
  assert.equal(read('mods/orrery-1.7.10-1.4.0.jar'), 'the Mod');
  for (const kept of ['World/level.dat', 'World/region/r.0.0.mca', 'server.properties', 'ops.json', 'logs/latest.log', 'journeymap/data.dat', 'config/JourneyMapServer/world.cfg']) {
    assert.equal(read(kept), { ...SERVER_OWN, 'config/forge.cfg': '' }[kept], kept);
  }
  const pre = readdirSync(w.dir).find((f) => f.startsWith('.pre-update-'))!;
  assert.match(pre, /^\.pre-update-\d{8}-\d{6}$/);
  assert.equal(readFileSync(join(w.dir, pre, 'mods/old-only.jar'), 'utf8'), 'gone in 2.7.5');
  assert.equal(readFileSync(join(w.dir, pre, 'mods/orrery-1.7.10-1.4.0.jar'), 'utf8'), 'the Mod');
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

test('applying pending changes onto the installed version unzips its library entry (no packs/), clearing a leftover .orrery-staging', async (t) => {
  const { w, s } = await updatable(t);
  write(w.dir, { '.orrery-staging/zip/mods/x.jar': 'from before the rename' });
  const p = await s.pack();
  assert.deepEqual(p.pending.map((x) => `${x.path} ${x.change}`), ['mods/bq.jar added', 'config/custom.cfg added', 'startserver.sh added']);
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', { pending: true }), 202);
  const row = await s.finished();
  assert.deepEqual([row.from, row.to, row.outcome, row.changes], ['2.7.4', '2.7.4', 'ok', ['mods/bq.jar added', 'config/custom.cfg added', 'startserver.sh added']]);
  assert.equal(readFileSync(join(w.dir, 'mods/bq.jar'), 'utf8'), 'bq pinned');
  assert.equal(readFileSync(join(w.dir, 'mods/old-only.jar'), 'utf8'), 'gone in 2.7.5'); // still 2.7.4
  assert.equal(readFileSync(join(w.dir, 'startserver.sh'), 'utf8'), 'java -Xmx12G -Dold=6 -jar forge.jar\n');
  assert.ok(!existsSync(join(w.dir, '.orrery-staging')) && !existsSync(join(w.dir, '.orrery-update')));
  assert.ok(!existsSync(join(w.root, 'data', 'packs')));
  assert.deepEqual((await s.pack()).pending, []);
  const again = await s.req('POST', '/api/servers/gtnh/pack/update', { pending: true });
  assert.equal(again.status, 409);
  assert.equal(await again.text(), 'Nothing is pending: 2.7.4 is installed as it is.');
  // The same entry, with nothing pending, is refused as well.
  const same = await s.req('POST', '/api/servers/gtnh/pack/update', await s.entry(URL_OLD, '2.7.4'));
  assert.equal(same.status, 409);
  assert.equal(await same.text(), 'GT New Horizons 2.7.4 is installed already, with nothing pending.');
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

for (const [why, expected] of [
  ['an edit matches nothing', 'The Config edit on config/gregtech.cfg (pollution=false) matched nothing in 2.7.5.'],
  ['the backup fails', 'The backup failed: disk full'],
] as const) {
  test(`when ${why}, the update fails in staging with the server folder unchanged and the server running`, async (t) => {
    const { w, s } = await updatable(t);
    if (why === 'an edit matches nothing') await s.json(s.req('POST', '/api/servers/gtnh/pack/edits', { path: 'config/gregtech.cfg', find: 'pollution=false', replace: 'x' }));
    if (why === 'the backup fails') s.fake.backupFails = true;
    const before = snapshot(w.dir);
    await s.json(s.req('POST', '/api/servers/gtnh/pack/update', await s.toNew()), 202);
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
    assert.ok(existsSync(join(w.root, 'data', 'library', `${sha(w.urls[URL_NEW]!)}.zip`))); // the library's, never the update's to delete
    const finished = s.events.find((e) => e.kind === 'packUpdateFinished')!;
    assert.deepEqual([finished.severity, 'outcome' in finished && finished.outcome], ['info', 'failed in staging']);
  });
}

test('an update is refused while one runs, without a pack, offline, and for bad input', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  const update = async (body?: object) => s.req('POST', '/api/servers/gtnh/pack/update', body ?? (await s.toNew()));
  assert.equal(await (await update()).text(), "orrery doesn't know GTNH's pack yet: adopt it first.");
  await s.adopt();
  const offline = await update();
  assert.equal(offline.status, 409);
  assert.equal(await offline.text(), 'GTNH is offline: an update needs it running, for the backup.');
  await s.connect();
  for (const body of [{}, { url: URL_NEW, name: 'a', version: '1' }, { library: 'x' }, { pending: 'yes' }]) {
    assert.equal((await update(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await update({ library: 999 })).status, 404);
  s.fake.backupGate = new Promise(() => {}); // holds the first update in Backup
  assert.equal((await update()).status, 202);
  const twice = await update();
  assert.equal(twice.status, 409);
  assert.equal(await twice.text(), 'A pack update is already running on GTNH.');
  // Extras and edits wait too: the update read them.
  for (const res of [
    await s.req('POST', '/api/servers/gtnh/pack/edits', { path: 'config/custom.cfg', find: '^our', replace: 'my' }),
    await s.req('POST', '/api/servers/gtnh/pack/extras', { upload: 'f'.repeat(32), target: 'mods/x.jar' }),
    await s.req('DELETE', '/api/servers/gtnh/pack/extras/1'),
  ]) {
    assert.equal(res.status, 409);
    assert.equal(await res.text(), 'A pack update is running on GTNH: change Extras and edits once it is done.');
  }
  assert.equal((await s.req('POST', '/api/servers/nope/pack/update', { library: 1 })).status, 404);
});

test('files the pack lacks that Adopt did not keep are dropped by the next update, into the .pre-update folder', async (t) => {
  const w = world(t);
  const s = await start(t, w);
  await s.connect();
  await s.adopt(['mods/journeymap-fairplay.jar']);
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', await s.toNew()), 202);
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
  s.fake.backupGate = new Promise((r) => (release = r));
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', await s.toNew()), 202);
  await until(() => s.events.some((e) => e.kind === 'packUpdateStep' && e.step === 'backup'));
  const running = (await s.pack()).running!;
  assert.deepEqual({ ...running, id: 0, started: 0 }, {
    id: 0,
    name: 'GT New Horizons',
    version: '2.7.5',
    by: 'alex',
    started: 0,
    cancellable: false,
    steps: [
      { step: 'prepare', state: 'done', detail: 'Staged: 8 files' },
      { step: 'backup', state: 'running', detail: 'Backing up' },
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
  s.fake.backupGate = new Promise(() => {});
  await s.json(s.req('POST', '/api/servers/gtnh/pack/update', await s.toNew()), 202);
  await until(() => s.events.filter((e) => e.kind === 'packUpdateStep').length >= 1);
  const replay = s.handle.live.since().map(([, e]) => e).filter((e) => 'serverId' in e && e.type === 'notice' && e.kind === 'packUpdateStep');
  assert.equal(replay.length, 1);
});

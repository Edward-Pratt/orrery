import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { computeUptime, Db } from '../src/db.ts';

test('computeUptime splits time between states', () => {
  const rows = [
    { ts: 0, state: 'up' as const },
    { ts: 50, state: 'down' as const },
  ];
  assert.equal(computeUptime(rows, 0, 100), 0.5);
});

test('computeUptime excludes unknown time and clips to the window', () => {
  const rows = [
    { ts: 0, state: 'up' as const },
    { ts: 50, state: 'unknown' as const },
    { ts: 75, state: 'up' as const },
  ];
  assert.equal(computeUptime(rows, 0, 100), 1);
  assert.equal(computeUptime([{ ts: 0, state: 'down' as const }], 10, 20), 0);
});

test('computeUptime is null with no known time', () => {
  assert.equal(computeUptime([], 0, 100), null);
  assert.equal(computeUptime([{ ts: 0, state: 'unknown' as const }], 0, 100), null);
});

test('uptime carries the state from before the window', () => {
  const db = new Db(':memory:');
  db.record('s', 'up', 'connected', 1000);
  db.record('s', 'down', 'crashed', 2000);
  assert.equal(db.uptime('s', 0, 3000), 0.5);
  assert.equal(db.uptime('s', 1500, 3000), 1 / 3);
  assert.equal(db.uptime('other', 0, 3000), null);
  db.close();
});

test('markHubRestart makes hub downtime unknown', () => {
  const db = new Db(':memory:');
  db.record('s', 'up', 'connected', 500);
  db.touch(1000);
  db.markHubRestart(['s'], 5000);
  assert.equal(db.uptime('s', 0, 6000), 1);
  db.close();
});

test('an event after the last touch still counts as hub-alive time', () => {
  const db = new Db(':memory:');
  db.record('s', 'up', 'connected', 500);
  db.touch(1000);
  db.record('s', 'down', 'stopped', 1030); // e.g. machine reboot: hub dies before its next touch
  db.markHubRestart(['s'], 5000);
  assert.equal(db.uptime('s', 1030, 5000), null); // the outage is unknown, not downtime
  db.close();
});

test('record and touch never throw, even when the database is unusable', () => {
  const db = new Db(':memory:');
  db.close();
  assert.doesNotThrow(() => db.record('s', 'up', 'connected', 1000));
  assert.doesNotThrow(() => db.touch(1000));
});

test('playtime counts only the overlap with the window, open sessions until now, names case-insensitively', () => {
  const db = new Db(':memory:');
  db.openSession('s', 'Steve', 1000);
  db.closeSession('s', 'Steve', 5000);
  db.openSession('s', 'Steve', 8000); // still online
  assert.equal(db.playtime('s', 'steve', 0, 10_000, 10_000), 4000 + 2000);
  assert.equal(db.playtime('s', 'Steve', 2000, 4000, 10_000), 2000);
  assert.equal(db.playtime('s', 'Steve', 6000, 7000, 10_000), 0);
  assert.equal(db.playtime('other', 'Steve', 0, 10_000, 10_000), 0);
  db.close();
});

test('lastSeen: online, last session end, or never', () => {
  const db = new Db(':memory:');
  assert.equal(db.lastSeen('s', 'Alex'), null);
  db.openSession('s', 'Alex', 1000);
  assert.deepEqual(db.lastSeen('s', 'alex'), { online: true });
  db.closeSession('s', 'Alex', 3000);
  assert.equal(db.lastSeen('s', 'Alex'), 3000);
  db.close();
});

test('top ranks players by playtime in the window', () => {
  const db = new Db(':memory:');
  db.openSession('s', 'A', 0);
  db.closeSession('s', 'A', 1000);
  db.openSession('s', 'B', 0);
  db.closeSession('s', 'B', 3000);
  db.openSession('s', 'C', 5000);
  db.closeSession('s', 'C', 6000);
  assert.deepEqual(db.top('s', 0, 4000, 10), [
    { player: 'B', ms: 3000 },
    { player: 'A', ms: 1000 },
  ]);
  assert.equal(db.top('s', 0, 10_000, 1).length, 1);
  db.close();
});

test('peaks keep the daily maximum; countEvents counts reasons in a window', () => {
  const db = new Db(':memory:');
  db.recordPeak('s', '2026-09-24', 3);
  db.recordPeak('s', '2026-09-24', 5);
  db.recordPeak('s', '2026-09-24', 2);
  assert.equal(db.peak('s', '2026-09-24'), 5);
  assert.equal(db.peak('s', '2026-09-25'), null);
  db.record('s', 'up', 'started', 100);
  db.record('s', 'down', 'crashed', 200);
  db.record('s', 'up', 'started', 300);
  assert.equal(db.countEvents('s', 'started', 0, 1000), 2);
  assert.equal(db.countEvents('s', 'crashed', 250, 1000), 0);
  db.close();
});

test('markHubRestart ends open sessions at the last stamp, not across the outage', () => {
  const db = new Db(':memory:');
  db.openSession('s', 'Steve', 1000);
  db.touch(2000); // hub last alive
  db.markHubRestart(['s'], 100_000); // hub back much later
  assert.equal(db.lastSeen('s', 'Steve'), 2000);
  assert.equal(db.playtime('s', 'Steve', 0, 100_000, 100_000), 1000);
  db.close();
});

test('session and peak writes never throw either', () => {
  const db = new Db(':memory:');
  db.close();
  assert.doesNotThrow(() => db.openSession('s', 'a', 1));
  assert.doesNotThrow(() => db.closeSession('s', 'a', 2));
  assert.doesNotThrow(() => db.recordPeak('s', '2026-09-24', 1));
});

test('tps samples averaged into time buckets, the last bucket taking any overflow', () => {
  const db = new Db(':memory:');
  for (const [ts, tps] of [[1000, 20], [1500, 10], [2000, 16], [2600, 18], [9000, 4]]) db.recordTps('s', ts, tps, null, null);
  db.recordTps('other', 1000, 1, null, null);
  // Buckets of 1000 ms from 1000: [1000, 2000), [2000, 3000), then 9000 folded into bucket 1, the last allowed.
  assert.deepEqual(db.tpsAveraged('s', 1000, 1000, 1), [
    { ts: 1250, tps: 15 },
    { ts: 4533, tps: 38 / 3 },
  ]);
  db.close();
});

test('tps samples: since, average and minimum', () => {
  const db = new Db(':memory:');
  db.recordTps('s', 1000, 20, null, null);
  db.recordTps('s', 2000, 10, 'Nether', 90);
  db.recordTps('s', 3000, 15, 'Overworld', 40);
  assert.deepEqual(db.tpsSince('s', 2000), [
    { ts: 2000, tps: 10 },
    { ts: 3000, tps: 15 },
  ]);
  assert.deepEqual(db.tpsStats('s', 0, 3000), { avg: 15, min: 10 });
  assert.equal(db.tpsStats('s', 5000, 6000), null);
  db.close();
});

test('a session opened after the last stamp never ends before it started', () => {
  const db = new Db(':memory:');
  db.touch(1000); // last stamp
  db.openSession('s', 'Steve', 1030); // joined after it, then the hub stopped
  db.markHubRestart(['s'], 100_000);
  assert.equal(db.playtime('s', 'Steve', 0, 100_000, 100_000), 0);
  assert.equal(db.lastSeen('s', 'Steve'), 1030);
  db.close();
});

test('maintain prunes old TPS samples and host samples, copies the database and keeps 7 copies', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const DAY = 24 * 3600_000;
  const now = new Date(2026, 8, 25, 4, 0).getTime();
  const db = new Db(':memory:');
  db.recordTps('gtnh', now - 91 * DAY, 20, null, null);
  db.recordTps('gtnh', now - 89 * DAY, 19, null, null);
  const sample = (ts: number) => ({ ts, cpu: 0.5, load: [1, 1, 1], memory: { used: 1, total: 2 }, disks: [] });
  db.recordHostSample('oracle', sample(now - 91 * DAY));
  db.recordHostSample('oracle', sample(now - 89 * DAY));
  db.openSession('gtnh', 'Old', now - 400 * DAY);
  const copies = join(dir, 'db-backups');
  await mkdir(copies);
  for (let d = 1; d <= 8; d++) await writeFile(join(copies, `hub-2026-09-${String(d).padStart(2, '0')}.db`), '');
  await writeFile(join(copies, 'notes.txt'), '');

  db.maintain(copies, now);

  assert.deepEqual(db.tpsSince('gtnh', 0).map((r) => r.tps), [19]);
  assert.deepEqual(db.hostSamples('oracle', 0), [sample(now - 89 * DAY)]);
  assert.deepEqual((await readdir(copies)).sort(), [
    'hub-2026-09-03.db',
    'hub-2026-09-04.db',
    'hub-2026-09-05.db',
    'hub-2026-09-06.db',
    'hub-2026-09-07.db',
    'hub-2026-09-08.db',
    'hub-2026-09-25.db',
    'notes.txt',
  ]);
  const copy = new DatabaseSync(join(copies, 'hub-2026-09-25.db'));
  assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 1);
  copy.close();

  db.maintain(copies, now); // same day again: replaces today's copy, doesn't throw
  db.maintain(join(copies, 'notes.txt', 'x'), now); // a folder under a file (ENOTDIR): logged, doesn't throw
});

test('recordLifecycle maps lifecycle events to up/down and ignores the rest', () => {
  const db = new Db(':memory:');
  const up = ['connected', 'started', 'recovered'];
  const down = ['stopped', 'crashed', 'hung', 'offline'];
  [...up, ...down].forEach((type, i) => {
    db.recordLifecycle('s', type, i * 100);
    assert.equal(db.uptime('s', i * 100, i * 100 + 50), up.includes(type) ? 1 : 0, type);
  });
  db.recordLifecycle('s', 'chat', 700);
  assert.equal(db.countEvents('s', 'chat', 0, 1000), 0);
});

test('recordLifecycle keeps the event type as the reason: start, crash, start', () => {
  const db = new Db(':memory:');
  db.recordLifecycle('s', 'started', 0);
  db.recordLifecycle('s', 'crashed', 60);
  db.recordLifecycle('s', 'started', 80);
  assert.equal(db.uptime('s', 0, 100), 0.8);
  assert.equal(db.countEvents('s', 'started', 0, 100), 2);
  assert.equal(db.countEvents('s', 'crashed', 0, 100), 1);
});

test('the audit log reads newest first, limited, filtered, and pages back across equal timestamps; writes never throw', () => {
  const db = new Db(':memory:');
  db.audit({ actor: 'discord:alice (1)', action: 'command', target: 'a', details: 'list' }, 1000);
  db.audit({ actor: 'hub:daily', action: 'restart', target: 'b', details: 'in 10 min' }, 2000);
  db.audit({ actor: 'hub:daily', action: 'command', target: 'b', details: 'stop' }, 2000);
  db.audit({ actor: 'hub:daily', action: 'command', target: 'a', details: 'save' }, 2000);
  const details = (rows: { details: string }[]) => rows.map((r) => r.details);
  assert.deepEqual(details(db.auditLog(3)), ['save', 'stop', 'in 10 min']);
  assert.deepEqual(details(db.auditLog(10, { target: 'a' })), ['save', 'list']);
  assert.deepEqual(details(db.auditLog(10, { actor: 'hub:daily', target: 'a' })), ['save']);
  assert.deepEqual(details(db.auditLog(10, { actor: 'nobody' })), []);
  // One entry at a time from the cursor back: none skipped or repeated, though three share a timestamp.
  const seen: string[] = [];
  for (let before: number | undefined; ; ) {
    const [row] = db.auditLog(1, { before });
    if (!row) break;
    seen.push(row.details);
    before = row.id;
  }
  assert.deepEqual(seen, ['save', 'stop', 'in 10 min', 'list']);
  db.close();
  assert.doesNotThrow(() => db.audit({ actor: 'x', action: 'command', target: 'a', details: '' }));
});

test('a web session from before avatars reads as avatar null', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE web_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, expires INTEGER NOT NULL)');
  old.exec("INSERT INTO web_sessions VALUES ('s', '5', 'alex', 9999999999999)");
  old.close();
  const db = new Db(path);
  assert.deepEqual(db.webSession('s'), { id: '5', username: 'alex', avatar: null });
  db.addWebSession('t', '6', 'sam', 'abc', 9999999999999);
  assert.equal(db.webSession('t')?.avatar, 'abc');
});

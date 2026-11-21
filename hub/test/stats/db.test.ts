import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Db } from '../../src/stats/db.ts';

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
  // Before-deploy copies go by age, not name: hub-v2.10.0 is newer than hub-v2.9.0.
  const tags = ['hub-v2.7.0', 'hub-v2.8.0', 'hub-v2.9.0', 'hub-v2.10.0', 'hub-v2.11.0'];
  for (const [i, tag] of tags.entries()) {
    const file = join(copies, `hub-before-${tag}-${i}.db`);
    await writeFile(file, '');
    await utimes(file, new Date(now - (10 - i) * DAY), new Date(now - (10 - i) * DAY));
  }

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
    'hub-before-hub-v2.10.0-3.db',
    'hub-before-hub-v2.11.0-4.db',
    'hub-before-hub-v2.9.0-2.db',
    'notes.txt',
  ]);
  const copy = new DatabaseSync(join(copies, 'hub-2026-09-25.db'));
  assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 1);
  copy.close();

  db.maintain(copies, now); // same day again: replaces today's copy, doesn't throw
  db.maintain(join(copies, 'notes.txt', 'x'), now); // a folder under a file (ENOTDIR): logged, doesn't throw
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

test('a web session table from before avatars gets the column an older hub reads; its rows are no User sessions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'old.db');
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE web_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL, expires INTEGER NOT NULL)');
  old.exec("INSERT INTO web_sessions VALUES ('s', '5', 'alex', 9999999999999)");
  old.close();
  const db = new Db(path);
  assert.equal(db.users.session('s'), undefined); // the Discord login's: never read again, so a rollback's never a User's
  assert.ok((new DatabaseSync(path).prepare('PRAGMA table_info(web_sessions)').all() as { name: string }[]).some((c) => c.name === 'avatar'));
  db.close();
});

test("Factorio links have their own table: an older hub after a Rollback reads and writes `links` as before", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'hub.db');
  const db = new Db(path);
  db.link('d1', 'Steve', 'u1', 1);
  db.linkFactorio('d1', 'engineer', 2);
  db.linkFactorio('d2', 'pilot', 3); // a Factorio link only

  // What an older hub runs: its schema statements, then its link reads and writes.
  const old = new DatabaseSync(path);
  t.after(() => old.close());
  old.exec(`
    CREATE TABLE IF NOT EXISTS links (discord_id TEXT PRIMARY KEY, player TEXT NOT NULL, uuid TEXT NOT NULL, linked_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS links_player ON links (player COLLATE NOCASE);
  `);
  const columns = (old.prepare('PRAGMA table_info(links)').all() as { name: string }[]).map((c) => c.name);
  assert.deepEqual(columns, ['discord_id', 'player', 'uuid', 'linked_at']);
  const indexes = (old.prepare('PRAGMA index_list(links)').all() as { name: string }[]).map((i) => i.name).sort();
  assert.deepEqual(indexes, ['links_player', 'sqlite_autoindex_links_1']);
  const byDiscord = old.prepare('SELECT player, uuid FROM links WHERE discord_id = ?');
  assert.deepEqual({ ...byDiscord.get('d1') }, { player: 'Steve', uuid: 'u1' });
  assert.equal(byDiscord.get('d2'), undefined);
  old.prepare('DELETE FROM links WHERE discord_id = ? OR player = ? COLLATE NOCASE').run('d2', 'Alex');
  old.prepare('INSERT INTO links (discord_id, player, uuid, linked_at) VALUES (?, ?, ?, ?)').run('d2', 'Alex', 'u2', 4);
  old.prepare('DELETE FROM links WHERE discord_id = ?').run('d1'); // its /unlink: Minecraft only

  // Back on this hub: the Factorio links were left alone, the older hub's writes read as usual.
  const again = new Db(path);
  assert.deepEqual(again.factorioLinkByDiscord('d1'), { name: 'engineer' });
  assert.deepEqual(again.factorioLinkByDiscord('d2'), { name: 'pilot' });
  assert.equal(again.linkByDiscord('d1'), null);
  assert.deepEqual(again.linkByDiscord('d2'), { player: 'Alex', uuid: 'u2' });
});

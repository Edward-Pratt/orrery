import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COLORS,
  formatBackupList,
  formatBackupStatus,
  formatEvent,
  formatLastSeen,
  formatPlayers,
  formatPlaytime,
  formatPresence,
  formatStatus,
  formatSummary,
  formatTop,
  formatTopic,
  formatTps,
} from '../../src/discord/format.ts';
import type { Notice, ServerState } from '../../src/servers/servers.ts';
import { first, online } from './format-fixtures.ts';

test('formatStatus is an embed with state, TPS, players and uptime', () => {
  const base: ServerState = { id: 's', name: 'GTNH', game: 'minecraft', online: true, hung: false, paused: false, tps: 19.96, players: ['a_b', 'c'], dims: [] };
  const e = first(formatStatus(base, 1, 0.5));
  assert.equal(e.title, 'GTNH — 🟢 Online');
  assert.equal(e.color, COLORS.green);
  assert.deepEqual(
    e.fields!.map((f) => [f.name, f.value]),
    [
      ['TPS', '20.0'],
      ['Players', '2'],
      ['Uptime 24 h', '100.0%'],
      ['Uptime 7 d', '50.0%'],
      ['Online now', 'a\\_b, c'],
    ],
  );
  assert.equal(first(formatStatus({ ...base, hung: true }, null, null)).title, 'GTNH — 🟠 Not responding');
  const off = first(formatStatus({ ...base, online: false, tps: null, players: [] }, 0, 0));
  assert.equal(off.color, COLORS.red);
  assert.deepEqual(off.fields!.map((f) => f.name), ['Uptime 24 h', 'Uptime 7 d']);
});

test('formatPlayers lists escaped names in an embed', () => {
  assert.equal(first(formatPlayers([])).title, 'Nobody online');
  const e = first(formatPlayers(['Steve', 'a_b']));
  assert.equal(e.title, 'Online (2)');
  assert.equal(e.description, 'Steve, a\\_b');
});

test('formatPlaytime and formatLastSeen', () => {
  const now = 10 * 3600_000;
  assert.equal(formatLastSeen(null, now), 'never');
  assert.equal(formatLastSeen({ online: true }, now), 'online now');
  assert.equal(formatLastSeen(now - 3 * 3600_000, now), '3 h ago');
  const e = first(formatPlaytime('Steve', 5 * 3600_000 + 12 * 60_000, 3600_000, { online: true }, now));
  assert.deepEqual(
    e.fields!.map((f) => [f.name, f.value]),
    [
      ['Player', 'Steve'],
      ['Total', '5 h 12 m'],
      ['Last 7 days', '1 h'],
      ['Last seen', 'online now'],
    ],
  );
});

test('formatTop numbers players and handles an empty period', () => {
  const e = first(formatTop('week', [{ player: 'a_b', ms: 7200_000 }, { player: 'C', ms: 60_000 }]));
  assert.equal(e.title, 'Top players (last 7 days)');
  assert.equal(e.description, '1. **a\\_b**: 2 h\n2. **C**: 1 m');
  assert.equal(first(formatTop('day', [])).description, 'No playtime recorded.');
});

test('formatBackupStatus and formatBackupList show count and total size', () => {
  const now = 1_000_000_000_000;
  const backups = [
    { name: '2026-09-24-06-00-00.zip', size: 2 * 1024 ** 3, mtimeMs: now - 2 * 3600_000 },
    { name: '2026-09-23-06-00-00.zip', size: 1024 ** 3, mtimeMs: now - 26 * 3600_000 },
  ];
  const status = first(formatBackupStatus(backups, now, 50 * 1024 ** 3));
  assert.deepEqual(
    status.fields!.map((f) => [f.name, f.value]),
    [
      ['Newest', '2026-09-24-06-00-00.zip'],
      ['Age', '2 h'],
      ['Size', '2.0 GB'],
      ['Count', '2'],
      ['Total size', '3.0 GB'],
      ['Free disk', '50.0 GB'],
      ['Growth', '+1.0 GB/day'],
    ],
  );
  assert.equal(first(formatBackupStatus([backups[0]], now, null)).fields!.at(-1)!.value, 'n/a'); // no growth yet
  const list = first(formatBackupList(backups));
  assert.equal(list.title, 'Backups: 2, 3.0 GB total');
  assert.equal(list.description, '`2026-09-24-06-00-00.zip` 2.0 GB\n`2026-09-23-06-00-00.zip` 1.0 GB');
  assert.equal(first(formatBackupStatus([], now, null)).description, 'No backups found.');
});

test("an Agent's save names can't format the backup posts: escaped as the newest, kept inside their code span in the list", () => {
  const now = 1_000_000_000_000;
  const hostile = { name: '[x](https://e.example) `y`_z.zip', size: 1024, mtimeMs: now, kind: 'world' as const, current: true };
  assert.equal(first(formatBackupStatus([hostile], now, null)).fields![0]!.value, '\\[x](https://e.example) \\`y\\`\\_z.zip');
  assert.equal(first(formatBackupList([hostile])).description, "`[x](https://e.example) 'y'_z.zip` 1.0 KB");
});

test('formatSummary lays out the daily stats', () => {
  const e = first(
    formatSummary('GTNH', {
      day: '2026-09-23',
      uptime: 0.75,
      peak: 3,
      unique: 4,
      totalMs: 6.5 * 3600_000,
      top: [{ player: 'A', ms: 3 * 3600_000 }],
      starts: 2,
      crashes: 1,
    }),
  );
  assert.equal(e.title, '📊 GTNH: 2026-09-23');
  assert.deepEqual(
    e.fields!.map((f) => [f.name, f.value]),
    [
      ['Uptime', '75.0%'],
      ['Peak players', '3'],
      ['Unique players', '4'],
      ['Total playtime', '6 h 30 m'],
      ['Starts', '2'],
      ['Crashes', '1'],
      ['Top players', '1. **A**: 3 h'],
    ],
  );
});

test('formatTps shows now, averages, a trend and the slowest dimensions', () => {
  const s: ServerState = {
    id: 's',
    name: 'GTNH',
    game: 'minecraft',
    online: true,
    hung: false,
    paused: false,
    tps: 13.4,
    players: [],
    dims: [{ id: -1, name: 'Nether', ms: 72.4 }],
  };
  const e = first(formatTps(s, [{ ts: 1, tps: 20 }, { ts: 2, tps: 10 }], { avg: 15, min: 10 }, { avg: 18.25, min: 9 }));
  assert.equal(e.title, 'GTNH: 13.4 TPS');
  assert.equal(e.color, COLORS.orange);
  assert.deepEqual(
    e.fields!.map((f) => [f.name, f.value]),
    [
      ['Last hour', '15.0 (min 10.0)'],
      ['Last 24 h', '18.3'],
      ['Trend (1 sample/min)', '█▅'],
      ['Slowest dimensions', 'Nether (DIM -1): 72 ms/tick'],
    ],
  );
  assert.equal(first(formatTps({ ...s, online: false, tps: null }, [], null, null)).title, 'GTNH: offline');
});

test("a factorio server's rate is UPS out of 60: bands, trend and wording, and no dimensions", () => {
  const s: ServerState = { id: 'f', name: 'Space Age', game: 'factorio', online: true, hung: false, paused: false, tps: 54, players: ['Ann'], dims: [] };
  const e = first(formatTps(s, [{ ts: 1, tps: 60 }, { ts: 2, tps: 30 }], { avg: 45, min: 30 }, null));
  assert.equal(e.title, 'Space Age: 54.0 UPS');
  assert.equal(e.color, COLORS.green); // 54 is 0.9 of 60
  assert.deepEqual(
    e.fields!.map((f) => [f.name, f.value]),
    [
      ['Last hour', '45.0 (min 30.0)'],
      ['Last 24 h', 'n/a'],
      ['Trend (1 sample/min)', '█▅'],
    ],
  );
  assert.equal(first(formatTps({ ...s, tps: 40 }, [], null, null)).color, COLORS.orange); // 20 TPS would be green on Minecraft's scale
  assert.equal(first(formatTps({ ...s, tps: 35 }, [], null, null)).color, COLORS.red);
  assert.deepEqual(first(formatStatus(s, null, null)).fields![0], { name: 'UPS', value: '54.0', inline: true });
  assert.equal(formatPresence([s, online]), 'Space Age: 1 online · 54 UPS | GTNH: 2 online · 20 TPS');
  assert.equal(formatTopic(s), '🟢 Online · 54 UPS · 1 player: Ann');
  const post = (n: Notice) => formatEvent({ ...n, type: 'notice', serverId: 'f' });
  assert.deepEqual(post({ severity: 'warning', kind: 'lag', tps: 41.5, label: 'UPS', worst: null }), {
    embeds: [{ title: '🐢 Lag: 41.5 UPS', color: COLORS.orange }], // no dimensions to name
  });
  assert.deepEqual(post({ severity: 'good', kind: 'lagRecovered', tps: 59.9, label: 'UPS' }), {
    embeds: [{ title: '✅ UPS back to normal (59.9)', color: COLORS.green }],
  });
});

test('formatSummary adds a backups line when it has backup stats', () => {
  const base = { day: '2026-09-23', uptime: 1, peak: 1, unique: 1, totalMs: 0, top: [], starts: 0, crashes: 0 };
  const GB = 1024 ** 3;
  const withBackups = first(formatSummary('GTNH', { ...base, backups: { count: 2, total: 3 * GB, free: 50 * GB, growth: -GB } }));
  assert.deepEqual(withBackups.fields!.at(-1), { name: 'Backups', value: '2, 3.0 GB total, 50.0 GB free, −1.0 GB/day', inline: false });
  const noGrowth = first(formatSummary('GTNH', { ...base, backups: { count: 0, total: 0, free: null, growth: null } }));
  assert.equal(noGrowth.fields!.at(-1)!.value, '0, 0 B total, n/a free');
  assert.equal(first(formatSummary('GTNH', base)).fields!.at(-1)!.name, 'Top players');
});

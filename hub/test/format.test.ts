import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { APIEmbed } from 'discord.js';
import {
  COLORS,
  formatBackupList,
  formatBackupStatus,
  formatEvent,
  formatLastSeen,
  formatNotice,
  formatOutput,
  formatPlayers,
  formatPlaytime,
  formatPresence,
  formatStatus,
  formatSummary,
  formatTop,
  formatTopic,
  TOPIC_MIN_GAP_MS,
  topicDue,
  type Post,
} from '../src/format.ts';
import type { ServerState } from '../src/servers.ts';

test('formatEvent keeps chat-like events as escaped plain text', () => {
  assert.deepEqual(formatEvent({ serverId: 's', type: 'chat', player: 'x_y_z', message: '**hi** [a](http://x) §cred' }), {
    content: '**x\\_y\\_z**: \\*\\*hi\\*\\* \\[a](http://x) red',
  });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'chat', player: 'a', message: '# big' }), { content: '**a**: \\# big' });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'death', player: 'Steve', message: 'Steve fell from a high place' }), {
    content: '💀 Steve fell from a high place',
  });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'achievement', player: 'Steve', achievement: 'Taking Inventory' }), {
    content: '🏆 **Steve** earned **Taking Inventory**',
  });
});

test('formatEvent announces lifecycle as coloured embeds, but not reconnects', () => {
  assert.equal(formatEvent({ serverId: 's', type: 'connected' }), null);
  assert.equal(formatEvent({ serverId: 's', type: 'offline' }), null);
  assert.deepEqual(formatEvent({ serverId: 's', type: 'crashed' }), {
    embeds: [{ title: '💥 Server went down unexpectedly', color: COLORS.red }],
  });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'started' }), { embeds: [{ title: '✅ Server started', color: COLORS.green }] });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'hung' }), { embeds: [{ title: '⚠️ Server not responding', color: COLORS.orange }] });
});

test('formatNotice colours by the leading emoji', () => {
  const color = (text: string) => (formatNotice(text) as { embeds: { color?: number }[] }).embeds[0].color;
  assert.equal(color('🔄 Restart in 5 minutes (by a)'), COLORS.blue);
  assert.equal(color('❌ Restart failed: timed out'), COLORS.red);
  assert.equal(color('⚠️ No new backup for 30 h'), COLORS.orange);
  assert.equal(color('✅ Backup finished: x.zip'), COLORS.green);
  const long = formatNotice('x'.repeat(300)) as { embeds: { title?: string }[] };
  assert.ok(long.embeds[0].title!.length <= 256);
});

test('formatOutput always yields one valid code block under 2000 chars', () => {
  assert.equal(formatOutput([]), '```\n(no output)\n```');
  assert.equal(formatOutput(['§aGreen', 'b']), '```\nGreen\nb\n```');
  const sneaky = formatOutput(['```', '@everyone']);
  assert.equal(sneaky, "```\n'''\n@everyone\n```");
  const long = formatOutput(['x'.repeat(5000)]);
  assert.ok(long.length < 2000);
  assert.ok(long.endsWith('… (truncated)\n```'));
});

const first = (p: Post) => (p as { embeds: APIEmbed[] }).embeds[0];

test('formatStatus is an embed with state, TPS, players and uptime', () => {
  const base: ServerState = { id: 's', name: 'GTNH', online: true, hung: false, tps: 19.96, players: ['a_b', 'c'] };
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
  const status = first(formatBackupStatus(backups, now));
  assert.deepEqual(
    status.fields!.map((f) => [f.name, f.value]),
    [
      ['Newest', '2026-09-24-06-00-00.zip'],
      ['Age', '2 h'],
      ['Size', '2.0 GB'],
      ['Count', '2'],
      ['Total size', '3.0 GB'],
    ],
  );
  const list = first(formatBackupList(backups));
  assert.equal(list.title, 'Backups: 2, 3.0 GB total');
  assert.equal(list.description, '`2026-09-24-06-00-00.zip` 2.0 GB\n`2026-09-23-06-00-00.zip` 1.0 GB');
  assert.equal(first(formatBackupStatus([], now)).description, 'No backups found.');
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

test('formatOutput truncates long emoji output without splitting an emoji', () => {
  const out = formatOutput(['😀'.repeat(2000)]);
  assert.ok(out.length <= 2000, `length ${out.length}`);
  assert.ok(out.endsWith('😀\n… (truncated)\n```'));
});

const online: ServerState = { id: 'gtnh', name: 'GTNH', online: true, hung: false, tps: 19.7, players: ['Steve', 'Alex'] };

test('formatPresence has one segment per server', () => {
  assert.equal(formatPresence([online]), 'GTNH: 2 online · 20 TPS');
  assert.equal(
    formatPresence([online, { ...online, id: 'sky', name: 'Sky', online: false, tps: null, players: [] }, { ...online, id: 'x', name: 'X', hung: true }]),
    'GTNH: 2 online · 20 TPS | Sky: offline | X: not responding',
  );
  assert.equal(formatPresence([{ ...online, tps: null }]), 'GTNH: 2 online');
  assert.ok(formatPresence(Array(20).fill(online)).length <= 128);
});

test('formatTopic shows state, TPS and players within 1024 chars', () => {
  assert.equal(formatTopic(online), '🟢 Online · 20 TPS · 2 players: Steve, Alex');
  assert.equal(formatTopic({ ...online, players: ['Steve'] }), '🟢 Online · 20 TPS · 1 player: Steve');
  assert.equal(formatTopic({ ...online, players: [] }), '🟢 Online · 20 TPS · 0 players');
  assert.equal(formatTopic({ ...online, hung: true }), '🟠 Not responding');
  assert.equal(formatTopic({ ...online, online: false }), '🔴 Offline');
  assert.ok(formatTopic({ ...online, players: Array(200).fill('SomeLongPlayerName') }).length <= 1024);
});

test('topicDue edits on first sight, then only on change and after the minimum gap', () => {
  assert.equal(topicDue(undefined, 'a', 0), true);
  const last = { text: 'a', at: 1000 };
  assert.equal(topicDue(last, 'a', 1000 + TOPIC_MIN_GAP_MS), false); // unchanged
  assert.equal(topicDue(last, 'b', 1000 + TOPIC_MIN_GAP_MS - 1), false); // too soon
  assert.equal(topicDue(last, 'b', 1000 + TOPIC_MIN_GAP_MS), true);
});

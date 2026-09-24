import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatEvent,
  formatOutput,
  formatPlayers,
  formatPresence,
  formatStatus,
  formatTopic,
  TOPIC_MIN_GAP_MS,
  topicDue,
} from '../src/format.ts';
import type { ServerState } from '../src/servers.ts';

test('formatEvent escapes markdown, links and § codes', () => {
  assert.equal(
    formatEvent({ serverId: 's', type: 'chat', player: 'x_y_z', message: '**hi** [a](http://x) §cred' }),
    '**x\\_y\\_z**: \\*\\*hi\\*\\* \\[a](http://x) red',
  );
  assert.equal(formatEvent({ serverId: 's', type: 'chat', player: 'a', message: '# big' }), '**a**: \\# big');
  assert.equal(
    formatEvent({ serverId: 's', type: 'death', player: 'Steve', message: 'Steve fell from a high place' }),
    '💀 Steve fell from a high place',
  );
  assert.equal(
    formatEvent({ serverId: 's', type: 'achievement', player: 'Steve', achievement: 'Taking Inventory' }),
    '🏆 **Steve** earned **Taking Inventory**',
  );
});

test('formatEvent announces lifecycle but not reconnects', () => {
  assert.equal(formatEvent({ serverId: 's', type: 'connected' }), null);
  assert.equal(formatEvent({ serverId: 's', type: 'offline' }), null);
  assert.equal(formatEvent({ serverId: 's', type: 'crashed' }), '💥 Server went down unexpectedly');
  assert.equal(formatEvent({ serverId: 's', type: 'started' }), '✅ Server started');
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

test('formatStatus covers online, hung and offline', () => {
  const base: ServerState = { id: 's', name: 'GTNH', online: true, hung: false, tps: 19.96, players: ['a', 'b'] };
  assert.equal(formatStatus(base, 1, 0.5), '**GTNH** — 🟢 Online\nTPS: 20.0 · Players: 2\nUptime: 24h 100.0% · 7d 50.0%');
  assert.match(formatStatus({ ...base, hung: true }, null, null), /🟠 Not responding[\s\S]*24h n\/a/);
  assert.equal(formatStatus({ ...base, online: false, tps: null, players: [] }, 0, 0), '**GTNH** — 🔴 Offline\nUptime: 24h 0.0% · 7d 0.0%');
});

test('formatPlayers lists escaped names', () => {
  assert.equal(formatPlayers([]), 'Nobody online.');
  assert.equal(formatPlayers(['Steve', 'a_b']), 'Online (2): Steve, a\\_b');
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

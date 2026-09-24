import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatEvent, formatOutput, formatPlayers, formatStatus } from '../src/discord.ts';
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

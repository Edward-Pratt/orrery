import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  chatContent,
  COLORS,
  formatEvent,
  formatLinked,
  formatLinkHint,
  formatNotice,
  formatOutput,
  formatQuests,
  formatSummary,
} from '../../src/discord/format.ts';

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

test('formatEvent posts a dashboard line as escaped text, and no Discord line', () => {
  const say = { serverId: 's', type: 'say', author: 'a_b', message: '**hi** @everyone' } as const;
  assert.deepEqual(formatEvent({ ...say, source: 'dashboard' }), {
    content: '**a\\_b** (dashboard): \\*\\*hi\\*\\* @everyone',
  });
  assert.equal(formatEvent({ ...say, source: 'discord' }), null);
});

test('formatEvent announces lifecycle as coloured embeds, but not reconnects', () => {
  assert.equal(formatEvent({ serverId: 's', type: 'connected' }), null);
  assert.equal(formatEvent({ serverId: 's', type: 'offline' }), null);
  assert.equal(formatEvent({ serverId: 's', type: 'tps', tps: 12 }), null);
  assert.deepEqual(formatEvent({ serverId: 's', type: 'crashed' }), {
    embeds: [{ title: '💥 Server went down unexpectedly', color: COLORS.red }],
  });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'started' }), { embeds: [{ title: '✅ Server started', color: COLORS.green }] });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'hung' }), { embeds: [{ title: '⚠️ Server not responding', color: COLORS.orange }] });
});

test('formatNotice is a plain info embed, truncated to a title', () => {
  assert.deepEqual(formatNotice('🔴 GTNH is offline'), { embeds: [{ title: '🔴 GTNH is offline', color: COLORS.blue }] });
  assert.deepEqual(formatNotice('❌ not red any more'), { embeds: [{ title: '❌ not red any more', color: COLORS.blue }] });
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

test('formatOutput truncates long emoji output without splitting an emoji', () => {
  const out = formatOutput(['😀'.repeat(2000)]);
  assert.ok(out.length <= 2000, `length ${out.length}`);
  assert.ok(out.endsWith('😀\n… (truncated)\n```'));
});

test('formatQuests: at-once lists up to 5 names; a roll-up shows the count and latest', () => {
  const q = (name: string, main = false) => ({ name, main });
  assert.deepEqual(formatQuests({ player: 'a_b', quests: [q('Stone Age', true)], count: 1 }), {
    content: '📜 **a\\_b** completed **Stone Age**',
  });
  const seven = ['1', '2', '3', '4', '5', '6', '7'].map((n) => q(n));
  assert.deepEqual(formatQuests({ player: 'S', quests: seven, count: 7 }), {
    content: '📜 **S** completed **1**, **2**, **3**, **4**, **5** and 2 more',
  });
  assert.deepEqual(formatQuests({ player: 'S', quests: [q('Bronze')], count: 7 }), {
    content: '📜 **S** completed 7 quests (latest: **Bronze**)',
  });
});

test('formatEvent posts quest batches and new links', () => {
  assert.deepEqual(formatEvent({ serverId: 's', type: 'questBatch', player: 'Steve', quests: [{ name: 'Stone Age', main: true }], count: 1 }), {
    content: '📜 **Steve** completed **Stone Age**',
  });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'linked', player: 'Steve', discordId: '123' }), { content: '🔗 **Steve** linked to <@123>' });
});

test('formatEvent posts a daily summary under the server name', () => {
  const summary = { day: '2026-09-23', uptime: 1, peak: 2, unique: 1, totalMs: 60_000, top: [], starts: 0, crashes: 0 };
  assert.deepEqual(formatEvent({ serverId: 's', type: 'summary', name: 'GTNH', summary }), formatSummary('GTNH', summary));
});

test('formatLinked mentions without escaping the id', () => {
  assert.deepEqual(formatLinked('Steve', '123'), { content: '🔗 **Steve** linked to <@123>' });
});

test('chat and other plain posts are cut to 2000 characters after escaping, never splitting an emoji', () => {
  const pipes = '|'.repeat(1024); // a full 1 KiB message that escaping doubles
  const chat = formatEvent({ serverId: 's', type: 'chat', player: 'Steve', message: pipes }) as { content: string };
  assert.equal(chat.content.length, 2000);
  assert.ok(chat.content.startsWith('**Steve**: \\|\\|'));
  const death = formatEvent({ serverId: 's', type: 'death', player: 'Steve', message: pipes }) as { content: string };
  assert.equal(death.content.length, 2000);
  assert.equal(chatContent('a'.repeat(3000)).length, 2000);
  assert.equal(chatContent('**hi**'), '\\*\\*hi\\*\\*');
  assert.equal(chatContent(`${'a'.repeat(1999)}😀`), 'a'.repeat(1999));
});

test("a milestone is posted per kind, escaped, its text capped at 200 and its force named only when it isn't the default", () => {
  const milestone = (m: { kind: 'research' | 'rocket' | 'platform' | 'landing'; text: string; player?: string; force?: string }) =>
    formatEvent({ serverId: 's', type: 'milestone', ...m });
  assert.deepEqual(milestone({ kind: 'research', text: 'Mining productivity 12' }), { content: '🔬 Research finished: **Mining productivity 12**' });
  assert.deepEqual(milestone({ kind: 'research', text: 'Logistics_2', force: 'team_red' }), { content: '🔬 Research finished: **Logistics\\_2** (team\\_red)' });
  assert.deepEqual(milestone({ kind: 'rocket', text: 'Nauvis' }), { content: '🚀 First rocket launched from **Nauvis**' });
  assert.deepEqual(milestone({ kind: 'rocket', text: '' }), { content: '🚀 First rocket launched' });
  assert.deepEqual(milestone({ kind: 'platform', text: '# [Home](http://x)' }), { content: '🛰️ First space platform in orbit: **\\# \\[Home](http://x)**' });
  assert.deepEqual(milestone({ kind: 'landing', text: 'Vulcanus', player: 'x_y', force: 'blue' }), { content: '🪐 First landing on **Vulcanus** by **x\\_y** (blue)' });
  const long = milestone({ kind: 'research', text: 'a'.repeat(1024) }) as { content: string };
  assert.equal(long.content, `🔬 Research finished: **${'a'.repeat(200)}**`);
});

test('the /link hint names each game that has a server, in a fixed order', () => {
  assert.equal(formatLinkHint('ABC234', ['minecraft']), 'In Minecraft, type `/discord link ABC234` within 10 minutes.');
  assert.equal(formatLinkHint('ABC234', ['factorio']), 'In Factorio, type `/orrery-link ABC234` within 10 minutes.');
  assert.equal(
    formatLinkHint('ABC234', ['factorio', 'minecraft']),
    'In Minecraft, type `/discord link ABC234`. In Factorio, type `/orrery-link ABC234`. The code works for 10 minutes.',
  );
});

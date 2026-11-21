import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { APIEmbed } from 'discord.js';
import { COLORS, formatEvent, formatTopic, inline, md } from '../../src/discord/format.ts';
import { formatTargetEvent } from '../../src/discord/format-target.ts';
import type { Notice, Severity, TargetEvent } from '../../src/servers/servers.ts';
import { online } from './format-fixtures.ts';

test("formatEvent posts restart notices with today's wording", () => {
  const post = (n: Notice) => formatEvent({ ...n, type: 'notice', serverId: 's' });
  assert.deepEqual(post({ severity: 'info', kind: 'restartScheduled', ms: 600_000, by: 'alice' }), {
    embeds: [{ title: '🔄 Restart in 10 minutes (by alice)', color: COLORS.blue }],
  });
  assert.deepEqual(post({ severity: 'info', kind: 'restartScheduled', ms: 60_000, by: 'bob' }), {
    embeds: [{ title: '🔄 Restart in 1 minute (by bob)', color: COLORS.blue }],
  });
  assert.deepEqual(post({ severity: 'info', kind: 'restartNow' }), { embeds: [{ title: '🔄 Restarting now', color: COLORS.blue }] });
  assert.deepEqual(post({ severity: 'info', kind: 'restartScheduled', ms: 300_000, by: 'alex', stop: true }), {
    embeds: [{ title: '🛑 Stop in 5 minutes (by alex)', color: COLORS.blue }],
  });
  assert.deepEqual(post({ severity: 'info', kind: 'restartNow', stop: true }), { embeds: [{ title: '🛑 Stopping now', color: COLORS.blue }] });
  assert.deepEqual(post({ severity: 'info', kind: 'restartCancelled', by: 'bob' }), {
    embeds: [{ title: '❎ Restart cancelled (by bob)', color: COLORS.blue }],
  });
  assert.deepEqual(post({ severity: 'info', kind: 'restartCancelledDown' }), {
    embeds: [{ title: '❎ Restart cancelled (server went down)', color: COLORS.blue }],
  });
  assert.deepEqual(post({ severity: 'problem', kind: 'restartFailed', error: 'timed out' }), {
    embeds: [{ title: '❌ Restart failed: timed out', color: COLORS.red }],
  });
});

test("formatEvent posts lag and backup notices with today's wording and severity colours", () => {
  const post = (n: Notice) => formatEvent({ ...n, type: 'notice', serverId: 's' });
  const nether = { id: -1, name: 'Nether', ms: 72.4 };
  const GB = 1024 ** 3;
  assert.deepEqual(post({ severity: 'warning', kind: 'lag', tps: 12.3, label: 'TPS', worst: nether }), {
    embeds: [{ title: '🐢 Lag: 12.3 TPS; slowest: Nether (DIM -1) 72 ms/tick', color: COLORS.orange }],
  });
  assert.deepEqual(post({ severity: 'warning', kind: 'lag', tps: 9, label: 'TPS', worst: null }), {
    embeds: [{ title: '🐢 Lag: 9.0 TPS; slowest: unknown', color: COLORS.orange }],
  });
  assert.deepEqual(post({ severity: 'good', kind: 'lagRecovered', tps: 19.9, label: 'TPS' }), {
    embeds: [{ title: '✅ TPS back to normal (19.9)', color: COLORS.green }],
  });
  assert.deepEqual(post({ severity: 'warning', kind: 'backupOverdue', hours: 30, newest: 'a.zip' }), {
    embeds: [{ title: '⚠️ No new backup for 30 h (newest: a.zip)', color: COLORS.orange }],
  });
  assert.deepEqual(post({ severity: 'warning', kind: 'backupsMissing' }), { embeds: [{ title: '⚠️ No backups found', color: COLORS.orange }] });
  assert.deepEqual(post({ severity: 'warning', kind: 'lowDisk', free: 5 * GB, minFreeGB: 10 }), {
    embeds: [{ title: '⚠️ Low disk space for backups: 5.0 GB free (limit 10 GB)', color: COLORS.orange }],
  });
  assert.deepEqual(post({ severity: 'good', kind: 'backupFinished', detail: '12.3 seconds (1.2GB)' }), {
    embeds: [{ title: '✅ Backup finished (12.3 seconds (1.2GB))', color: COLORS.green }], // mid-title: no list rule, so no backslash
  });
  assert.deepEqual(post({ severity: 'problem', kind: 'backupFailed', detail: 'disk full' }), {
    embeds: [{ title: '❌ Backup failed: disk full', color: COLORS.red }],
  });
});

test('formatEvent posts a pack update when it starts and ends, coloured by outcome; its steps never', () => {
  const post = (n: Notice) => formatEvent({ ...n, type: 'notice', serverId: 's' });
  const title = (n: Notice) => (post(n) as { embeds: APIEmbed[] }).embeds[0];
  assert.deepEqual(title({ severity: 'info', kind: 'packUpdateStarted', from: '2.7.4', to: '2.7.5', by: 'alex' }), {
    title: '📦 Updating the pack: 2.7.4 → 2.7.5 (by alex)',
    color: COLORS.blue,
  });
  assert.deepEqual(title({ severity: 'info', kind: 'packUpdateStarted', from: '2.7.4', to: '2.7.4', by: 'alex' }), {
    title: '📦 Applying pack changes to 2.7.4 (by alex)',
    color: COLORS.blue,
  });
  const done = { kind: 'packUpdateFinished', from: '2.7.4', to: '2.7.5', ms: 400_000 } as const;
  assert.deepEqual(title({ ...done, severity: 'good', outcome: 'ok' }), { title: '✅ Pack updated to 2.7.5 (6 m 40 s)', color: COLORS.green });
  assert.deepEqual(title({ ...done, to: '2.7.4', severity: 'good', outcome: 'ok' }), { title: '✅ Pack changes applied to 2.7.4 (6 m 40 s)', color: COLORS.green });
  assert.deepEqual(title({ ...done, severity: 'problem', outcome: 'rolled back', backup: '2026-09-30-14-12-00.zip' }), {
    title: '❌ Pack update to 2.7.5 rolled back: 2.7.4 is running again. Pre-update backup: 2026-09-30-14-12-00.zip',
    color: COLORS.red,
  });
  assert.deepEqual(title({ ...done, severity: 'problem', outcome: 'failed' }), {
    title: "❌ Pack update to 2.7.5 failed: the server didn't come back, even after a rollback",
    color: COLORS.red,
  });
  assert.deepEqual(title({ ...done, severity: 'info', outcome: 'failed in staging' }), {
    title: "⚠️ Pack update to 2.7.5 failed while preparing: the server wasn't touched",
    color: COLORS.blue,
  });
  assert.deepEqual(title({ ...done, severity: 'info', outcome: 'cancelled' }), {
    title: "❎ Pack update to 2.7.5 cancelled: the server wasn't touched",
    color: COLORS.blue,
  });
  assert.equal(post({ severity: 'info', kind: 'packUpdateStep', step: 'prepare', state: 'running', detail: 'Downloading', cancellable: true }), null);
});

test("a factorio server's update is a game update, and the Agent's pre-update save is escaped", () => {
  const post = (n: Notice) => formatEvent({ ...n, type: 'notice', serverId: 'space' }, 'factorio');
  const title = (n: Notice) => (post(n) as { embeds: APIEmbed[] }).embeds[0]?.title;
  const from = '2.1.24 · 1 mod';
  const to = '2.1.25 · 3 mods';
  assert.equal(title({ severity: 'info', kind: 'packUpdateStarted', from, to, by: 'alex' }), `📦 Updating the game: ${from} → ${to} (by alex)`);
  const done = { kind: 'packUpdateFinished', from, to, ms: 400_000 } as const;
  assert.equal(title({ ...done, severity: 'good', outcome: 'ok' }), `✅ Game updated to ${to} (6 m 40 s)`);
  assert.equal(
    title({ ...done, severity: 'problem', outcome: 'rolled back', backup: 'orrery-pre-update_*x*_.zip' }),
    `❌ Game update to ${to} rolled back: ${from} is running again. Pre-update save: orrery-pre-update\\_\\*x\\*\\_.zip`,
  );
  assert.equal(title({ ...done, severity: 'problem', outcome: 'failed before swap' }), `❌ Game update to ${to} failed after the stop, before anything changed: ${from} is starting again`);
  assert.equal(title({ ...done, severity: 'info', outcome: 'cancelled' }), `❎ Game update to ${to} cancelled before the swap: nothing was changed`);
  assert.equal(post({ severity: 'info', kind: 'packUpdateStep', step: 'prepare', state: 'running', detail: 'Downloading', cancellable: true }), null);

  // `from` is the version the Agent reported, and the save's name the game folder's: inline() only, so a name with a
  // line-start rule's look ("1. ", "- ") keeps its text, and markdown or a masked link in either is escaped.
  const evil = '[pay](https://evil.example) **2.1** · 1 mod';
  assert.equal(title({ severity: 'info', kind: 'packUpdateStarted', from: evil, to, by: 'alex' }), `📦 Updating the game: ${inline(evil)} → ${to} (by alex)`);
  assert.equal(inline(evil), '\\[pay](https://evil.example) \\*\\*2.1\\*\\* · 1 mod');
  assert.equal(
    title({ ...done, from: evil, severity: 'problem', outcome: 'rolled back', backup: '1. orrery-pre-update-2.1.24.zip' }),
    `❌ Game update to ${to} rolled back: ${inline(evil)} is running again. Pre-update save: 1. orrery-pre-update-2.1.24.zip`,
  );
  assert.equal(
    title({ ...done, from: evil, severity: 'problem', outcome: 'failed before swap' }),
    `❌ Game update to ${to} failed after the stop, before anything changed: ${inline(evil)} is starting again`,
  );
});

test('a notice is coloured by its severity, not its text', () => {
  const color = (severity: Severity) =>
    (formatEvent({ severity, kind: 'restartNow', type: 'notice', serverId: 's' }) as { embeds: APIEmbed[] }).embeds[0].color;
  assert.equal(color('problem'), COLORS.red);
  assert.equal(color('warning'), COLORS.orange);
  assert.equal(color('good'), COLORS.green);
  assert.equal(color('info'), COLORS.blue);
});

test("an Agent's text in a notice or a topic is escaped: a backup's detail, a save's name, a refusal, a mount, a version (inline: mid-line or a title), players", () => {
  const evil = '[pay](https://evil.example) # **x** ||y|| <#1>';
  assert.notEqual(md(evil), evil);
  // A notice is an embed title, so its Agent text is escaped inline: masked links and every inline markup still are.
  assert.equal(inline(evil), '\\[pay](https://evil.example) # \\*\\*x\\*\\* \\|\\|y\\|\\| <#1>');
  assert.equal(inline('`a` _b_ ~~c~~ __d__ *e*'), '\\`a\\` \\_b\\_ \\~\\~c\\~\\~ \\_\\_d\\_\\_ \\*e\\*');
  assert.equal(inline('12.3 seconds (1.2GB)'), '12.3 seconds (1.2GB)');
  assert.equal(inline('1.4.0'), '1.4.0');
  const notice = (n: Notice) => (formatEvent({ ...n, type: 'notice', serverId: 'space' }) as { embeds: APIEmbed[] }).embeds[0]!.title;
  assert.equal(notice({ severity: 'good', kind: 'backupFinished', detail: evil }), `✅ Backup finished (${inline(evil)})`);
  assert.equal(notice({ severity: 'problem', kind: 'backupFailed', detail: evil }), `❌ Backup failed: ${inline(evil)}`);
  assert.equal(notice({ severity: 'warning', kind: 'backupOverdue', hours: 13, newest: evil }), `⚠️ No new backup for 13 h (newest: ${inline(evil)})`);
  assert.equal(notice({ severity: 'problem', kind: 'restartFailed', error: evil }), `❌ Restart failed: ${inline(evil)}`);
  const target = (e: object) => (formatTargetEvent(e as TargetEvent) as { embeds: APIEmbed[] }).embeds[0]!.title;
  const host = { target: 'host', id: 'vm', type: 'notice' };
  assert.equal(target({ ...host, severity: 'warning', kind: 'diskLow', mount: evil, free: 0, minFreeGB: 10 }), `⚠️ Host vm: low disk on ${inline(evil)}: 0 B free (limit 10 GB)`);
  assert.equal(target({ ...host, severity: 'good', kind: 'diskOk', mount: evil, free: 0 }), `✅ Host vm: disk on ${inline(evil)} back to 0 B free`);
  assert.equal(
    target({ ...host, severity: 'warning', kind: 'eventsOff', name: 'Factorio VM', reason: evil }),
    `⚠️ Host vm: game events from agent Factorio VM are off: ${inline(evil)}`,
  );
  assert.equal(target({ ...host, severity: 'warning', kind: 'eventsOff', name: 'Factorio VM', reason: 'x'.repeat(2048) })!.length, 256); // an embed title's most
  assert.equal(target({ ...host, severity: 'good', kind: 'eventsOn', name: 'Factorio VM' }), '✅ Host vm: game events from agent Factorio VM are on again');
  const deploy = { target: 'deploy', id: 'gtnh', type: 'notice', part: 'mod', from: evil, to: 'mod-v1.2.0' };
  assert.equal(target({ ...deploy, severity: 'info', kind: 'deployStarted', by: 'web:a (1)' }), `🚀 Deploying the Mod on gtnh: ${inline(evil)} → mod-v1.2.0 (by web:a (1))`);
  assert.equal(target({ ...deploy, severity: 'problem', kind: 'deployFinished', outcome: 'rolled back' }), `❌ Deploying the Mod on gtnh mod-v1.2.0 failed: rolled back to ${inline(evil)}`);
  assert.equal(formatTopic({ ...online, game: 'factorio', tps: 60, players: [evil] }), `🟢 Online · 60 UPS · 1 player: ${md(evil)}`);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from 'discord.js';
import { channelFor, COMMANDS, shouldRelay } from '../src/discord.ts';
import type { TargetEvent } from '../src/servers.ts';

const msg = (over: { bot?: boolean; webhookId?: string | null; system?: boolean }) =>
  ({ author: { bot: over.bot ?? false }, webhookId: over.webhookId ?? null, system: over.system ?? false }) as unknown as Message;

test('shouldRelay passes people only', () => {
  assert.equal(shouldRelay(msg({})), true);
  assert.equal(shouldRelay(msg({ bot: true })), false);
  assert.equal(shouldRelay(msg({ webhookId: '123' })), false); // includes our own relay webhook: no echo loop
  assert.equal(shouldRelay(msg({ system: true })), false); // "thread created", pins, joins
});

test('admin commands are hidden by default; public ones are not', () => {
  const perms = Object.fromEntries(COMMANDS.map((c) => [c.name, c.default_member_permissions]));
  assert.equal(perms.cmd, '0');
  assert.equal(perms.restart, '0');
  assert.equal(perms.backup, '0');
  for (const name of ['status', 'list', 'playtime', 'top', 'tps', 'link', 'unlink']) assert.ok(!perms[name], name);
});

test('the command set includes stats and backup subcommands', () => {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(byName).sort(), ['backup', 'cmd', 'link', 'list', 'playtime', 'restart', 'status', 'top', 'tps', 'unlink']);
  assert.deepEqual(byName.playtime.options?.map((o) => [o.name, o.required ?? false]), [
    ['player', false],
    ['user', false],
  ]);
  assert.deepEqual(byName.backup.options?.map((o) => o.name), ['start', 'status', 'list']);
  assert.deepEqual(
    (byName.top.options?.[0] as { choices?: { value: string }[] }).choices?.map((c) => c.value),
    ['day', 'week', 'all'],
  );
});

test('notices about the host, services and checks go only to the alerts channel, if there is one', () => {
  const cfg = { guildId: '1'.repeat(18), adminRoleId: '2'.repeat(18), channels: { gtnh: '3'.repeat(18) } };
  // A check named like a server is still not that server's.
  const check: TargetEvent = { target: 'check', id: 'gtnh', type: 'notice', severity: 'problem', kind: 'checkDown', url: 'https://x', error: 'HTTP 503' };
  assert.equal(channelFor(check, cfg), undefined);
  assert.equal(channelFor(check, { ...cfg, alertsChannel: '4'.repeat(18) }), '4'.repeat(18));
  assert.equal(channelFor({ serverId: 'gtnh', type: 'started' }, { ...cfg, alertsChannel: '4'.repeat(18) }), '3'.repeat(18));
  assert.equal(channelFor({ serverId: 'toString', type: 'started' }, cfg), undefined);
});

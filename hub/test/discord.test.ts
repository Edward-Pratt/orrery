import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message, Webhook } from 'discord.js';
import { channelFor, COMMANDS, REFUSED_KEPT, relayAs, sendChat, shouldRelay } from '../src/discord.ts';
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

/** A Discord API error as discord.js throws it: Invalid Form Body, with the field Discord refused. */
const formError = (field: string, code: string, message: string) =>
  Object.assign(new Error(`Invalid Form Body\n${field}[${code}]: ${message}`), {
    code: 50035,
    rawError: { code: 50035, message: 'Invalid Form Body', errors: { [field]: { _errors: [{ code, message }] } } },
  });

/** A relay webhook that answers as Discord does: content over 2000 characters, or a name with "discord", is refused. */
function fakeWebhook() {
  const sent: { username: string; content: string }[] = [];
  const hook = {
    send: async (m: { username: string; content: string }) => {
      if (m.content.length > 2000) throw formError('content', 'BASE_TYPE_MAX_LENGTH', 'Must be 2000 or fewer in length.');
      if (/discord/i.test(m.username)) throw formError('username', 'USERNAME_INVALID_CONTAINS', 'Username cannot contain "discord"');
      sent.push({ username: m.username, content: m.content });
    },
  } as unknown as Webhook;
  return { hook, sent };
}

test('a 3000-character chat message posts through the webhook cut to 2000, and its name stays allowed', async () => {
  const { hook, sent } = fakeWebhook();
  const refused = new Set<string>();
  await sendChat(hook, refused, 'Steve', undefined, 'a'.repeat(3000));
  assert.deepEqual(sent, [{ username: 'Steve', content: 'a'.repeat(2000) }]);
  assert.deepEqual([...refused], []);
});

test("only Discord's error about the username adds the name to refusedNames", async () => {
  const refused = new Set<string>();
  const { hook } = fakeWebhook();
  await assert.rejects(sendChat(hook, refused, 'discordfan', undefined, 'hi'), /Username cannot contain/);
  assert.deepEqual([...refused], ['discordfan']);
  const tooLong = { send: async () => Promise.reject(formError('content', 'BASE_TYPE_MAX_LENGTH', 'Must be 2000 or fewer in length.')) } as unknown as Webhook;
  await assert.rejects(sendChat(tooLong, refused, 'Steve', undefined, 'hi'), /2000 or fewer/);
  const gone = { send: async () => Promise.reject(Object.assign(new Error('Unknown Webhook'), { code: 10015 })) } as unknown as Webhook;
  await assert.rejects(sendChat(gone, refused, 'Alex', undefined, 'hi'), /Unknown Webhook/);
  assert.deepEqual([...refused], ['discordfan']);
});

test(`refusedNames keeps the newest ${REFUSED_KEPT} names Discord refused, dropping the oldest`, async () => {
  const refused = new Set<string>();
  const { hook } = fakeWebhook();
  for (let i = 0; i <= REFUSED_KEPT; i++) await assert.rejects(sendChat(hook, refused, `discord${i}`, undefined, 'hi'));
  assert.equal(refused.size, REFUSED_KEPT);
  assert.equal(refused.has('discord0'), false);
  assert.equal(refused.has('discord1'), true);
  assert.equal(refused.has(`discord${REFUSED_KEPT}`), true);
});

test("the relay webhook's name: a factorio player's is tagged (Factorio), and one with whitespace, parentheses, discord or clyde goes out as the bot", () => {
  const chat = (player: string) => ({ serverId: 's', type: 'chat' as const, player, message: 'restart now' });
  assert.deepEqual(relayAs(chat('Ann_2.b-c'), 'factorio'), { username: 'Ann_2.b-c (Factorio)' });
  for (const name of ['Edward (dashboard)', 'Edward(dashboard)', 'Ed ward', 'Ed\tward', 'Orrery\u00a0Bot', ')', 'discord1', 'xDiScOrDx', 'Clyde', 'myclyde']) {
    assert.equal(relayAs(chat(name), 'factorio'), null, name);
  }
  // Unchanged: a minecraft player's name and skin (a refused one is left to sendChat), and a dashboard line's marked name and avatar.
  assert.deepEqual(relayAs(chat('Steve'), 'minecraft'), { username: 'Steve', avatarURL: 'https://mc-heads.net/avatar/Steve/64' });
  assert.deepEqual(relayAs(chat('discordfan'), 'minecraft'), { username: 'discordfan', avatarURL: 'https://mc-heads.net/avatar/discordfan/64' });
  const say = { serverId: 's', type: 'say' as const, author: 'Edward', message: 'hi', source: 'dashboard' as const, avatar: 'https://cdn/a.png' };
  assert.deepEqual(relayAs(say, 'factorio'), { username: 'Edward (dashboard)', avatarURL: 'https://cdn/a.png' });
});

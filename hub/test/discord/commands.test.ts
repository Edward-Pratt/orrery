import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatInputCommandInteraction } from 'discord.js';
import { handleCommand, type CommandCtx } from '../../src/discord/commands.ts';
import type { DiscordUsers } from '../../src/discord/admin.ts';

const ROLE = '2'.repeat(18);
const FRIEND = '1'.repeat(18);

/** A `/restart cancel` from the friend, who holds the admin role, in gtnh's channel; its replies and the cancels it caused. */
function restartCancel(users: DiscordUsers | undefined) {
  const replies: unknown[] = [];
  const cancels: string[] = [];
  const ctx = {
    hub: { get: (id: string) => (id === 'gtnh' ? { name: 'GTNH' } : undefined) },
    restarts: { cancel: (id: string) => (cancels.push(id), true) },
    cfg: { adminRoleId: ROLE },
    serverByChannel: new Map([['c-gtnh', 'gtnh']]),
    users,
  } as unknown as CommandCtx;
  const i = {
    channelId: 'c-gtnh',
    commandName: 'restart',
    user: { id: FRIEND, username: 'friend' },
    inCachedGuild: () => true,
    member: { roles: { cache: new Map([[ROLE, {}]]) } },
    options: { getSubcommand: () => 'cancel' },
    reply: async (r: unknown) => void replies.push(r),
  } as unknown as ChatInputCommandInteraction;
  return { run: () => handleCommand(ctx, i), replies, cancels };
}

test("handleCommand refuses a linked User scoped to another server, though they hold the admin role", async () => {
  const users: DiscordUsers = { byDiscordId: () => ({ user: { disabled: false }, grants: [{ owner: false, permissions: ['servers.control'], servers: ['factorio'] }] }) as never };
  const { run, replies, cancels } = restartCancel(users);
  await run();
  assert.deepEqual(cancels, []);
  assert.match(JSON.stringify(replies), /needs servers\.control on gtnh/);
});

test('handleCommand lets the admin role through for a member linked to no User', async () => {
  const { run, replies, cancels } = restartCancel({ byDiscordId: () => undefined });
  await run();
  assert.deepEqual(cancels, ['gtnh']);
  assert.match(JSON.stringify(replies), /Restart cancelled/);
});

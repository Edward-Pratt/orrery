import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DiscordUsers } from '../src/discord/admin.ts';
import { startHub } from '../src/start.ts';
import { config, WEB } from './web/web-hub.ts';

const DISCORD = { guildId: '1'.repeat(18), adminRoleId: '2'.repeat(18), channels: { gtnh: '3'.repeat(18) } };

/** Starts a hub with `integrations`, answering the `Users` its frontend was given. */
async function frontendUsers(t: Parameters<typeof config>[0], integrations: Parameters<typeof config>[1]) {
  let given: DiscordUsers | undefined | 'unset' = 'unset';
  const handle = await startHub(config(t, integrations), {
    startFrontend: async (_h, _s, _r, _l, _c, users) => {
      given = users;
      return { stop: () => {} };
    },
    get: async () => ({ ok: true, status: 200 }),
  });
  t.after(() => handle.close());
  return { given, handle };
}

test("the bot gets the web API's Users, so a linked member's admin commands follow their grants", async (t) => {
  const { given, handle } = await frontendUsers(t, { discord: DISCORD, web: WEB });
  assert.ok(handle.web);
  assert.equal(given, handle.web.users);
});

test('with web off the bot gets no Users: the admin role alone decides', async (t) => {
  const { given } = await frontendUsers(t, { discord: DISCORD });
  assert.equal(given, undefined);
});

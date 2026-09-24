import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Db } from '../src/db.ts';
import { CODE_ALPHABET, Links } from '../src/links.ts';
import type { HubEvent, ServerHub } from '../src/servers.ts';

function setup() {
  const db = new Db(':memory:');
  const events = new EventEmitter<{ event: [HubEvent] }>();
  const results: string[] = [];
  const linked: string[] = [];
  const hub = {
    on: (name: 'event', fn: (e: HubEvent) => void) => events.on(name, fn),
    sendLinkResult: (_id: string, player: string, ok: boolean, message: string) => results.push(`${player}|${ok}|${message}`),
  } as unknown as Pick<ServerHub, 'on' | 'sendLinkResult'>;
  const links = new Links(db, hub, (serverId, player, discordId) => linked.push(`${serverId}|${player}|${discordId}`));
  return { db, links, events, results, linked };
}

test('a code links once, case-insensitively, and replaces the previous code', () => {
  const { db, links } = setup();
  const first = links.issue('d1', 'Edward');
  const code = links.issue('d1', 'Edward');
  assert.equal(code.length, 6);
  assert.ok([...code].every((c) => CODE_ALPHABET.includes(c)));
  assert.equal(links.redeem(first, 'Steve', 'u1').ok, false); // replaced
  assert.deepEqual(links.redeem(code.toLowerCase(), 'Steve', 'u1'), {
    ok: true,
    message: 'Linked to Edward on Discord.',
    discordId: 'd1',
  });
  assert.equal(links.redeem(code, 'Steve', 'u1').ok, false); // used up
  assert.deepEqual(db.linkByDiscord('d1'), { player: 'Steve', uuid: 'u1' });
  assert.deepEqual(db.linkByPlayer('steve'), { discordId: 'd1', player: 'Steve' });
});

test('codes expire after 10 minutes', () => {
  const { links } = setup();
  const code = links.issue('d1', 'Edward', 0);
  assert.equal(links.redeem(code, 'Steve', 'u1', 10 * 60_000).ok, false);
});

test('a player or a Discord account has at most one link', () => {
  const { db, links } = setup();
  links.redeem(links.issue('d1', 'A'), 'Steve', 'u1');
  links.redeem(links.issue('d2', 'B'), 'Steve', 'u1'); // Steve moves to d2
  assert.equal(db.linkByDiscord('d1'), null);
  links.redeem(links.issue('d2', 'B'), 'Alex', 'u2'); // d2 moves to Alex
  assert.equal(db.linkByPlayer('Steve'), null);
  assert.deepEqual(db.linkByDiscord('d2'), { player: 'Alex', uuid: 'u2' });
  assert.equal(links.unlinkDiscord('d2'), true);
  assert.equal(links.unlinkDiscord('d2'), false);
});

test('five wrong guesses lock the player out for a while', () => {
  const { links } = setup();
  const code = links.issue('d1', 'Edward', 0);
  for (let i = 0; i < 5; i++) assert.match(links.redeem('WRONG1', 'Steve', 'u1', 1000).message, /unknown or expired/);
  assert.match(links.redeem(code, 'Steve', 'u1', 2000).message, /Too many attempts/);
  const fresh = links.issue('d1', 'Edward', 10 * 60_000 + 1000);
  assert.equal(links.redeem(fresh, 'Steve', 'u1', 10 * 60_000 + 1001).ok, true); // the lock wears off
});

test('link and unlink messages from the mod are answered and announced', () => {
  const { links, events, results, linked } = setup();
  const code = links.issue('d1', 'Edward');
  events.emit('event', { serverId: 'gtnh', type: 'link', player: 'Steve', uuid: 'u1', code });
  events.emit('event', { serverId: 'gtnh', type: 'unlink', player: 'Steve' });
  events.emit('event', { serverId: 'gtnh', type: 'unlink', player: 'Steve' });
  assert.deepEqual(results, [
    'Steve|true|Linked to Edward on Discord.',
    'Steve|true|Unlinked from Discord.',
    "Steve|false|You weren't linked.",
  ]);
  assert.deepEqual(linked, ['gtnh|Steve|d1']);
});

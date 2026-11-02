import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { Db } from '../../src/stats/db.ts';
import { CODE_ALPHABET, Links } from '../../src/servers/links.ts';
import type { Announcement, HubEvent, ServerHub, ServerState } from '../../src/servers/servers.ts';
import type { Game } from '../../src/types.ts';

/** Two servers: `gtnh` runs Minecraft, `space` Factorio. */
const GAMES: Record<string, Game> = { gtnh: 'minecraft', space: 'factorio' };

function setup() {
  const db = new Db(':memory:');
  const events = new EventEmitter<{ event: [HubEvent] }>();
  const results: string[] = [];
  const linked: (Announcement & { serverId: string })[] = [];
  const hub = {
    on: (name: 'event', fn: (e: HubEvent) => void) => events.on(name, fn),
    get: (id: string) => (Object.hasOwn(GAMES, id) ? ({ id, game: GAMES[id] } as ServerState) : undefined),
    sendLinkResult: (id: string, player: string, ok: boolean, message: string) => results.push(`${id}|${player}|${ok}|${message}`),
    announce: (serverId: string, a: Announcement) => linked.push({ ...a, serverId }),
  } as unknown as Pick<ServerHub, 'on' | 'get' | 'sendLinkResult' | 'announce'>;
  const links = new Links(db, hub);
  return { db, links, events, results, linked };
}

test('a code links once, case-insensitively, and replaces the previous code', () => {
  const { db, links } = setup();
  const first = links.issue('d1', 'Edward');
  const code = links.issue('d1', 'Edward');
  assert.equal(code.length, 6);
  assert.ok([...code].every((c) => CODE_ALPHABET.includes(c)));
  assert.equal(links.redeem(first, 'minecraft', 'Steve', 'u1').ok, false); // replaced
  assert.deepEqual(links.redeem(code.toLowerCase(), 'minecraft', 'Steve', 'u1'), {
    ok: true,
    message: 'Linked to Edward on Discord.',
    discordId: 'd1',
  });
  assert.equal(links.redeem(code, 'minecraft', 'Steve', 'u1').ok, false); // used up
  assert.deepEqual(db.linkByDiscord('d1'), { player: 'Steve', uuid: 'u1' });
  assert.deepEqual(db.linkByPlayer('steve'), { discordId: 'd1', player: 'Steve' });
});

test('codes expire after 10 minutes', () => {
  const { links } = setup();
  const code = links.issue('d1', 'Edward', 0);
  assert.equal(links.redeem(code, 'minecraft', 'Steve', 'u1', 10 * 60_000).ok, false);
});

test('a player or a Discord account has at most one link', () => {
  const { db, links } = setup();
  links.redeem(links.issue('d1', 'A'), 'minecraft', 'Steve', 'u1');
  links.redeem(links.issue('d2', 'B'), 'minecraft', 'Steve', 'u1'); // Steve moves to d2
  assert.equal(db.linkByDiscord('d1'), null);
  links.redeem(links.issue('d2', 'B'), 'minecraft', 'Alex', 'u2'); // d2 moves to Alex
  assert.equal(db.linkByPlayer('Steve'), null);
  assert.deepEqual(db.linkByDiscord('d2'), { player: 'Alex', uuid: 'u2' });
  assert.equal(links.unlinkDiscord('d2'), true);
  assert.equal(links.unlinkDiscord('d2'), false);
});

test('five wrong guesses lock the player out for a while', () => {
  const { links } = setup();
  const code = links.issue('d1', 'Edward', 0);
  for (let i = 0; i < 5; i++) assert.match(links.redeem('WRONG1', 'minecraft', 'Steve', 'u1', 1000).message, /unknown or expired/);
  assert.match(links.redeem(code, 'minecraft', 'Steve', 'u1', 2000).message, /Too many attempts/);
  const fresh = links.issue('d1', 'Edward', 10 * 60_000 + 1000);
  assert.equal(links.redeem(fresh, 'minecraft', 'Steve', 'u1', 10 * 60_000 + 1001).ok, true); // the lock wears off
});

test('link and unlink messages from the mod are answered and announced', () => {
  const { links, events, results, linked } = setup();
  const code = links.issue('d1', 'Edward');
  events.emit('event', { serverId: 'gtnh', type: 'link', player: 'Steve', uuid: 'u1', code });
  events.emit('event', { serverId: 'gtnh', type: 'unlink', player: 'Steve' });
  events.emit('event', { serverId: 'gtnh', type: 'unlink', player: 'Steve' });
  assert.deepEqual(results, [
    'gtnh|Steve|true|Linked to Edward on Discord.',
    'gtnh|Steve|true|Unlinked from Discord.',
    "gtnh|Steve|false|You weren't linked.",
  ]);
  assert.deepEqual(linked, [{ type: 'linked', player: 'Steve', discordId: 'd1', serverId: 'gtnh' }]);
});

test('a Factorio link writes only factorio_links, leaving the Minecraft link alone', () => {
  const { db, links, events, results, linked } = setup();
  links.redeem(links.issue('d1', 'Edward'), 'minecraft', 'Steve', 'u1');
  const code = links.issue('d1', 'Edward');
  events.emit('event', { serverId: 'space', type: 'link', player: 'engineer', uuid: '', code }); // Factorio has no uuid
  assert.deepEqual(results, ['space|engineer|true|Linked to Edward on Discord.']);
  assert.deepEqual(linked, [{ type: 'linked', player: 'engineer', discordId: 'd1', serverId: 'space' }]);
  assert.deepEqual(db.factorioLinkByDiscord('d1'), { name: 'engineer' });
  assert.deepEqual(db.factorioLinkByName('ENGINEER'), { discordId: 'd1', name: 'engineer' });
  assert.deepEqual(db.linkByDiscord('d1'), { player: 'Steve', uuid: 'u1' }); // still the Minecraft one
  assert.equal(db.linkByPlayer('engineer'), null);
});

test("a Factorio link replaces the user's and the name's earlier Factorio link, never a Minecraft one", () => {
  const { db, links } = setup();
  links.redeem(links.issue('d1', 'A'), 'minecraft', 'Steve', 'u1');
  links.redeem(links.issue('d1', 'A'), 'factorio', 'Steve', '');
  links.redeem(links.issue('d1', 'A'), 'factorio', 'engineer', ''); // d1 moves to engineer
  assert.equal(db.factorioLinkByName('Steve'), null);
  links.redeem(links.issue('d2', 'B'), 'factorio', 'Engineer', ''); // the name moves to d2, any case
  assert.equal(db.factorioLinkByDiscord('d1'), null);
  assert.deepEqual(db.factorioLinkByName('engineer'), { discordId: 'd2', name: 'Engineer' });
  assert.deepEqual(db.linkByDiscord('d1'), { player: 'Steve', uuid: 'u1' });
  links.redeem(links.issue('d3', 'C'), 'minecraft', 'Engineer', 'u3'); // a Minecraft link of that name
  assert.deepEqual(db.factorioLinkByName('engineer'), { discordId: 'd2', name: 'Engineer' });
});

test("Discord's /unlink clears the user's links in both games", () => {
  const { db, links } = setup();
  links.redeem(links.issue('d1', 'A'), 'minecraft', 'Steve', 'u1');
  links.redeem(links.issue('d1', 'A'), 'factorio', 'engineer', '');
  links.redeem(links.issue('d2', 'B'), 'factorio', 'pilot', ''); // a Factorio link only
  assert.equal(links.unlinkDiscord('d1'), true);
  assert.equal(db.linkByDiscord('d1'), null);
  assert.equal(db.factorioLinkByDiscord('d1'), null);
  assert.equal(links.unlinkDiscord('d1'), false);
  assert.equal(links.unlinkDiscord('d2'), true);
  assert.equal(db.factorioLinkByDiscord('d2'), null);
});

test('failed attempts are counted per game: a locked Factorio name does not lock that Minecraft name', () => {
  const { links } = setup();
  for (let i = 0; i < 5; i++) assert.match(links.redeem('WRONG1', 'factorio', 'Steve', '', 1000).message, /unknown or expired/);
  assert.match(links.redeem(links.issue('d1', 'A', 1000), 'factorio', 'steve', '', 2000).message, /Too many attempts/);
  assert.equal(links.redeem(links.issue('d1', 'A', 1000), 'minecraft', 'Steve', 'u1', 2000).ok, true);
});

test('an in-game unlink removes only its own game\'s link: a Factorio unlink never removes a Minecraft link of that name', () => {
  const { db, links, events, results } = setup();
  links.redeem(links.issue('d1', 'A'), 'minecraft', 'Steve', 'u1');
  links.redeem(links.issue('d2', 'B'), 'factorio', 'Steve', '');
  events.emit('event', { serverId: 'space', type: 'unlink', player: 'steve' });
  events.emit('event', { serverId: 'space', type: 'unlink', player: 'Steve' });
  assert.equal(db.factorioLinkByName('Steve'), null);
  assert.deepEqual(db.linkByPlayer('Steve'), { discordId: 'd1', player: 'Steve' });
  events.emit('event', { serverId: 'gtnh', type: 'unlink', player: 'Steve' });
  assert.equal(db.linkByPlayer('Steve'), null);
  assert.deepEqual(results, ['space|steve|true|Unlinked from Discord.', "space|Steve|false|You weren't linked.", 'gtnh|Steve|true|Unlinked from Discord.']);
});

test('names with wrong codes are kept at most 1000, the oldest dropped, and forgotten a code lifetime after their newest', () => {
  const { links } = setup();
  for (let i = 0; i < 5; i++) links.redeem('WRONG1', 'minecraft', 'Steve', 'u1', 1000, 'gtnh'); // Steve is locked
  // 5000 fresh names, each on its own server so no server's limit stops them first
  for (let i = 0; i < 5000; i++) {
    links.redeem('WRONG1', 'factorio', `name${i}`, '', 2000 + i, `server${i}`);
    assert.ok(links.failing <= 1000);
  }
  assert.equal(links.failing, 1000);
  const code = links.issue('d1', 'A', 7000);
  assert.equal(links.redeem(code, 'minecraft', 'Steve', 'u1', 7001, 'gtnh').ok, true); // the oldest went: Steve too
  links.issue('d2', 'B', 2000 + 4998 + 10 * 60_000); // all but the newest are a code lifetime old
  assert.equal(links.failing, 1);
  links.issue('d2', 'B', 2000 + 4999 + 10 * 60_000);
  assert.equal(links.failing, 0);
});

test("twenty wrong codes on a factorio server lock it for any name, a right code too, until they age out; a Mod's server only per name", () => {
  const { links, events, results } = setup();
  for (let i = 0; i < 20; i++) assert.match(links.redeem('WRONG1', 'factorio', `fresh${i}`, '', 1000, 'space').message, /unknown or expired/);
  const code = links.issue('d1', 'A', 1000);
  assert.match(links.redeem(code, 'factorio', 'engineer', '', 2000, 'space').message, /Too many attempts/);
  assert.equal(links.redeem(code, 'minecraft', 'Steve', 'u1', 2000, 'gtnh').ok, true); // another server is not locked
  const again = links.issue('d1', 'A', 1000 + 10 * 60_000);
  assert.equal(links.redeem(again, 'factorio', 'engineer', '', 1000 + 10 * 60_000, 'space').ok, true); // the lock wears off

  // A Mod's players are on its server (trusted input): their wrong codes lock only their own names.
  for (let i = 0; i < 40; i++) events.emit('event', { serverId: 'gtnh', type: 'link', player: `typo${i % 8}`, uuid: 'u', code: 'WRONG1' });
  const right = links.issue('d2', 'B');
  events.emit('event', { serverId: 'gtnh', type: 'link', player: 'typo0', uuid: 'u', code: right });
  assert.equal(results.at(-1), 'gtnh|typo0|false|Too many attempts; try again in a few minutes.');
  events.emit('event', { serverId: 'gtnh', type: 'link', player: 'Alex', uuid: 'u2', code: right });
  assert.equal(results.at(-1), 'gtnh|Alex|true|Linked to B on Discord.');
});

// What a game update checks and sends: the Agent's text redacted, an update's line fit, the routes' 400s and the
// refusals before any link, row or request (`game-messages.ts`, `game-run.ts`).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GameCatalog } from '../../src/api.ts';
import { fitsLine, redact } from '../../src/updates/game-updates.ts';
import { LIMITS } from '../../src/protocol.ts';
import { agentUp, eventually, gameHub, MODS, PICK, ready, rel } from '../fake-agent.ts';

test('redact takes query strings and credentials out of what the Agent says', () => {
  assert.equal(
    redact('GET https://dl-mod.factorio.com/files/ab/x.zip?secure=abc,1 failed; dl-mod.factorio.com/y.zip?secure=def also; username=owner&token=t0k'),
    'GET https://dl-mod.factorio.com/files/ab/x.zip failed; dl-mod.factorio.com/y.zip also; username=[redacted]&token=[redacted]',
  );
  assert.equal(redact('Staged: 3 mods, 41 MB'), 'Staged: 3 mods, 41 MB');
});

test('the game routes: 404 for a server no Agent runs, 400 for bad input, 409 with unmet dependencies, nothing to change or no Agent', async (t) => {
  const h = await gameHub(t);
  assert.equal((await h.req('GET', '/api/servers/gtnh/game')).status, 404);
  assert.equal((await h.req('GET', '/api/servers/nope/game')).status, 404);
  assert.equal((await h.game()).blocked, "Space Age's Agent isn't connected.");
  const refused = async (path: string, body: unknown, status: number, text: string | RegExp) => {
    const res = await h.req('POST', `/api/servers/space/game/${path}`, body);
    assert.equal(res.status, status, path);
    const got = await res.text();
    if (typeof text === 'string') assert.equal(got, text);
    else assert.match(got, text);
  };
  await refused('update', PICK, 409, "Space Age's Agent isn't connected.");
  const a = await agentUp(h.agentPort);
  await eventually(async () => (await h.game()).installed !== null);
  await refused('catalog', { factorio: '2.1', mods: [] }, 400, 'Give a Factorio version, like 2.1.24.');
  await refused('catalog', { factorio: '2.1.24', mods: [{ name: '../x', version: null }] }, 400, 'Give each mod by its name on the mod portal.');
  await refused('catalog', { factorio: '2.1.24', mods: [{ name: '.', version: null }] }, 400, 'Give each mod by its name on the mod portal.');
  await refused('catalog', { factorio: '2.1.24', mods: [{ name: 'flib', version: '../../x' }] }, 400, 'flib: give a version like 1.2.3, or null for the newest that fits.');
  await refused('catalog', { factorio: '2.1.24', mods: [{ name: 'base', version: null }] }, 400, "base comes with Factorio: it isn't picked.");
  await refused('catalog', { factorio: '2.1.24', mods: [{ name: 'flib', version: null }, { name: 'flib', version: null }] }, 400, 'flib is picked twice.');
  await refused('catalog', { factorio: '2.1.24', mods: [{ name: 'gone', version: null }] }, 404, 'The mod portal has no mod gone.');
  const needy = await h.json<GameCatalog>(h.req('POST', '/api/servers/space/game/catalog', { factorio: '2.1.24', mods: [{ name: 'needy', version: null }] }));
  assert.deepEqual(needy.unresolved, [{ mod: 'needy', dependency: 'nowhere', reason: 'Not on the mod portal.' }]);
  await refused('update', { factorio: '2.1.24', mods: [{ name: 'needy', version: null }] }, 409, 'Unmet dependencies: needy needs nowhere: Not on the mod portal.');
  await refused('update', { factorio: '2.1.24', mods: [{ name: 'orrery', version: null }] }, 409, 'Nothing to change: Space Age runs 2.1.24 · 5 mods already.');
  await refused('update', { factorio: '2.1.99', mods: [{ name: 'orrery', version: null }] }, 400, "factorio.com lists no headless build of Factorio 2.1.99 for the Agent's machine.");
  await refused('update/cancel', {}, 409, 'No game update is running on Space Age.');
  assert.ok(!a.got.some((m) => m.type === 'update'));
  // A release 1 Agent refuses `update`: the row ends failed in staging, with its reason.
  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  await a.answer('update is not supported by this agent');
  await eventually(async () => (await h.game()).history[0]?.outcome === 'failed in staging');
  assert.ok((await h.game()).history[0]!.log.includes('prepare: failed: update is not supported by this agent'));
  // Refused outright, it never took the update: no updateCancel, which would hit whatever update it does run.
  a.agent.send({ type: 'ping' });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(!a.got.some((m) => m.type === 'updateCancel'));
});

test('without FACTORIO_USERNAME and FACTORIO_TOKEN the hub runs, the catalog answers, and only an update is refused, saying why', async (t) => {
  const h = await ready(t, {}, { account: false });
  assert.equal((await h.json<GameCatalog>(h.req('POST', '/api/servers/space/game/catalog', PICK))).mods.length, 3);
  const res = await h.req('POST', '/api/servers/space/game/update', PICK);
  assert.equal(res.status, 409);
  assert.equal(await res.text(), "FACTORIO_USERNAME and FACTORIO_TOKEN aren't set on the hub (/etc/orrery-factorio-account.env), so it can't get the mods' download links.");
  assert.equal((await h.game()).history.length, 0);
  // Every update has mods to fetch: orrery at least.
  const none = await h.req('POST', '/api/servers/space/game/update', { factorio: '2.1.24', mods: [] });
  assert.deepEqual([none.status, await none.text()], [409, "The mods must include orrery: the Agent's health gate reads it."]);
  assert.ok(!h.got.some((m) => m.type === 'update'));
});

test('a game update without orrery, or over the Agent\'s mods, is refused before any link, row or request', async (t) => {
  const h = await ready(t);
  const refused = async (mods: { name: string; version: null }[]) => {
    const res = await h.req('POST', '/api/servers/space/game/update', { factorio: '2.1.24', mods });
    return [res.status, await res.text()];
  };
  assert.deepEqual(await refused([{ name: 'helmod', version: null }]), [409, "The mods must include orrery: the Agent's health gate reads it."]);
  // 500 picks, the most a request takes, and a dependency of one of them: 501 mods, more than an `update` holds.
  for (let i = 1; i < LIMITS.mods; i++) MODS[`m${i}`] = [rel(`m${i}`, '1.0.0', i === 1 ? ['base >= 2.1.0', 'flib'] : undefined)];
  const many = [{ name: 'orrery', version: null }, ...Array.from({ length: LIMITS.mods - 1 }, (_, i) => ({ name: `m${i + 1}`, version: null }))];
  const [status, text] = await refused(many);
  assert.equal(status, 409);
  assert.match(text as string, new RegExp(`More than ${LIMITS.mods} mods`));
  assert.deepEqual((await h.game()).history, []);
  assert.ok(!h.got.some((m) => m.type === 'update'));
});

test("fitsLine: an update fits the Agent port's line only with its newline within LIMITS.lineBytes", () => {
  const msg = (n: number) => ({ type: 'update', pad: 'a'.repeat(n) });
  const empty = Buffer.byteLength(JSON.stringify(msg(0)));
  assert.ok(fitsLine(msg(LIMITS.lineBytes - 1 - empty)));
  assert.ok(!fitsLine(msg(LIMITS.lineBytes - empty)));
  assert.ok(!fitsLine({ type: 'update', pad: 'é'.repeat(LIMITS.lineBytes / 2) }), 'bytes, not characters');
});

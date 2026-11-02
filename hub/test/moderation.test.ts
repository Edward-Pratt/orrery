import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AuditLog, ModerateAnswer, ModerationState } from '../src/api.ts';
import { moderateRequest } from '../src/moderation.ts';
import { parseReplyData } from '../src/protocol.ts';
import type { PlayerLists } from '../src/types.ts';
import { ACTOR, ready } from './fake-agent.ts';

const LISTS: PlayerLists = { bans: [{ name: 'griefer_1', reason: 'stealing iron' }], bansTotal: 1, hidden: 0, admins: ['alice'], verification: true, problem: null };

/** A hub with the Agent at `version` and `Bob` online; `reply` answers the Agent's next request. */
async function moderationHub(t: TestContext, { version = 'agent-v1.4.0', unit = 'active' } = {}) {
  const h = await ready(t, { version, unit, players: unit === 'active' ? ['Bob'] : [] });
  const reply = async (data: object | { error: string }) => {
    const r = (await h.agent.next()) as { id: string; type: string } & Record<string, unknown>;
    h.agent.send({ type: 'reply', id: r.id, ...('error' in data ? { ok: false, error: data.error } : { ok: true, data }) });
    return r;
  };
  const get = () => h.req('GET', '/api/servers/space/moderation');
  const post = (body: object) => h.req('POST', '/api/servers/space/moderation', body);
  const audit = async () =>
    (await h.json<AuditLog>(h.req('GET', '/api/audit?server=space'))).entries.filter((e) => e.action.startsWith('player ')).map((e) => [e.actor, e.action, e.details]);
  return { ...h, reply, get, post, audit };
}

test('a request is checked field by field, naming the field and never the value', () => {
  assert.deepEqual(moderateRequest({ action: 'ban', player: 'x.y-z_1', reason: '  spam  ', extra: 1 }), { action: 'ban', player: 'x.y-z_1', reason: 'spam' });
  assert.deepEqual(moderateRequest({ action: 'kick', player: 'b', reason: ' ' }), { action: 'kick', player: 'b' });
  const bad: [object, RegExp][] = [
    [{ action: 'nuke', player: 'x' }, /^action:/],
    [{ action: 'ban', player: 'a b' }, /^player:/],
    [{ action: 'ban', player: 'x'.repeat(61) }, /^player:/],
    [{ action: 'promote', player: 'x', reason: 'r' }, /^reason: only a kick or a ban/],
    [{ action: 'ban', player: 'x', reason: 'two\nlines' }, /^reason:/],
    [{ action: 'ban', player: 'x', reason: 'a‮b' }, /^reason:/],
    [{ action: 'ban', player: 'x', reason: 'x'.repeat(201) }, /^reason:/],
    [{ action: 'ban', player: 'x', reason: 5 }, /^reason:/],
  ];
  for (const [body, why] of bad) {
    assert.throws(() => moderateRequest(body as Record<string, unknown>), (err: Error) => why.test(err.message) && !err.message.includes('two\nlines'), JSON.stringify(body));
  }
});

test('GET: who is on and the lists; two at once send one playerLists, a third within 2 s none; 404 for others', async (t) => {
  const h = await moderationHub(t);
  const both = Promise.all([h.json<ModerationState>(h.get()), h.json<ModerationState>(h.get())]);
  const asked = await h.reply(LISTS);
  assert.deepEqual(asked, { type: 'playerLists', id: asked.id });
  const [a, b] = await both;
  assert.deepEqual(a, { online: ['Bob'], lists: LISTS, blocked: null });
  assert.deepEqual(b, a);
  assert.deepEqual(await h.json<ModerationState>(h.get()), a);
  assert.equal((await h.req('GET', '/api/servers/gtnh/moderation')).status, 404);
  assert.equal((await h.req('POST', '/api/servers/gtnh/moderation', { action: 'ban', player: 'x' })).status, 404);
});

test('an Agent below the floor is blocked with the deploy text and never asked', async (t) => {
  const h = await moderationHub(t, { version: 'agent-v1.3.0' });
  const s = await h.json<ModerationState>(h.get());
  assert.equal(s.lists, null);
  assert.equal(s.blocked, "This server's Agent runs agent-v1.3.0, which can't moderate players. Deploy agent-v1.4.0 or later from the Host page (Releases).");
  const r = await h.post({ action: 'ban', player: 'x' });
  assert.equal(r.status, 409);
  assert.equal(h.got.filter((m) => m.type === 'playerLists' || m.type === 'moderate').length, 0);
});

test('a stopped server: the lists still come, actions are blocked', async (t) => {
  const h = await moderationHub(t, { unit: 'inactive' });
  const pending = h.json<ModerationState>(h.get());
  await h.reply(LISTS);
  const s = await pending;
  assert.deepEqual(s.lists, LISTS);
  assert.match(s.blocked ?? '', /is stopped: start it to kick, ban, unban or change admins here\.$/);
  assert.equal((await h.post({ action: 'unban', player: 'griefer_1' })).status, 409);
});

test('POST: exactly the request reaches the Agent, the answer and an audit row as the admin; a refusal is a 502', async (t) => {
  const h = await moderationHub(t);
  const res = h.post({ action: 'ban', player: 'griefer_2', reason: 'stealing iron', extra: 'x' });
  const sent = await h.reply({ outcome: 'done', lists: LISTS });
  assert.deepEqual(sent, { type: 'moderate', id: sent.id, action: 'ban', player: 'griefer_2', reason: 'stealing iron' });
  assert.deepEqual(await h.json<ModerateAnswer>(res), { outcome: 'done', lists: LISTS });
  const kick = h.post({ action: 'kick', player: 'Bob' });
  await h.reply({ outcome: 'notOnline', lists: LISTS });
  await h.json<ModerateAnswer>(kick);
  const refused = h.post({ action: 'promote', player: 'carol' });
  await h.reply({ error: "the server isn't running" });
  const r = await refused;
  assert.equal(r.status, 502);
  assert.equal(await r.text(), "the server isn't running");
  const old = h.post({ action: 'demote', player: 'carol' });
  await h.reply({ error: 'unknown type' });
  assert.equal(await (await old).text(), "Space Age's Agent can't moderate players (unknown type): deploy agent-v1.4.0 or later.");
  assert.deepEqual(await h.audit(), [
    [ACTOR, 'player demote', 'carol: failed: Space Age\'s Agent can\'t moderate players (unknown type): deploy agent-v1.4.0 or later.'],
    [ACTOR, 'player promote', "carol: failed: the server isn't running"],
    [ACTOR, 'player kick', 'Bob: not online'],
    [ACTOR, 'player ban', 'griefer_2 (reason: stealing iron): done'],
  ]);
});

test('POST: 400 before anything is sent, 409 while one runs, 429 past 20 a minute', async (t) => {
  const h = await moderationHub(t);
  const r400 = await h.post({ action: 'ban', player: 'a b' });
  assert.equal(r400.status, 400);
  assert.match(await r400.text(), /^player:/);
  const first = h.post({ action: 'ban', player: 'x' });
  const asked = (await h.agent.next()) as { id: string };
  const second = await h.post({ action: 'ban', player: 'y' });
  assert.equal(second.status, 409);
  assert.match(await second.text(), /already running/);
  h.agent.send({ type: 'reply', id: asked.id, ok: true, data: { outcome: 'done', lists: LISTS } });
  await first;
  for (let i = 0; i < 19; i++) {
    const p = h.post({ action: 'unban', player: `p${i}` });
    await h.reply({ outcome: 'already', lists: LISTS });
    await p;
  }
  const over = await h.post({ action: 'unban', player: 'p20' });
  assert.equal(over.status, 429);
});

test("the hub's reply check takes the lists at their limits and refuses past them", () => {
  const ban = { name: 'x'.repeat(60), reason: 'r'.repeat(200) };
  const full = { ...LISTS, bans: Array.from({ length: 500 }, () => ban), admins: Array.from({ length: 100 }, (_, i) => `a${i}`) };
  assert.ok(parseReplyData('playerLists', full));
  assert.ok(parseReplyData('moderate', { outcome: 'unconfirmed', lists: full }));
  assert.equal(parseReplyData('playerLists', { ...full, bans: [...full.bans, ban] }), null);
  assert.equal(parseReplyData('playerLists', { ...full, admins: [...full.admins, 'more'] }), null);
  assert.equal(parseReplyData('playerLists', { ...LISTS, bans: [{ name: 'a b', reason: null }] }), null);
  assert.equal(parseReplyData('playerLists', { ...LISTS, bans: [{ name: 'a', reason: 'r'.repeat(201) }] }), null);
  assert.equal(parseReplyData('moderate', { outcome: 'maybe', lists: LISTS }), null);
});

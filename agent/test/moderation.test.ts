import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseReplyData } from '../../hub/src/protocol.ts';
import { cleanReason, Moderation, parseBans } from '../src/moderation.ts';
import type { UnitState } from '../src/service.ts';
import { readAgentLine } from '../src/wire.ts';

const ACTIVE: UnitState = { unit: 'factorio.service', active: 'active', sub: 'running', since: 1, result: 'success' };
const status = (players: string[]) => JSON.stringify({ ok: true, tick: 1, tick_paused: false, players, version: '2.1.24', mods: { orrery: '1.0.0' } });

/**
 * A server's data folder and a fake Factorio on RCON: `/ban`, `/unban`, `/promote` and `/demote` rewrite its files as
 * Factorio does (names lowercased in the banlist, matching without case), `/kick` drops a player, `/orrery-status`
 * answers who is on. Every command is kept in `sent`.
 */
async function server(t: TestContext, { bans = [] as unknown[], admins = [] as string[], online = [] as string[], verification = true, follow = true } = {}) {
  const data = await mkdtemp(join(tmpdir(), 'agent-mod-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  await mkdir(join(data, 'config'));
  const banFile = join(data, 'server-banlist.json');
  const adminFile = join(data, 'config', 'server-adminlist.json');
  let banlist = [...bans];
  let adminlist = [...admins];
  const players = [...online];
  const write = () => Promise.all([writeFile(banFile, JSON.stringify(banlist)), writeFile(adminFile, JSON.stringify(adminlist))]);
  await write();
  await writeFile(join(data, 'config', 'server-settings.json'), JSON.stringify({ require_user_verification: verification }));
  const sent: string[] = [];
  const nameOf = (e: unknown) => (typeof e === 'string' ? e : (e as { username: string }).username);
  const run = async (command: string) => {
    sent.push(command);
    if (command === '/orrery-status') return status(players);
    const [verb, name, ...rest] = command.slice(1).split(' ');
    const key = name!.toLowerCase();
    if (!follow) return '';
    if (verb === 'ban' && !banlist.some((e) => nameOf(e).toLowerCase() === key)) banlist.push(rest.length ? { username: key, reason: rest.join(' ') } : key);
    if (verb === 'unban') banlist = banlist.filter((e) => nameOf(e).toLowerCase() !== key);
    if (verb === 'promote' && !adminlist.some((a) => a.toLowerCase() === key)) adminlist.push(name!);
    if (verb === 'demote') adminlist = adminlist.filter((a) => a.toLowerCase() !== key);
    if (verb === 'kick' || verb === 'ban') players.splice(players.findIndex((p) => p.toLowerCase() === key) >>> 0, 1);
    await write();
    return '';
  };
  let unit: UnitState | null = ACTIVE;
  let changed = 0;
  const moderation = new Moderation({
    data,
    run,
    players: () => online,
    unit: () => unit,
    verification: () => null,
    adminsChanged: () => void changed++,
    waitMs: 50,
    pollMs: 5,
  });
  return { data, moderation, sent, setUnit: (u: UnitState | null) => (unit = u), changed: () => changed };
}

const act = (m: Moderation, action: 'kick' | 'ban' | 'unban' | 'promote' | 'demote', player: string, reason?: string) =>
  m.act({ type: 'moderate', id: 'r1', action, player, ...(reason !== undefined && { reason }) });

test('cleanReason: one printable line of at most 200 characters, or none', () => {
  assert.equal(cleanReason('stealing\niron'), 'stealing iron');
  assert.equal(cleanReason(' a b‮c\td  e '), 'a b c d e');
  assert.equal(cleanReason('   '), null);
  assert.equal(cleanReason('x'.repeat(201))!.length, 200);
  const cutAtPair = cleanReason(`${'x'.repeat(199)}😀`)!;
  assert.equal(cutAtPair, 'x'.repeat(199), 'never half a surrogate pair');
});

test('parseBans: names and objects, the address never kept, bad names hidden, sorted, once each', () => {
  const parsed = parseBans(JSON.stringify(['noreason', { username: 'spacey', reason: 'spam\nlinks', address: '203.0.113.9' }, 'a b', { reason: 'x' }, 'NoReason', 'alpha']));
  assert.deepEqual(parsed, {
    bans: [
      { name: 'alpha', reason: null },
      { name: 'noreason', reason: null },
      { name: 'spacey', reason: 'spam links' },
    ],
    hidden: 2,
  });
  assert.ok(!JSON.stringify(parsed).includes('203.0.113'));
  assert.equal(parseBans('{"a":1}'), null);
  assert.equal(parseBans('not json'), null);
});

test('lists: bans cut to 500 with the total, admins, verification from the file, each file problem in fixed words', async (t) => {
  const many = Array.from({ length: 501 }, (_, i) => `p${String(i).padStart(3, '0')}`);
  const s = await server(t, { bans: many, admins: ['alice', 'bad name'], verification: false });
  const lists = await s.moderation.lists();
  assert.equal(lists.bans.length, 500);
  assert.equal(lists.bansTotal, 501);
  assert.deepEqual(lists.admins, ['alice']);
  assert.equal(lists.verification, false);
  assert.equal(lists.problem, null);
  assert.ok(parseReplyData('playerLists', lists), "the hub's own check takes it");
  await writeFile(join(s.data, 'server-banlist.json'), '{"not":"a list"}');
  await writeFile(join(s.data, 'config', 'server-adminlist.json'), Buffer.alloc(2 * 1024 * 1024, 0x20));
  const bad = await s.moderation.lists();
  assert.deepEqual([bad.bans, bad.admins], [[], []]);
  assert.equal(bad.problem, "server-banlist.json can't be read: not a JSON list. server-adminlist.json can't be read: larger than 1 MiB.");
});

test('a symlinked banlist is never read through, and a missing one is no bans', async (t) => {
  const s = await server(t);
  const elsewhere = join(s.data, 'elsewhere.json');
  await writeFile(elsewhere, JSON.stringify(['secret']));
  await rm(join(s.data, 'server-banlist.json'));
  assert.deepEqual((await s.moderation.lists()).bans, []);
  await symlink(elsewhere, join(s.data, 'server-banlist.json'));
  assert.deepEqual((await s.moderation.lists()).bans, []);
});

test('the exact commands, and each outcome from the files before and after', async (t) => {
  const s = await server(t, { bans: ['old'], admins: ['alice'], online: ['Bob'] });
  assert.equal((await act(s.moderation, 'ban', 'Griefer_1', 'stealing  iron\n')).outcome, 'done');
  assert.equal((await act(s.moderation, 'ban', 'x')).outcome, 'done');
  assert.equal((await act(s.moderation, 'ban', 'OLD', 'again')).outcome, 'already');
  assert.equal((await act(s.moderation, 'unban', 'GRIEFER_1')).outcome, 'done');
  assert.equal((await act(s.moderation, 'unban', 'nobody')).outcome, 'already');
  assert.equal((await act(s.moderation, 'promote', 'carol', 'ignored')).outcome, 'done');
  assert.equal((await act(s.moderation, 'promote', 'ALICE')).outcome, 'already');
  const demoted = await act(s.moderation, 'demote', 'alice');
  assert.equal(demoted.outcome, 'done');
  assert.deepEqual(demoted.lists.admins, ['carol']);
  assert.equal(s.changed(), 2, 'the settings pushed after each promote or demote that changed the file');
  assert.equal((await act(s.moderation, 'kick', 'bob', 'calm down')).outcome, 'done');
  assert.deepEqual(
    s.sent.filter((c) => c !== '/orrery-status'),
    ['/ban Griefer_1 stealing iron', '/ban x', '/ban OLD again', '/unban GRIEFER_1', '/unban nobody', '/promote carol', '/promote ALICE', '/demote alice', '/kick Bob calm down'],
  );
});

test('a kick of someone not on sends nothing after one fresh status; one who stays on is unconfirmed', async (t) => {
  const s = await server(t, { online: [] });
  assert.equal((await act(s.moderation, 'kick', 'ghost')).outcome, 'notOnline');
  assert.deepEqual(s.sent, ['/orrery-status']);
  const stays = await server(t, { online: ['Bob'], follow: false });
  assert.equal((await act(stays.moderation, 'kick', 'Bob')).outcome, 'unconfirmed');
  assert.equal((await act(stays.moderation, 'ban', 'eve')).outcome, 'unconfirmed');
});

test('refused while the unit is not active, a second while one runs, a bad name, and when RCON fails', async (t) => {
  const s = await server(t);
  s.setUnit({ ...ACTIVE, active: 'inactive', sub: 'dead' });
  await assert.rejects(act(s.moderation, 'ban', 'x'), /the server isn't running/);
  s.setUnit(ACTIVE);
  const first = act(s.moderation, 'ban', 'x');
  await assert.rejects(act(s.moderation, 'ban', 'y'), /a moderation request is running/);
  await first;
  await assert.rejects(act(s.moderation, 'ban', 'a b'), /not a player name/);
  const down = new Moderation({ data: s.data, run: async () => Promise.reject(new Error('ECONNREFUSED')), players: () => [], unit: () => ACTIVE, verification: () => null, adminsChanged: () => {} });
  await assert.rejects(act(down, 'ban', 'x'), /^Error: Factorio didn't answer$/);
  assert.ok(!s.sent.includes('/ban y') && !s.sent.includes('/ban a b'));
});

test('the log line names the action, the name and the outcome, never the reason', async (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => lines.push(a.join(' ')));
  const s = await server(t);
  await act(s.moderation, 'ban', 'griefer_1', 'a secret reason');
  assert.deepEqual(lines, ['[moderation] ban griefer_1: done']);
});

test('readAgentLine: playerLists and moderate by their rules', () => {
  const line = (o: object) => readAgentLine(JSON.stringify(o));
  assert.deepEqual(line({ type: 'playerLists', id: 'a' }), { msg: { type: 'playerLists', id: 'a' } });
  assert.deepEqual(line({ type: 'moderate', id: 'a', action: 'ban', player: 'x.y-z_1', reason: 'r', extra: 1 }), {
    msg: { type: 'moderate', id: 'a', action: 'ban', player: 'x.y-z_1', reason: 'r' },
  });
  for (const bad of [{ action: 'nuke' }, { player: 'x'.repeat(61) }, { player: 'a b' }, { reason: 'x'.repeat(201) }]) {
    assert.equal(line({ type: 'moderate', id: 'a', action: 'ban', player: 'x', ...bad }).msg, null, JSON.stringify(bad));
  }
});

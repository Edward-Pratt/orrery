import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AuditLog, GameSettingsRequest, GameSettingsState } from '../src/api.ts';
import { formatEvent, type Post } from '../src/format.ts';
import { auditDetails, settingsRequest } from '../src/game-settings.ts';
import type { GameSettingsReport, Notice } from '../src/types.ts';
import { agentUp, eventually, gameHub, PICK } from './fake-agent.ts';

const PASSWORD = 'Sesame-0pen!Xyzzy-7731';
const VALUES = {
  name: 'orrery Factorio',
  description: 'Our base',
  max_players: 0,
  game_password_set: true,
  require_user_verification: true,
  autosave_interval: 10,
  autosave_slots: 5,
  afk_autokick_interval: 0,
  auto_pause: true,
  auto_pause_when_players_connect: false,
  only_admins_can_pause_the_game: true,
  allow_commands: 'admins-only' as const,
};
const REPORT: GameSettingsReport = { settings: VALUES, admins: ['alice'], problem: null, pending: [], extra: ['tags'], rolledBack: null };
const { game_password_set: _, ...FIELDS } = VALUES;
const REQUEST: GameSettingsRequest = { ...FIELDS, admins: ['alice'] };

/** A Discord post's embed title. */
const titleOf = (p: Post | null) => (p && 'embeds' in p ? p.embeds[0]?.title : undefined);

/** What gets logged, for the password check. */
function captureConsole(t: TestContext): string[] {
  const lines: string[] = [];
  for (const m of ['log', 'error', 'warn', 'info'] as const) t.mock.method(console, m, (...args: unknown[]) => lines.push(args.map(String).join(' ')));
  return lines;
}

/** A hub with the Agent (at `version`) connected, its report pushed (unless `report` is null) and taken. */
async function settingsHub(t: TestContext, { version = 'agent-v1.2.0', unit = 'active', report = REPORT as GameSettingsReport | null } = {}) {
  const h = await gameHub(t);
  const a = await agentUp(h.agentPort, { version, unit });
  const settings = () => h.json<GameSettingsState>(h.req('GET', '/api/servers/space/settings'));
  const push = (r: GameSettingsReport) => a.agent.send({ type: 'settings', ...r });
  if (report) {
    push(report);
    await eventually(async () => (await settings()).settings !== null);
  } else await eventually(async () => (await settings()).blocked !== "The Agent isn't connected.");
  const put = (body: object) => h.req('PUT', '/api/servers/space/settings', body);
  /** The Agent's next request, answered with `data` (or refused with `error`). */
  const reply = async (data: object | { error: string }) => {
    const r = (await a.agent.next()) as { id: string; type: string } & Record<string, unknown>;
    a.agent.send({ type: 'reply', id: r.id, ...('error' in data ? { ok: false, error: data.error } : { ok: true, data }) });
    return r;
  };
  const audit = async () =>
    (await h.json<AuditLog>(h.req('GET', '/api/audit?server=space'))).entries.filter((e) => e.action.startsWith('game settings')).map((e) => [e.actor, e.action, e.details]);
  return { ...h, ...a, settings, push, put, reply, audit };
}

test('a save is checked field by field, each refusal naming the field and never the value', () => {
  assert.deepEqual(settingsRequest({ ...REQUEST, extra: 1, game_password: 'x!y' }), { ...REQUEST, game_password: 'x!y' }, 'unknown fields dropped');
  assert.equal(settingsRequest({ ...REQUEST, game_password: null }).game_password, null);
  assert.ok(!('game_password' in settingsRequest(REQUEST)), 'left out: kept');
  const bad: [string, unknown, RegExp][] = [
    ['name', '', /^name:/],
    ['name', 'x'.repeat(101), /^name:/],
    ['name', ' padded', /^name:/],
    ['name', 'two\nlines', /^name:/],
    ['description', 'x'.repeat(257), /^description:/],
    ['description', 'a\u2028b', /^description:/],
    ['max_players', 1001, /^max_players: a whole number from 0 to 1000/],
    ['max_players', -1, /^max_players:/],
    ['max_players', 1.5, /^max_players:/],
    ['autosave_interval', 1441, /^autosave_interval:/],
    ['autosave_slots', 0, /^autosave_slots:/],
    ['afk_autokick_interval', '5', /^afk_autokick_interval:/],
    ['auto_pause', 'yes', /^auto_pause:/],
    ['require_user_verification', undefined, /^require_user_verification:/],
    ['allow_commands', true, /^allow_commands:/],
    ['game_password', 'pass word', /^game_password:/],
    ['game_password', 'x'.repeat(65), /^game_password:/],
    ['game_password', 'pässword', /^game_password:/],
    ['admins', ['a b'], /^admins: each name/],
    ['admins', ['x'.repeat(61)], /^admins: each name/],
    ['admins', Array.from({ length: 101 }, (_, i) => `p${i}`), /^admins: a list of at most 100/],
    ['admins', ['Bob', 'bob'], /^admins: each name once/],
    ['admins', 'alice', /^admins:/],
  ];
  for (const [key, value, why] of bad) {
    assert.throws(
      () => settingsRequest({ ...REQUEST, [key]: value }),
      (err: Error & { status?: number }) => err.status === 400 && why.test(err.message) && (typeof value !== 'string' || value === '' || !err.message.includes(value)),
      `${key}: ${JSON.stringify(value)}`,
    );
  }
  assert.doesNotThrow(() => settingsRequest({ ...REQUEST, max_players: 1000, autosave_interval: 1440, name: 'x'.repeat(100), admins: Array.from({ length: 100 }, (_, i) => `p${i}`) }));
});

test('the audit names what changed, the password only as changed or removed, the admins as a diff', () => {
  const req = { ...REQUEST, name: 'Our base', max_players: 8, game_password: PASSWORD, admins: ['Alice', 'bob'] };
  assert.equal(auditDetails(req, REPORT), 'name: "orrery Factorio" → "Our base"; max_players: 0 → 8; game password changed; admins: +bob');
  assert.equal(auditDetails({ ...REQUEST, game_password: null, admins: [] }, REPORT), 'game password removed; admins: -alice');
  assert.equal(auditDetails(REQUEST, REPORT), 'no change');
  assert.equal(auditDetails({ ...REQUEST, admins: [] }, { ...REPORT, settings: null, admins: [] }).split('; ')[0], 'name: "orrery Factorio"', "an unreadable file: the new values only");
});

test('GET needs a session, is 404 for a Minecraft server, and gives the report the Agent pushed', async (t) => {
  const h = await settingsHub(t, { report: null });
  assert.equal((await h.app.request('/api/servers/space/settings')).status, 401);
  assert.equal((await h.req('GET', '/api/servers/gtnh/settings')).status, 404);
  assert.equal((await h.req('PUT', '/api/servers/gtnh/settings', REQUEST)).status, 404);
  assert.equal((await h.req('GET', '/api/servers/nope/settings')).status, 404);
  assert.deepEqual(await h.settings(), {
    settings: null,
    admins: [],
    problem: null,
    pending: [],
    extra: [],
    rolledBack: null,
    blocked: "Space Age's Agent hasn't reported its game settings yet.",
  });
  const card = (await h.json<{ id: string; features: { settings: boolean } }[]>(h.req('GET', '/api/servers'))).map((c) => [c.id, c.features.settings]);
  assert.deepEqual(card, [
    ['gtnh', false],
    ['space', true],
  ]);
  h.push(REPORT);
  await eventually(async () => (await h.settings()).settings !== null);
  assert.deepEqual(await h.settings(), { ...REPORT, blocked: null });
  const unreadable = { ...REPORT, settings: null, problem: 'Unexpected end of file' };
  h.push(unreadable);
  await eventually(async () => (await h.settings()).problem !== null);
  assert.deepEqual(await h.settings(), { ...unreadable, blocked: null });
});

test("an Agent below agent-v1.2.0 is blocked with the deploy text, and is never sent settingsSet", async (t) => {
  const h = await settingsHub(t, { version: 'agent-v1.1.1', report: null });
  const blocked = "This server's Agent runs agent-v1.1.1, which can't change game settings. Deploy agent-v1.2.0 or later from the Host page (Releases).";
  assert.equal((await h.settings()).blocked, blocked);
  const res = await h.put(REQUEST);
  assert.deepEqual([res.status, await res.text()], [409, blocked]);
  assert.ok(!h.got.some((m) => m.type === 'settingsSet'));
});

test('a save reaches the Agent as checked, answers what applied, and is audited without the password', async (t) => {
  const logged = captureConsole(t);
  const h = await settingsHub(t);
  const body = { ...REQUEST, name: 'Our base', max_players: 8, game_password: PASSWORD, admins: ['alice', 'bob'], extra: 'dropped', game_password_set: false };
  const res = h.put(body);
  const asked = await h.reply({ applied: ['name', 'max_players', 'game_password', 'admins'], pending: [] });
  const { id: _, ...sent } = asked;
  assert.deepEqual(sent, { type: 'settingsSet', settings: { ...FIELDS, name: 'Our base', max_players: 8 }, game_password: PASSWORD, admins: ['alice', 'bob'] });
  assert.deepEqual(Object.keys(sent).sort(), ['admins', 'game_password', 'settings', 'type']);
  assert.deepEqual(await h.json(res), { applied: ['name', 'max_players', 'game_password', 'admins'], pending: [] });
  assert.deepEqual(await h.audit(), [[`web:alex (${'5'.repeat(18)})`, 'game settings', 'name: "orrery Factorio" → "Our base"; max_players: 0 → 8; game password changed; admins: +bob']]);
  assert.ok(h.notices.some((n) => n.kind === 'settings'), 'the stream hears of it');

  // Left out: kept, so not sent; null: removed, sent as null.
  const kept = h.put(REQUEST);
  assert.ok(!('game_password' in (await h.reply({ applied: [], pending: [] }))));
  await h.json(kept);
  const removed = h.put({ ...REQUEST, game_password: null });
  assert.equal((await h.reply({ applied: ['game_password'], pending: [] })).game_password, null);
  await h.json(removed);

  // A refusal is the Agent's reason, as 502, and audited.
  const refused = h.put({ ...REQUEST, game_password: PASSWORD });
  await h.reply({ error: 'A game update is running.' });
  const r = await refused;
  assert.deepEqual([r.status, await r.text()], [502, 'A game update is running.']);
  assert.match((await h.audit())[0]![2]!, /game password changed \(refused: A game update is running\.\)$/);

  const everything = JSON.stringify([logged, await h.audit(), h.notices, await h.settings(), h.live.since(0)]);
  assert.ok(!everything.includes(PASSWORD), 'the password is in no log line, audit entry, event or answer');
});

test('verification off needs a password: one sent, or the file\'s kept; turning it off or on is announced', async (t) => {
  const h = await settingsHub(t, { report: { ...REPORT, settings: { ...VALUES, game_password_set: false } } });
  const off = { ...REQUEST, require_user_verification: false };
  for (const body of [off, { ...off, game_password: null }]) {
    const res = await h.put(body);
    assert.deepEqual([res.status, await res.text()], [400, 'Without the account check a game password is needed.']);
  }
  assert.ok(!h.got.some((m) => m.type === 'settingsSet'));
  const saved = h.put({ ...off, game_password: PASSWORD });
  await h.reply({ applied: ['require_user_verification', 'game_password'], pending: [] });
  await h.json(saved);
  const kinds = () => h.notices.filter((n) => n.kind !== 'settings');
  await eventually(() => kinds().length === 1);
  assert.deepEqual(kinds(), [{ kind: 'verificationOff', severity: 'warning', name: 'Space Age', by: 'alex' }]);

  // The file has a password now: left out, it is kept.
  h.push({ ...REPORT, settings: { ...VALUES, require_user_verification: false, game_password_set: true } });
  await eventually(async () => (await h.settings()).settings?.require_user_verification === false);
  const again = h.put(off);
  await h.reply({ applied: [], pending: [] });
  await h.json(again);
  const on = h.put(REQUEST);
  await h.reply({ applied: ['require_user_verification'], pending: [] });
  await h.json(on);
  await eventually(() => kinds().length === 2);
  assert.deepEqual(kinds()[1], { kind: 'verificationOn', severity: 'good', name: 'Space Age', by: 'alex' });

  const posted = kinds().map((n) => formatEvent({ type: 'notice', serverId: 'space', ...n } as never, 'factorio'));
  assert.deepEqual(
    posted.map(titleOf),
    ["⚠️ User verification is now off on Space Age (by alex): player names aren't checked.", '✅ User verification is on again on Space Age (by alex): player names are checked.'],
  );
  assert.equal(formatEvent({ type: 'notice', serverId: 'space', kind: 'settings', severity: 'info' }, 'factorio'), null);
});

test('a save is refused while a countdown, a game update or a start runs, and while another save is under way', async (t) => {
  const h = await settingsHub(t);
  // Another save under way.
  const first = h.put(REQUEST);
  await eventually(() => h.got.some((m) => m.type === 'settingsSet'));
  const second = await h.put(REQUEST);
  assert.deepEqual([second.status, await second.text()], [409, "A save of Space Age's game settings is under way."]);
  await h.reply({ applied: [], pending: [] });
  await h.json(first);

  assert.equal((await h.req('POST', '/api/servers/space/restart', { minutes: 5 })).status, 204);
  const blocked = 'A countdown is running on Space Age: cancel it first.';
  assert.equal((await h.settings()).blocked, blocked);
  const res = await h.put(REQUEST);
  assert.deepEqual([res.status, await res.text()], [409, blocked]);
  await h.req('POST', '/api/servers/space/restart/cancel', {});
  assert.equal((await h.settings()).blocked, null);

  h.agent.send({ type: 'serviceState', unit: 'factorio.service', active: 'activating', sub: 'start', since: 2, result: 'success' });
  await eventually(async () => (await h.settings()).blocked === 'The server is starting or stopping: try again in a minute.');
  h.agent.send({ type: 'serviceState', unit: 'factorio.service', active: 'active', sub: 'running', since: 3, result: 'success' });
  await eventually(async () => (await h.settings()).blocked === null);

  await h.json(h.req('POST', '/api/servers/space/game/update', PICK), 202);
  assert.equal((await h.settings()).blocked, 'A game update is running on Space Age.');
  assert.equal((await h.put(REQUEST)).status, 409);
});

test('a stopped server takes a save; with its Agent gone the last report stays, read-only', async (t) => {
  const h = await settingsHub(t, { unit: 'inactive' });
  const saved = h.put({ ...REQUEST, auto_pause: false });
  await h.reply({ applied: ['admins'], pending: ['auto_pause'] });
  assert.deepEqual(await h.json(saved), { applied: ['admins'], pending: ['auto_pause'] });
  h.agent.socket.destroy();
  await eventually(async () => (await h.settings()).blocked === "The Agent isn't connected.");
  assert.deepEqual((await h.settings()).settings, VALUES);
});

test("a rollback the Agent reports is audited as hub:agent and announced once; the stream keeps only the latest settings notice", async (t) => {
  const h = await settingsHub(t);
  const why = 'The server failed to start (Value (-1) outside of range): back to the settings of its last good start.';
  h.push({ ...REPORT, rolledBack: why });
  await eventually(() => h.notices.some((n) => n.kind === 'settingsRolledBack'));
  // The same report again (as on a reconnect) is neither audited nor announced again.
  h.push({ ...REPORT, rolledBack: why, pending: ['auto_pause'] });
  await eventually(async () => (await h.settings()).pending.length === 1);
  assert.deepEqual(
    h.notices.filter((n): n is Extract<Notice, { kind: 'settingsRolledBack' }> => n.kind === 'settingsRolledBack'),
    [{ kind: 'settingsRolledBack', severity: 'problem', name: 'Space Age' }],
  );
  assert.deepEqual(await h.audit(), [['hub:agent', 'game settings rollback', why]]);
  const post = formatEvent({ type: 'notice', serverId: 'space', kind: 'settingsRolledBack', severity: 'problem', name: 'Space Age' }, 'factorio');
  assert.equal(titleOf(post), "❌ Space Age didn't start with its new settings: the Agent put back the previous ones.");
  const replayed = h.live.since(0).filter(([, e]) => 'serverId' in e && e.type === 'notice' && e.kind === 'settings');
  assert.equal(replayed.length, 1, 'only the latest settings notice is replayed');
  assert.ok(h.notices.filter((n) => n.kind === 'settings').length >= 3);
});

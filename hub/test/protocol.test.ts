import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GAME_SETTINGS, LIMITS, parseAgentLine, parseModLine, parseReplyData } from '../src/protocol.ts';

test('parses valid messages', () => {
  assert.deepEqual(parseModLine('{"type":"chat","player":"Steve","message":"hi"}'), {
    type: 'chat',
    player: 'Steve',
    message: 'hi',
  });
  assert.deepEqual(parseModLine('{"type":"started"}'), { type: 'started' });
  assert.deepEqual(parseModLine('{"type":"heartbeat","tps":19.9,"players":["a","b"]}'), {
    type: 'heartbeat',
    tps: 19.9,
    players: ['a', 'b'],
  });
});

test('rejects malformed JSON and non-objects', () => {
  for (const line of ['', 'not json', 'null', '42', '"chat"', '[]']) assert.equal(parseModLine(line), null, line);
});

test('rejects unknown types, including Object.prototype keys', () => {
  for (const type of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(parseModLine(JSON.stringify({ type })), null, type);
  }
});

test('rejects wrong field types', () => {
  assert.equal(parseModLine('{"type":"chat","player":"Steve","message":42}'), null);
  assert.equal(parseModLine('{"type":"chat","player":"Steve"}'), null);
  assert.equal(parseModLine('{"type":"heartbeat","tps":"20","players":[]}'), null);
  assert.equal(parseModLine('{"type":"heartbeat","tps":20,"players":["a",1]}'), null);
  assert.equal(parseModLine('{"type":"cmdResult","id":"x","output":"not an array"}'), null);
});

test('heartbeat dims are optional but validated', () => {
  assert.ok(parseModLine('{"type":"heartbeat","tps":20,"players":[]}'));
  const dims = [{ id: 0, name: 'Overworld', ms: 12.5 }];
  assert.deepEqual(parseModLine(JSON.stringify({ type: 'heartbeat', tps: 20, players: [], dims })), {
    type: 'heartbeat',
    tps: 20,
    players: [],
    dims,
  });
  const six = Array(6).fill(dims[0]);
  assert.equal(parseModLine(JSON.stringify({ type: 'heartbeat', tps: 20, players: [], dims: six })), null);
  assert.equal(parseModLine(JSON.stringify({ type: 'heartbeat', tps: 20, players: [], dims: [{ id: 0, name: '', ms: 1 }] })), null);
  assert.equal(parseModLine(JSON.stringify({ type: 'heartbeat', tps: 20, players: [], dims: 'x' })), null);
});

test('v1.2b messages validate every field', () => {
  assert.ok(parseModLine('{"type":"quest","player":"Steve","quests":[{"name":"Stone Age","main":true}]}'));
  assert.equal(parseModLine('{"type":"quest","player":"Steve","quests":[]}'), null);
  assert.equal(parseModLine('{"type":"quest","player":"Steve","quests":[{"name":"x","main":"yes"}]}'), null);
  assert.ok(parseModLine('{"type":"link","player":"Steve","uuid":"u","code":"ABC234"}'));
  assert.equal(parseModLine('{"type":"link","player":"Steve","code":"ABC234"}'), null);
  assert.ok(parseModLine('{"type":"unlink","player":"Steve"}'));
  assert.ok(parseModLine('{"type":"backup","ok":false,"detail":"disk full"}'));
  assert.equal(parseModLine('{"type":"backup","ok":"false","detail":"x"}'), null);
  assert.ok(parseModLine('{"type":"cmdLate","id":"1","output":["a"]}'));
  assert.deepEqual(parseModLine('{"type":"unlink","player":"Steve","extra":1}'), { type: 'unlink', player: 'Steve' }); // extra fields are dropped
});

test('the Mod port keeps parsing what the Mod and the tests send', () => {
  const lines = [
    { type: 'hello', protocol: 1, serverId: 'gtnh', token: 'test-token-0123456', modVersion: '2.6.0' },
    { type: 'heartbeat', tps: 18, players: ['Steve', 'Alex'], dims: [{ id: -1, name: 'Nether', ms: 60 }] },
    { type: 'chat', player: 'Steve', message: 'hi' },
    { type: 'death', player: 'Steve', message: 'Steve fell from a high place' },
    { type: 'achievement', player: 'Steve', achievement: 'Taking Inventory' },
    { type: 'cmdResult', id: '1', output: ['There are 0/20 players online:'] },
    { type: 'cmdLate', id: '1', output: ['https://spark.lucko.me/abc'] },
    { type: 'quest', player: 'Steve', quests: [{ name: 'Stone Age', main: true }] },
    { type: 'link', player: 'Steve', uuid: 'u-1', code: 'ABC234' },
    { type: 'backup', ok: true, detail: 'Backup done in 1 s' },
  ];
  for (const msg of lines) assert.deepEqual(parseModLine(JSON.stringify(msg)), msg, msg.type);
});

test('parsed messages hold only their schema fields, nested ones too', () => {
  assert.deepEqual(parseModLine('{"type":"chat","player":"Steve","message":"hi","serverId":"other","stopping":true}'), {
    type: 'chat',
    player: 'Steve',
    message: 'hi',
  });
  const heartbeat = parseModLine(
    JSON.stringify({ type: 'heartbeat', tps: 20, players: [], dims: [{ id: 0, name: 'Overworld', ms: 1, extra: 'x' }], extra: 1 }),
  );
  assert.deepEqual(heartbeat, { type: 'heartbeat', tps: 20, players: [], dims: [{ id: 0, name: 'Overworld', ms: 1 }] });
  const quest = parseModLine('{"type":"quest","player":"S","quests":[{"name":"x","main":true,"by":"y"}]}');
  assert.deepEqual(quest, { type: 'quest', player: 'S', quests: [{ name: 'x', main: true }] });
  const proto = parseModLine('{"type":"unlink","player":"Steve","__proto__":{"polluted":true}}')!;
  assert.deepEqual(Object.keys(proto), ['type', 'player']);
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  const sample = parseAgentLine(
    JSON.stringify({
      type: 'hostSample',
      sample: { ts: 1, cpu: 0.5, load: [1, 2, 3], memory: { used: 1, total: 2, swap: 3 }, disks: [{ mount: '/', free: 1, total: 2, dev: 'x' }], extra: 1 },
    }),
  );
  assert.deepEqual(sample, { type: 'hostSample', sample: { ts: 1, cpu: 0.5, load: [1, 2, 3], memory: { used: 1, total: 2 }, disks: [{ mount: '/', free: 1, total: 2 }] } });
  const saves = parseAgentLine('{"type":"saves","saves":[{"name":"a.zip","size":1,"mtime":2,"kind":"auto","current":false,"path":"/etc"}],"free":3}');
  assert.deepEqual(saves, { type: 'saves', saves: [{ name: 'a.zip', size: 1, mtime: 2, kind: 'auto', current: false }], free: 3 });
});

test('a game connection may send milestones and a paused heartbeat', () => {
  assert.deepEqual(parseModLine('{"type":"heartbeat","tps":0,"players":[],"paused":true}'), { type: 'heartbeat', tps: 0, players: [], paused: true });
  assert.equal(parseModLine('{"type":"heartbeat","tps":0,"players":[],"paused":"yes"}'), null);
  for (const kind of ['research', 'rocket', 'platform', 'landing']) {
    assert.ok(parseModLine(JSON.stringify({ type: 'milestone', kind, text: 'x' })), kind);
  }
  const landing = { type: 'milestone', kind: 'landing', text: 'First landing on Vulcanus', player: 'Ann', force: 'player' };
  assert.deepEqual(parseModLine(JSON.stringify(landing)), landing);
  assert.equal(parseModLine('{"type":"milestone","kind":"boss","text":"x"}'), null);
  assert.equal(parseModLine('{"type":"milestone","kind":"rocket"}'), null);
  assert.equal(parseModLine('{"type":"milestone","kind":"rocket","text":"x","player":1}'), null);
  assert.equal(parseModLine('{"type":"agentHello","protocol":1,"agentId":"vm","token":"t","agentVersion":"1"}'), null); // Agent port only
});

const AGENT_MSGS = {
  agentHello: { type: 'agentHello', protocol: 1, agentId: 'factorio-vm', token: 'an-agent-token-of-at-least-32-chars', agentVersion: '1.0.0' },
  hello: { type: 'hello', protocol: 1, serverId: 'space', token: 'an-agent-token-of-at-least-32-chars', modVersion: '1.0.0' },
  ping: { type: 'ping' },
  bye: { type: 'bye' },
  hostSample: { type: 'hostSample', sample: { ts: 1, cpu: 0.25, load: [0.5, 0.4, 0.3], memory: { used: 1, total: 4 }, disks: [{ mount: '/', free: 2, total: 8 }] } },
  serviceState: { type: 'serviceState', unit: 'factorio.service', active: 'active', sub: 'running', since: 1700000000000, result: 'success' },
  saves: { type: 'saves', saves: [{ name: 'orrery-20261031T120000Z.zip', size: 1024, mtime: 1700000000000, kind: 'named', current: false }], free: 5e9 },
  installed: { type: 'installed', factorio: '2.1.24', mods: [{ name: 'base', version: '2.1.24' }, { name: 'orrery', version: '1.0.0' }] },
  updateStep: { type: 'updateStep', id: '7', step: 'prepare', state: 'running', detail: 'Downloading 2 mods' },
  updateDone: { type: 'updateDone', id: '7', outcome: 'rolled back', from: '2.1.24 · 5 mods', to: '2.1.25 · 5 mods', backup: 'orrery-pre-update-2.1.24-x.zip' },
  deployResult: { type: 'deployResult', tag: 'agent-v1.0.1', outcome: 'ok', log: 'flipped current\nconnected' },
  events: { type: 'events', on: false, reason: 'Factorio could not open its Lua UDP socket (is 127.0.0.1:34198 taken?)' },
  settings: {
    type: 'settings',
    settings: {
      name: 'orrery Factorio',
      description: 'Our base, on a friend\'s VM',
      max_players: 0,
      game_password_set: true,
      require_user_verification: false,
      autosave_interval: 10,
      autosave_slots: 5,
      afk_autokick_interval: 0,
      auto_pause: true,
      auto_pause_when_players_connect: false,
      only_admins_can_pause_the_game: true,
      allow_commands: 'admins-only',
    },
    admins: ['alice', 'Bob.the-2nd_'],
    problem: null,
    pending: ['auto_pause'],
    extra: ['tags', 'max_upload_slots'],
    rolledBack: null,
  },
  reply: { type: 'reply', id: '3', ok: true, data: { lines: ['a', 'b'] } },
};

test('every Agent port message parses, and only on the Agent port', () => {
  for (const [type, msg] of Object.entries(AGENT_MSGS)) {
    assert.deepEqual(parseAgentLine(JSON.stringify(msg)), msg, type);
    if (type !== 'hello') assert.equal(parseModLine(JSON.stringify(msg)), null, type);
  }
  assert.deepEqual(parseAgentLine('{"type":"reply","id":"4","ok":false,"error":"no such save"}'), { type: 'reply', id: '4', ok: false, error: 'no such save' });
  assert.deepEqual(parseAgentLine('{"type":"updateDone","id":"7","outcome":"ok","from":"a","to":"b"}'), { type: 'updateDone', id: '7', outcome: 'ok', from: 'a', to: 'b' });
  assert.deepEqual(parseAgentLine('{"type":"events","on":true}'), { type: 'events', on: true });
  const unreadable = { type: 'settings', settings: null, admins: [], problem: 'Unexpected end of file', pending: [], extra: [], rolledBack: 'x' };
  assert.deepEqual(parseAgentLine(JSON.stringify(unreadable)), unreadable, "a file that can't be read");
  // Game connection messages go through parseModLine once a game hello is accepted.
  assert.equal(parseAgentLine('{"type":"chat","player":"Ann","message":"hi"}'), null);
  for (const line of ['', 'not json', 'null', '[]', '{"type":"constructor"}', '{"type":"__proto__"}']) assert.equal(parseAgentLine(line), null, line);
});

test('Agent port messages check their field types and values', () => {
  const bad: [keyof typeof AGENT_MSGS, object][] = [
    ['agentHello', { protocol: '1' }],
    ['agentHello', { token: 32 }],
    ['hostSample', { sample: { ts: 1, cpu: 0, load: [], memory: { used: 1 }, disks: [] } }],
    ['hostSample', { sample: 'x' }],
    ['serviceState', { since: '1700000000000' }],
    ['saves', { saves: [{ name: 'a.zip', size: 1, mtime: 2, kind: 'manual', current: false }] }],
    ['saves', { saves: [{ name: 'a.zip', size: 1, mtime: 2, kind: 'auto', current: 'yes' }] }],
    ['saves', { free: null }],
    ['installed', { mods: [{ name: 'base' }] }],
    ['updateStep', { step: 'deploy' }],
    ['updateStep', { state: 'paused' }],
    ['updateDone', { outcome: 'running' }],
    ['updateDone', { backup: 1 }],
    ['deployResult', { outcome: 'running' }],
    ['events', { on: 'false' }],
    ['events', { reason: 1 }],
    ['reply', { ok: 'true' }],
    ['reply', { error: 1 }],
    ...([
      ['name', ''],
      ['name', ' padded'],
      ['name', 'two\nlines'],
      ['name', 'tab\there'],
      ['name', 'c1\u0085'],
      ['name', 'sep\u2028'],
      ['description', 'two\nlines'],
      ['description', 1],
      ['max_players', -1],
      ['max_players', 1001],
      ['max_players', 1.5],
      ['max_players', '8'],
      ['autosave_interval', 1441],
      ['autosave_slots', 0],
      ['autosave_slots', 101],
      ['afk_autokick_interval', 1441],
      ['auto_pause', 'yes'],
      ['game_password_set', 1],
      ['require_user_verification', null],
      ['allow_commands', 'maybe'],
      ['allow_commands', true],
    ] as const).map(([key, value]) => ['settings', { settings: { ...AGENT_MSGS.settings.settings, [key]: value } }] as [keyof typeof AGENT_MSGS, object]),
    ['settings', { settings: (({ auto_pause: _, ...rest }) => rest)(AGENT_MSGS.settings.settings) }],
    ['settings', { settings: 'x' }],
    ['settings', { admins: ['a b'] }],
    ['settings', { admins: ['x'.repeat(61)] }],
    ['settings', { admins: [''] }],
    ['settings', { problem: 1 }],
    ['settings', { pending: ['Auto_Pause'] }],
    ['settings', { extra: ['max-players'] }],
    ['settings', { extra: [''] }],
    ['settings', { rolledBack: false }],
    ['settings', { admins: undefined }],
  ];
  for (const [type, change] of bad) {
    assert.equal(parseAgentLine(JSON.stringify({ ...AGENT_MSGS[type], ...change })), null, `${type} ${JSON.stringify(change)}`);
  }
});

const hello = { type: 'hello', protocol: 1, serverId: 'gtnh', token: 'test-token-0123456', modVersion: '2.6.0' };

/** Sets one field (by its path) of a copy of `msg`. */
function withField(msg: object, path: (string | number)[], value: unknown): string {
  const copy = structuredClone(msg) as Record<string | number, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  at[path.at(-1)!] = value;
  return JSON.stringify(copy);
}

test('every field has a limit, on both ports: at it parses, over it the message is invalid', () => {
  const x = (n: number) => 'x'.repeat(n);
  // A command's `output` and a `backup`'s `detail` are cut instead (the next test).
  const game: [object, (string | number)[], number][] = [
    [hello, ['serverId'], LIMITS.text],
    [hello, ['token'], LIMITS.text],
    [hello, ['modVersion'], LIMITS.text],
    [{ type: 'chat', player: 'a', message: 'b' }, ['player'], LIMITS.player],
    [{ type: 'chat', player: 'a', message: 'b' }, ['message'], LIMITS.message],
    [{ type: 'join', player: 'a' }, ['player'], LIMITS.player],
    [{ type: 'leave', player: 'a' }, ['player'], LIMITS.player],
    [{ type: 'death', player: 'a', message: 'b' }, ['message'], LIMITS.message],
    [{ type: 'achievement', player: 'a', achievement: 'b' }, ['achievement'], LIMITS.text],
    [{ type: 'heartbeat', tps: 20, players: ['a'] }, ['players', 0], LIMITS.player],
    [{ type: 'heartbeat', tps: 20, players: [], dims: [{ id: 0, name: 'a', ms: 1 }] }, ['dims', 0, 'name'], LIMITS.text],
    [{ type: 'cmdResult', id: '1', output: ['a'] }, ['id'], LIMITS.text],
    [{ type: 'quest', player: 'a', quests: [{ name: 'q', main: true }] }, ['quests', 0, 'name'], LIMITS.text],
    [{ type: 'link', player: 'a', uuid: '', code: 'ABC234' }, ['uuid'], LIMITS.text],
    [{ type: 'link', player: 'a', uuid: '', code: 'ABC234' }, ['code'], LIMITS.text],
    [{ type: 'unlink', player: 'a' }, ['player'], LIMITS.player],
    [{ type: 'milestone', kind: 'research', text: 't', player: 'p', force: 'f' }, ['text'], LIMITS.message],
    [{ type: 'milestone', kind: 'research', text: 't', player: 'p', force: 'f' }, ['player'], LIMITS.player],
    [{ type: 'milestone', kind: 'research', text: 't', player: 'p', force: 'f' }, ['force'], LIMITS.player],
  ];
  const agent: [object, (string | number)[], number][] = [
    [AGENT_MSGS.agentHello, ['agentId'], LIMITS.text],
    [AGENT_MSGS.agentHello, ['token'], LIMITS.text],
    [AGENT_MSGS.agentHello, ['agentVersion'], LIMITS.text],
    [AGENT_MSGS.hello, ['token'], LIMITS.text],
    [AGENT_MSGS.hostSample, ['sample', 'disks', 0, 'mount'], LIMITS.text],
    ...(['unit', 'active', 'sub', 'result'] as const).map((f) => [AGENT_MSGS.serviceState, [f], LIMITS.text] as [object, string[], number]),
    [AGENT_MSGS.saves, ['saves', 0, 'name'], LIMITS.text],
    [AGENT_MSGS.installed, ['factorio'], LIMITS.text],
    [AGENT_MSGS.installed, ['mods', 0, 'name'], LIMITS.text],
    [AGENT_MSGS.installed, ['mods', 0, 'version'], LIMITS.text],
    [AGENT_MSGS.updateStep, ['id'], LIMITS.text],
    [AGENT_MSGS.updateStep, ['detail'], LIMITS.detail],
    ...(['id', 'from', 'to', 'backup'] as const).map((f) => [AGENT_MSGS.updateDone, [f], LIMITS.text] as [object, string[], number]),
    [AGENT_MSGS.deployResult, ['tag'], LIMITS.text],
    [AGENT_MSGS.deployResult, ['log'], LIMITS.deployLog],
    [AGENT_MSGS.events, ['reason'], LIMITS.detail],
    [AGENT_MSGS.reply, ['id'], LIMITS.text],
    [{ type: 'reply', id: '1', ok: false, error: 'e' }, ['error'], LIMITS.detail],
    [AGENT_MSGS.settings, ['settings', 'name'], LIMITS.serverName],
    [AGENT_MSGS.settings, ['settings', 'description'], LIMITS.text],
    [AGENT_MSGS.settings, ['admins', 0], 60],
    [AGENT_MSGS.settings, ['problem'], LIMITS.detail],
    [AGENT_MSGS.settings, ['rolledBack'], LIMITS.detail],
    [AGENT_MSGS.settings, ['pending', 0], 64],
    [AGENT_MSGS.settings, ['extra', 0], 64],
  ];
  for (const [parse, cases] of [[parseModLine, game], [parseAgentLine, agent]] as const) {
    for (const [msg, path, max] of cases) {
      const what = `${(msg as { type: string }).type}.${path.join('.')}`;
      // A settings key is lower case and `_` only.
      const fill = (n: number) => ((msg as { type: string }).type === 'settings' && ['pending', 'extra'].includes(String(path[0])) ? '_' : 'x').repeat(n);
      assert.ok(parse(withField(msg, path, fill(max))), `${what} at ${max}`);
      assert.equal(parse(withField(msg, path, fill(max + 1))), null, `${what} over ${max}`);
    }
  }
  // Lists, by their entries.
  const lists: [typeof parseModLine | typeof parseAgentLine, object, (string | number)[], unknown, number][] = [
    [parseModLine, { type: 'heartbeat', tps: 20, players: [] }, ['players'], 'p', LIMITS.players],
    [parseModLine, { type: 'heartbeat', tps: 20, players: [] }, ['dims'], { id: 0, name: 'd', ms: 1 }, 5],
    [parseModLine, { type: 'quest', player: 'a', quests: [] }, ['quests'], { name: 'q', main: false }, 50],
    [parseAgentLine, AGENT_MSGS.hostSample, ['sample', 'load'], 1, 3],
    [parseAgentLine, AGENT_MSGS.hostSample, ['sample', 'disks'], { mount: '/', free: 1, total: 2 }, LIMITS.disks],
    [parseAgentLine, AGENT_MSGS.saves, ['saves'], AGENT_MSGS.saves.saves[0], LIMITS.saves],
    [parseAgentLine, AGENT_MSGS.installed, ['mods'], { name: 'm', version: '1.0.0' }, LIMITS.mods],
    [parseAgentLine, AGENT_MSGS.settings, ['admins'], 'alice', LIMITS.admins],
    [parseAgentLine, AGENT_MSGS.settings, ['pending'], 'auto_pause', LIMITS.pending],
    [parseAgentLine, AGENT_MSGS.settings, ['extra'], 'tags', LIMITS.extra],
  ];
  for (const [parse, msg, path, item, max] of lists) {
    const what = `${(msg as { type: string }).type}.${path.join('.')}`;
    assert.ok(parse(withField(msg, path, Array(max).fill(item))), `${what} at ${max}`);
    assert.equal(parse(withField(msg, path, Array(max + 1).fill(item))), null, `${what} over ${max}`);
  }
  // A reply's data, by its size as JSON.
  const data = (n: number) => JSON.stringify({ type: 'reply', id: '1', ok: true, data: x(n - 2) }); // the quotes count
  assert.ok(parseAgentLine(data(LIMITS.replyData)));
  assert.equal(parseAgentLine(data(LIMITS.replyData + 1)), null);
});

test("a command's output and a backup's detail are cut to their limits, not refused: Mods already deployed send more", () => {
  const long = 'y'.repeat(5000);
  const lines = Array.from({ length: 2000 }, (_, i) => (i === 3 ? long : `line ${i}`));
  // A game connection's lines, a Mod's or an Agent's, all go through parseModLine.
  for (const type of ['cmdResult', 'cmdLate']) {
    const msg = parseModLine(JSON.stringify({ type, id: '1', output: lines })) as { output: string[] } | null;
    assert.ok(msg, type);
    assert.equal(msg.output.length, LIMITS.output);
    assert.equal(msg.output[3], long.slice(0, LIMITS.line));
    assert.equal(msg.output[LIMITS.output - 1], `line ${LIMITS.output - 1}`);
  }
  assert.deepEqual(parseModLine(JSON.stringify({ type: 'backup', ok: false, detail: 'z'.repeat(3000) })), {
    type: 'backup',
    ok: false,
    detail: 'z'.repeat(LIMITS.detail),
  });
  // Still typed: a non-string line, or a detail that isn't a string, refuses the message.
  assert.equal(parseModLine(JSON.stringify({ type: 'cmdResult', id: '1', output: ['a', 1] })), null);
  assert.equal(parseModLine(JSON.stringify({ type: 'backup', ok: true, detail: 1 })), null);
});

test("a reply's data is checked against its request, and copied", () => {
  assert.deepEqual(parseReplyData('journal', { lines: ['a', 'b'] }), { lines: ['a', 'b'] });
  assert.deepEqual(parseReplyData('log', { lines: ['a'], path: '/etc/shadow' }), { lines: ['a'] });
  const file = { name: 'factorio-current.log', size: 10, modified: 1700000000000 };
  assert.deepEqual(parseReplyData('logs', { files: [{ ...file, path: '/x' }] }), { files: [file] });
  for (const request of ['journal', 'log'] as const) {
    assert.ok(parseReplyData(request, { lines: Array(LIMITS.logLines).fill('x'.repeat(LIMITS.line)) }), request);
    assert.equal(parseReplyData(request, { lines: Array(LIMITS.logLines + 1).fill('x') }), null, request);
    assert.equal(parseReplyData(request, { lines: ['x'.repeat(LIMITS.line + 1)] }), null, request);
    assert.equal(parseReplyData(request, { lines: [1] }), null, request);
    assert.equal(parseReplyData(request, undefined), null, request);
  }
  assert.equal(parseReplyData('logs', { files: Array(LIMITS.logFiles + 1).fill(file) }), null);
  assert.equal(parseReplyData('logs', { files: [{ ...file, size: '10' }] }), null);
  assert.equal(parseReplyData('logs', ['factorio-current.log']), null);

  assert.deepEqual(parseReplyData('settingsSet', { applied: ['name', 'max_players'], pending: ['auto_pause'], password: 'x' }), {
    applied: ['name', 'max_players'],
    pending: ['auto_pause'],
  });
  assert.ok(parseReplyData('settingsSet', { applied: Array(LIMITS.pending).fill('name'), pending: Array(LIMITS.pending).fill('auto_pause') }));
  for (const bad of [
    { applied: Array(LIMITS.pending + 1).fill('name'), pending: [] },
    { applied: [], pending: Array(LIMITS.pending + 1).fill('auto_pause') },
    { applied: ['max-players'], pending: [] },
    { applied: [] },
    { applied: [1], pending: [] },
  ]) {
    assert.equal(parseReplyData('settingsSet', bad), null, JSON.stringify(bad).slice(0, 80));
  }
});

test("game settings take each rule's edges: the integer ranges, the name's length, any printable text, the admins' names", () => {
  const at = (change: object) => parseAgentLine(JSON.stringify({ ...AGENT_MSGS.settings, settings: { ...AGENT_MSGS.settings.settings, ...change } }));
  for (const [key, [min, max]] of Object.entries(GAME_SETTINGS.ranges)) {
    assert.ok(at({ [key]: min }), `${key} ${min}`);
    assert.ok(at({ [key]: max }), `${key} ${max}`);
    assert.equal(at({ [key]: min - 1 }), null, `${key} ${min - 1}`);
    assert.equal(at({ [key]: max + 1 }), null, `${key} ${max + 1}`);
  }
  assert.deepEqual(GAME_SETTINGS.ranges, { max_players: [0, 1000], autosave_interval: [0, 1440], autosave_slots: [1, 100], afk_autokick_interval: [0, 1440] });
  assert.ok(at({ name: 'Ünïcode "quoted" 😀 base', description: '' }), 'UTF-8, quotes and spaces; an empty description');
  for (const allow of ['true', 'false', 'admins-only']) assert.ok(at({ allow_commands: allow }), allow);
  const admins = (list: string[]) => parseAgentLine(JSON.stringify({ ...AGENT_MSGS.settings, admins: list }));
  assert.ok(admins(['A', 'x'.repeat(60), 'a_b.c-d', '0']));
  for (const name of ['a b', 'é', 'a/b', 'a\u0000', 'x'.repeat(61)]) assert.equal(admins([name]), null, name);
  // The password rule, for the hub's checks and the Agent's: printable ASCII, no space, 1 to 64.
  for (const ok of ['a', '!~', 'x'.repeat(64)]) assert.ok(GAME_SETTINGS.password.test(ok), ok);
  for (const bad of ['', 'pass word', 'é', 'tab\t', 'x'.repeat(65), 'del\u007f']) assert.ok(!GAME_SETTINGS.password.test(bad), JSON.stringify(bad));
  // Fields the schema doesn't hold are dropped: a username, a token, a password sent back by mistake.
  const sent = parseAgentLine(JSON.stringify({ ...AGENT_MSGS.settings, settings: { ...AGENT_MSGS.settings.settings, game_password: 'secret', token: 't' }, username: 'u' }));
  assert.deepEqual(sent, AGENT_MSGS.settings);
});

test("a reply's data too deeply nested to serialise is refused, not thrown", (t) => {
  t.mock.method(JSON, 'stringify', () => {
    throw new RangeError('Maximum call stack size exceeded'); // what an older V8 does on deep nesting
  });
  assert.equal(parseAgentLine('{"type":"reply","id":"x","ok":true,"data":[[[1]]]}'), null);
});

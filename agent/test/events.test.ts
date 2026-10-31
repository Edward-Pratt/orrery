import assert from 'node:assert/strict';
import { createSocket, type Socket } from 'node:dgram';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseModLine } from '../../hub/src/protocol.ts';
import {
  GameEvents,
  MAX_DATAGRAM,
  commandJson,
  deathMessage,
  parseDatagram,
  socketState,
  toCommand,
  toGame,
  type EventsOptions,
  type GameEvent,
} from '../src/events.ts';
import { HubClient } from '../src/hub.ts';
import { RconSession } from '../src/rcon.ts';
import type { UnitState } from '../src/service.ts';
import { readGameLine, type ToGame } from '../src/wire.ts';
import { eventually, fakeHub } from './fake-hub.ts';
import { PASSWORD, fakeRcon } from './fake-rcon.ts';

const BANNER = '   0.000 2026-10-31 12:00:00; Factorio 2.1.24 (build 87808, linux64, headless, space-age)';
const RCON_LINE = '   0.210 Info RemoteCommandProcessor.cpp:119: Starting RCON interface at IP ADDR:({127.0.0.1:27015})';
const opened = (port: number) => `   0.512 Info UDPSocket.cpp:38: Opening socket at (IP ADDR:({127.0.0.1:${port}}))`;
const FAILED = '   0.498 Warning Game.cpp:73: Opening Lua UDP Socket failed: Binding IPv4 socket failed: Address already in use';

async function udp(): Promise<Socket> {
  const socket = createSocket('udp4');
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  return socket;
}

/**
 * A GameEvents on a free port, with "Factorio" (a UDP socket whose port is the configured `factorioUdpPort`) and a
 * stranger (any other local socket), a temp log, Alice online, and an RCON that records its commands.
 */
async function setup(t: TestContext, options: Partial<EventsOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-events-'));
  const log = join(dir, 'factorio-current.log');
  const factorio = await udp();
  const stranger = await udp();
  const factorioPort = factorio.address().port;
  const players = ['Alice'];
  const commands: string[] = [];
  const events = new GameEvents({
    port: 0,
    factorioPort,
    log,
    players: () => players,
    run: async (command) => {
      commands.push(command);
      return '{"seq":0,"ok":true}';
    },
    deadlineMs: 300,
    pollMs: 10,
    helloMs: 50,
    ...options,
  });
  const got: GameEvent[] = [];
  events.on('event', (e) => got.push(e));
  events.start();
  const port = await eventually(() => events.bound, 2000, 'the UDP listener');
  t.after(async () => {
    events.stop();
    factorio.close();
    stranger.close();
    await rm(dir, { recursive: true, force: true });
  });
  const send = (from: Socket, msg: object | Buffer) =>
    new Promise<void>((resolve, reject) =>
      from.send(Buffer.isBuffer(msg) ? msg : JSON.stringify(msg), port, '127.0.0.1', (err) => (err ? reject(err) : resolve())),
    );
  let since = Math.floor(Date.now() / 1000) * 1000 - 60_000;
  /** A start of the unit (a new change time each call), with the log Factorio wrote for it. */
  const start = async (lines: string[]) => {
    await writeFile(log, lines.map((l) => `${l}\n`).join(''));
    since += 1000;
    events.service(unit('active', since));
  };
  return { events, factorio, stranger, factorioPort, players, commands, got, log, send, start };
}

const unit = (active: string, since: number): UnitState => ({ unit: 'factorio.service', active, sub: active === 'active' ? 'running' : 'dead', since, result: 'success' });

/** The console lines a mocked console method got. */
const printed = (mock: { mock: { calls: { arguments: unknown[] }[] } }) => mock.mock.calls.map((c) => String(c.arguments[0]));

test('packets from a wrong source port are dropped; the same from Factorio’s port is relayed, only while the unit is active', async (t) => {
  const s = await setup(t);
  await s.send(s.factorio, { seq: 1, t: 'chat', player: 'Alice', message: 'before any start' });
  await s.start([BANNER, opened(s.factorioPort)]);
  await eventually(() => s.events.gate === 'on', 2000, 'the gate');

  await s.send(s.stranger, { seq: 2, t: 'chat', player: 'Alice', message: 'forged' });
  await s.send(s.factorio, { seq: 2, t: 'chat', player: 'Alice', message: 'real' });
  await eventually(() => s.got.length === 1);
  await sleep(30);
  assert.deepEqual(s.got, [{ type: 'chat', player: 'Alice', message: 'real' }]);

  // At most 4 KiB: exactly 4096 bytes is taken (its message cut to the hub's 1 KiB), one byte more is not.
  const sized = (bytes: number) => {
    const empty = JSON.stringify({ seq: 3, t: 'chat', player: 'Alice', message: '' });
    return Buffer.from(JSON.stringify({ seq: 3, t: 'chat', player: 'Alice', message: 'x'.repeat(bytes - empty.length) }));
  };
  assert.equal(sized(MAX_DATAGRAM + 1).length, MAX_DATAGRAM + 1);
  await s.send(s.factorio, sized(MAX_DATAGRAM + 1));
  await s.send(s.factorio, sized(MAX_DATAGRAM));
  await eventually(() => s.got.length === 2);
  await sleep(30);
  assert.equal(s.got.length, 2);
  assert.deepEqual(s.got[1], { type: 'chat', player: 'Alice', message: 'x'.repeat(1024) });

  s.events.service(unit('inactive', Date.now()));
  assert.equal(s.events.gate, 'closed');
  await s.send(s.factorio, { seq: 4, t: 'join', player: 'Alice' });
  await sleep(30);
  assert.equal(s.got.length, 2, 'nothing while the unit is not active');
});

test('events are dropped when the Opening socket line is missing, or Factorio could not open it; logged once; the next start with the line turns them on', async (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const s = await setup(t);
  const off = () => printed(error).filter((l) => l.includes('game events are off'));

  // Neither line (a chat line or a mod's log() with the text does not count): checking, then off at the deadline.
  await s.start([
    BANNER,
    RCON_LINE,
    `2026-10-31 12:00:05 [CHAT] Mallory: ${opened(s.factorioPort).trim()}`,
    `   7.943 Script @__evil__/control.lua:1: Opening socket at (IP ADDR:({127.0.0.1:${s.factorioPort}}))`,
  ]);
  assert.equal(s.events.gate, 'checking');
  await s.send(s.factorio, { seq: 1, t: 'join', player: 'Alice' });
  await eventually(() => s.events.gate === 'off', 2000, 'off at the deadline');
  await s.send(s.factorio, { seq: 2, t: 'join', player: 'Alice' });
  await sleep(50);
  assert.deepEqual(s.got, []);
  assert.equal(off().length, 1);
  assert.match(off()[0]!, /no "Opening socket" line/);

  // Another port's socket is not Factorio's Lua socket.
  await s.start([BANNER, opened(s.factorioPort + 1)]);
  await eventually(() => s.events.gate === 'off');
  assert.equal(off().length, 2);

  // The failure line decides at once, even with the line after it.
  await s.start([BANNER, FAILED, opened(s.factorioPort)]);
  await eventually(() => s.events.gate === 'off');
  assert.equal(off().length, 3);
  assert.match(off()[2]!, /could not open its Lua UDP socket/);
  await s.send(s.factorio, { seq: 3, t: 'join', player: 'Alice' });
  await sleep(50);
  assert.deepEqual(s.got, []);

  await s.start([BANNER, RCON_LINE, opened(s.factorioPort)]);
  await eventually(() => s.events.gate === 'on');
  await s.send(s.factorio, { seq: 4, t: 'join', player: 'Alice' });
  await eventually(() => s.got.length === 1);
  assert.deepEqual(s.got, [{ type: 'join', player: 'Alice' }]);
  assert.equal(off().length, 3, 'each start reports once');
});

test('a log not written since the start is the previous run’s: it is not read until Factorio replaces it', async (t) => {
  const s = await setup(t, { deadlineMs: 5000 });
  const since = Math.floor(Date.now() / 1000) * 1000 - 10_000;
  // A restart the agent didn't see stopped: the previous run's log, last written in the second the unit became active.
  await writeFile(s.log, `${BANNER}\n${opened(s.factorioPort)}\n`);
  await utimes(s.log, (since + 900) / 1000, (since + 900) / 1000);
  s.events.service(unit('active', since));
  await sleep(60);
  assert.equal(s.events.gate, 'checking');
  await utimes(s.log, (since + 1000) / 1000, (since + 1000) / 1000); // Factorio wrote it after that second
  await eventually(() => s.events.gate === 'on');

  // A stop the agent saw: a log from before it is stale whatever the unit's change time.
  s.events.service(unit('inactive', since + 2000));
  const stopped = Date.now();
  await utimes(s.log, (stopped - 500) / 1000, (stopped - 500) / 1000);
  s.events.service(unit('active', since + 3000));
  await sleep(60);
  assert.equal(s.events.gate, 'checking');
  await utimes(s.log, (stopped + 1000) / 1000, (stopped + 1000) / 1000);
  await eventually(() => s.events.gate === 'on');
});

test('link for an offline name is dropped; for an online one it is relayed with uuid "", and so is unlink', async (t) => {
  const s = await setup(t);
  await s.start([BANNER, opened(s.factorioPort)]);
  await eventually(() => s.events.gate === 'on');
  await s.send(s.factorio, { seq: 1, t: 'link', player: 'Mallory', code: 'ABC234' });
  await s.send(s.factorio, { seq: 2, t: 'unlink', player: 'Mallory' });
  await s.send(s.factorio, { seq: 3, t: 'link', player: 'Alice', code: 'ABC234' });
  await s.send(s.factorio, { seq: 4, t: 'unlink', player: 'Alice' });
  await eventually(() => s.got.length === 2);
  await sleep(30);
  assert.deepEqual(s.got, [
    { type: 'link', player: 'Alice', uuid: '', code: 'ABC234' },
    { type: 'unlink', player: 'Alice' },
  ]);
  s.players.push('Mallory'); // the next /orrery-status has them online
  await s.send(s.factorio, { seq: 5, t: 'link', player: 'Mallory', code: 'XYZ999' });
  await eventually(() => s.got.length === 3);
  assert.deepEqual(s.got[2], { type: 'link', player: 'Mallory', uuid: '', code: 'XYZ999' });
});

test('UDP seq gaps are logged; the hello datagram is the baseline, again after each start', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const s = await setup(t);
  const seqLines = () => printed(log).filter((l) => /lost|went back/.test(l));
  await s.start([BANNER, opened(s.factorioPort)]);
  await eventually(() => s.events.gate === 'on');
  await s.send(s.factorio, { seq: 5, t: 'hello' });
  await s.send(s.factorio, { seq: 6, t: 'join', player: 'Alice' });
  await s.send(s.factorio, { seq: 9, t: 'leave', player: 'Alice', reason: 'quit' });
  await s.send(s.factorio, { seq: 10, t: 'join', player: 'Alice' });
  await s.send(s.factorio, { seq: 3, t: 'leave', player: 'Alice', reason: 'quit' });
  await eventually(() => s.got.length === 4);
  assert.deepEqual(seqLines(), ['[events] 2 game events lost: seq 7 to 8 never came', '[events] seq went back from 10 to 3']);

  // After a restart the map may have rewound (a crash, a restore): no baseline until the next hello or event.
  await s.start([BANNER, opened(s.factorioPort)]);
  await eventually(() => s.events.gate === 'on');
  await s.send(s.factorio, { seq: 2, t: 'join', player: 'Alice' });
  await s.send(s.factorio, { seq: 4, t: 'join', player: 'Alice' });
  await eventually(() => s.got.length === 6);
  assert.deepEqual(seqLines().slice(2), ['[events] 1 game event lost: seq 3 never came']);
});

test('/orrery-hello once per start, after the gate opens and RCON answers; a hello datagram that never comes is logged', async (t) => {
  const error = t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  const s = await setup(t);
  s.events.rconUp();
  await s.start([BANNER, opened(s.factorioPort)]);
  s.events.rconUp(); // still checking
  await eventually(() => s.events.gate === 'on');
  assert.deepEqual(s.commands, []);
  s.events.rconUp();
  s.events.rconUp();
  await eventually(() => s.commands.length === 1);
  assert.deepEqual(s.commands, ['/orrery-hello']);
  await eventually(() => printed(error).some((l) => l.includes('no hello datagram came')), 2000, 'the missing hello logged');

  await s.start([BANNER, opened(s.factorioPort)]);
  await eventually(() => s.events.gate === 'on');
  s.events.rconUp();
  await eventually(() => s.commands.length === 2);
  await s.send(s.factorio, { seq: 7, t: 'hello' }); // in time this time
  await sleep(120);
  assert.equal(printed(error).filter((l) => l.includes('no hello datagram came')).length, 1);
});

test('the mod’s datagrams map to the game connection’s messages, within the hub’s limits', () => {
  const read = (msg: object) => parseDatagram(Buffer.from(JSON.stringify(msg)));
  const cases: [object, GameEvent][] = [
    [{ seq: 1, t: 'chat', player: 'Alice', message: 'hi [color=red]x[/color]' }, { type: 'chat', player: 'Alice', message: 'hi [color=red]x[/color]' }],
    [{ seq: 2, t: 'join', player: 'Alice' }, { type: 'join', player: 'Alice' }],
    [{ seq: 3, t: 'leave', player: 'Alice', reason: 'dropped' }, { type: 'leave', player: 'Alice' }],
    [{ seq: 4, t: 'death', player: 'Alice', cause: 'medium-biter' }, { type: 'death', player: 'Alice', message: 'Alice was killed by a medium biter' }],
    [{ seq: 5, t: 'death', player: 'Alice', cause: 'character', killer: 'Bob' }, { type: 'death', player: 'Alice', message: 'Alice was killed by Bob' }],
    [{ seq: 6, t: 'death', player: 'Alice', cause: 'artillery-turret' }, { type: 'death', player: 'Alice', message: 'Alice was killed by an artillery turret' }],
    [{ seq: 7, t: 'death', player: 'Alice' }, { type: 'death', player: 'Alice', message: 'Alice died' }],
    [{ seq: 8, t: 'milestone', kind: 'research', text: 'Mining productivity 5' }, { type: 'milestone', kind: 'research', text: 'Mining productivity 5' }],
    [{ seq: 9, t: 'milestone', kind: 'rocket', text: '', force: 'enemy-team' }, { type: 'milestone', kind: 'rocket', text: '', force: 'enemy-team' }],
    [{ seq: 10, t: 'milestone', kind: 'landing', text: 'Vulcanus', player: 'Alice' }, { type: 'milestone', kind: 'landing', text: 'Vulcanus', player: 'Alice' }],
    [{ seq: 11, t: 'milestone', kind: 'platform', text: 'Ship', player: 'x'.repeat(65) }, { type: 'milestone', kind: 'platform', text: 'Ship' }],
    [{ seq: 12, t: 'link', player: 'Alice', code: 'ABC234' }, { type: 'link', player: 'Alice', uuid: '', code: 'ABC234' }],
    [{ seq: 13, t: 'unlink', player: 'Alice', extra: 'dropped' }, { type: 'unlink', player: 'Alice' }],
    [{ seq: 14, t: 'chat', player: 'Alice', message: '😀'.repeat(600) }, { type: 'chat', player: 'Alice', message: '😀'.repeat(512) }],
    [{ seq: 15, t: 'death', player: 'Alice', cause: 'x'.repeat(65) }, { type: 'death', player: 'Alice', message: 'Alice died' }],
  ];
  for (const [msg, event] of cases) {
    const d = read(msg);
    assert.deepEqual(d, { seq: (msg as { seq: number }).seq, event }, JSON.stringify(msg));
    assert.deepEqual(parseModLine(JSON.stringify(event)), event, 'the hub takes it as it is');
  }
  assert.deepEqual(read({ seq: 0, t: 'hello' }), { seq: 0, event: null });
  const dropped: object[] = [
    { t: 'chat', player: 'Alice', message: 'no seq' },
    { seq: -1, t: 'join', player: 'Alice' },
    { seq: 1.5, t: 'join', player: 'Alice' },
    { seq: '1', t: 'join', player: 'Alice' },
    { seq: 1, player: 'Alice' },
    { seq: 1, t: 'quit', player: 'Alice' },
    { seq: 1, t: 'join' },
    { seq: 1, t: 'join', player: '' },
    { seq: 1, t: 'join', player: 'x'.repeat(65) },
    { seq: 1, t: 'chat', player: 'Alice' },
    { seq: 1, t: 'milestone', kind: 'launch', text: 'x' },
    { seq: 1, t: 'milestone', kind: 'research' },
    { seq: 1, t: 'link', player: 'Alice', code: 'ABC 234' },
    { seq: 1, t: 'link', player: 'Alice', code: 'A'.repeat(17) },
    { seq: 1, t: 'link', player: 'Alice' },
  ];
  for (const msg of dropped) assert.equal(typeof read(msg), 'string', JSON.stringify(msg));
  assert.equal(typeof parseDatagram(Buffer.from('{"seq":1,')), 'string');
  assert.equal(typeof parseDatagram(Buffer.from('[1]')), 'string');
  assert.equal(deathMessage('Alice', 'locomotive', null), 'Alice was killed by a locomotive');
});

test('socketState: the engine line for that port, or the failure line, whichever comes first; whole lines only', () => {
  assert.equal(socketState(`${BANNER}\n${opened(34198)}\n`, 34198), 'on');
  assert.equal(socketState(`${BANNER}\r\n${opened(34198)}\r\n`, 34198), 'on');
  assert.equal(socketState(`${BANNER}\n${opened(34198)}`, 34198), null, 'a line still being written');
  assert.equal(socketState(`${BANNER}\n${opened(34198)}\n`, 34199), null);
  assert.equal(socketState(`${BANNER}\n${FAILED}\n${opened(34198)}\n`, 34198), 'off');
  assert.equal(socketState(`${opened(34198)}\n${FAILED}\n`, 34198), 'on');
  assert.equal(socketState(`10000.123 Info UDPSocket.cpp:41: Opening socket at (IP ADDR:({127.0.0.1:34198}))\n`, 34198), 'on');
  assert.equal(socketState(`   0.512 Info UDPSocket.cpp:38: Opening socket at (IP ADDR:({0.0.0.0:34198}))\n`, 34198), null);
  assert.equal(socketState(`2026-10-31 12:00:05 [CHAT] Bob:    0.5 Info A.cpp:1: Opening Lua UDP Socket failed\n`, 34198), null);
  assert.equal(socketState(`   7.943 Script @__evil__/control.lua:1: Opening Lua UDP Socket failed\n`, 34198), null);
});

test('RCON strings are escaped: one line of plain JSON that reads back the same, never Lua', () => {
  const nasty = 'a\nb\r\tc\u0000d\u001fe\u007ff\u0085g\u2028h\u2029i "quoted" \\ back [color=red]x[/color] 😀 \uD800';
  const say: ToGame = { type: 'say', author: `Bob\n/c game.print(1)`, message: nasty, source: 'dashboard' };
  const notice: ToGame = { type: 'notice', message: nasty };
  const reply: ToGame = { type: 'linkResult', player: 'Alice', ok: false, message: nasty };
  const cases: [ToGame, string, object][] = [
    [say, '/orrery-say ', { author: say.author, message: nasty, source: 'dashboard' }],
    [notice, '/orrery-notice ', { message: nasty }],
    [reply, '/orrery-reply ', { player: 'Alice', ok: false, message: nasty }],
  ];
  for (const [msg, prefix, arg] of cases) {
    const command = toCommand(msg);
    assert.ok(command.startsWith(prefix), command);
    assert.doesNotMatch(command, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/, 'no control character, newline or separator');
    assert.deepEqual(JSON.parse(command.slice(prefix.length)), arg);
    assert.doesNotMatch(command, /^\/(c|sc|silent-command|command) /);
  }
  assert.equal(commandJson({ m: '\u007f\u2028' }), '{"m":"\\u007f\\u2028"}');
});

test('the game connection: say, notice and linkResult run as the mod’s commands, in order; the mod’s link reaches the hub with uuid ""', async (t) => {
  t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const rcon = await fakeRcon((cmd) => (cmd.startsWith('/orrery-reply') ? '{"ok":false,"error":"not online: Bob"}' : '{"ok":true}'));
  const hub = await fakeHub();
  const session = new RconSession(rcon.port, PASSWORD, 500);
  const run = (command: string) => session.exec(command);
  const dir = await mkdtemp(join(tmpdir(), 'orrery-events-'));
  const server = { id: 'factorio', unit: 'factorio.service', install: '/opt/factorio', data: dir, rconPort: rcon.port, factorioUdpPort: 34198, agentUdpPort: 34199 };
  const client = new HubClient({
    config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server, token: 'agent-token-'.padEnd(40, 'x'), root: dir },
    version: 'agent-v1.2.3',
    toGame: (msg) => void toGame(run, msg),
  });
  const factorio = await udp();
  const events = new GameEvents({ port: 0, factorioPort: factorio.address().port, log: join(dir, 'factorio-current.log'), players: () => ['Alice'], run, pollMs: 10 });
  events.on('event', (e) => client.event(e));
  t.after(async () => {
    events.stop();
    factorio.close();
    session.close();
    await client.stop();
    await hub.close();
    await rcon.close();
    await rm(dir, { recursive: true, force: true });
  });
  client.start();
  await eventually(() => client.connected);
  client.status({ ups: null, players: ['Alice'], paused: false, modVersion: '0.1.0' });
  const game = await eventually(() => hub.of('hello')[0]);
  await eventually(() => game.lines.length === 1 && !game.socket.destroyed && game.socket.readyState === 'open');
  await sleep(30); // the welcome is read

  game.send({ type: 'say', author: 'Bob', message: 'hello\nthere', source: 'discord' });
  game.send({ type: 'say', author: 'x'.repeat(257), message: 'too long an author' }); // invalid: ignored
  game.send({ type: 'notice', message: 'Restarting in 5 minutes' });
  game.send({ type: 'linkResult', player: 'Bob', ok: true, message: 'Linked to bob#0' });
  game.send({ type: 'say', author: 'Ann', message: 'no source' });
  await eventually(() => rcon.commands().length === 4);
  assert.deepEqual(rcon.commands(), [
    '/orrery-say {"author":"Bob","message":"hello\\nthere","source":"discord"}',
    '/orrery-notice {"message":"Restarting in 5 minutes"}',
    '/orrery-reply {"player":"Bob","ok":true,"message":"Linked to bob#0"}',
    '/orrery-say {"author":"Ann","message":"no source","source":"discord"}',
  ]);
  await eventually(() => printed(error).some((l) => l.includes('linkResult was not shown') && l.includes('not online: Bob')));

  // The mod's link datagram, from Factorio's port while the gate is on, reaches the hub as the hub's own parser reads it.
  await writeFile(join(dir, 'factorio-current.log'), `${BANNER}\n${opened(factorio.address().port)}\n`);
  events.start();
  const port = await eventually(() => events.bound);
  events.service(unit('active', Math.floor(Date.now() / 1000) * 1000 - 10_000));
  await eventually(() => events.gate === 'on');
  factorio.send(JSON.stringify({ seq: 1, t: 'link', player: 'Alice', code: 'ABC234' }), port, '127.0.0.1');
  await eventually(() => game.lines.find((m) => m.type === 'link'));
  assert.deepEqual(
    game.lines.filter((m) => m.type === 'link'),
    [{ type: 'link', player: 'Alice', uuid: '', code: 'ABC234' }],
  );
  assert.deepEqual(game.invalid, []);
});

test('the game connection’s say, notice and linkResult are checked against their documented fields and limits', () => {
  const read = (msg: object) => readGameLine(JSON.stringify(msg)).msg;
  assert.deepEqual(read({ type: 'say', author: 'Bob', message: 'm', source: 'dashboard', extra: 1 }), { type: 'say', author: 'Bob', message: 'm', source: 'dashboard' });
  assert.deepEqual(read({ type: 'say', author: 'Bob', message: 'm' }), { type: 'say', author: 'Bob', message: 'm', source: 'discord' });
  assert.equal(read({ type: 'say', author: 'Bob', message: 'm', source: 'console' }), null);
  assert.equal(read({ type: 'say', author: 'Bob', message: 'x'.repeat(1025), source: 'discord' }), null);
  assert.deepEqual(read({ type: 'notice', message: 'x'.repeat(1024) }), { type: 'notice', message: 'x'.repeat(1024) });
  assert.equal(read({ type: 'notice' }), null);
  assert.deepEqual(read({ type: 'linkResult', player: 'Bob', ok: false, message: 'no' }), { type: 'linkResult', player: 'Bob', ok: false, message: 'no' });
  assert.equal(read({ type: 'linkResult', player: 'Bob', ok: 'yes', message: 'no' }), null);
  assert.equal(read({ type: 'linkResult', player: 'x'.repeat(65), ok: true, message: 'no' }), null);
  assert.equal(read({ type: 'cmd', id: '1', command: '/players' }), null, 'cmd is not handled yet');
});

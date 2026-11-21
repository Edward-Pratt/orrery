// RCON strings escaped (`toCommand`); end to end with the fake hub and fake RCON, the hub's `say`, `notice` and
// `linkResult` as commands in order, and a link datagram reaching the hub; the game connection's `say`, `notice`,
// `linkResult`, `cmd` and `save` checked against their fields and limits (`readGameLine`).

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameEvents } from '../src/events.ts';
import { commandJson, toCommand, toGame } from '../src/events-commands.ts';
import { HubClient } from '../src/hub.ts';
import { RconSession } from '../src/rcon.ts';
import { readGameLine, type ToGame } from '../src/wire.ts';
import { eventually, fakeHub } from './fake-hub.ts';
import { PASSWORD, fakeRcon } from './fake-rcon.ts';
import { BANNER, printed, udp, unit, up } from './events-world.ts';

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
    config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server, token: 'agent-token-'.padEnd(40, 'x'), root: dir, state: join(dir, 'state') },
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
  await writeFile(join(dir, 'factorio-current.log'), `${BANNER}\n${up(factorio.address().port)}\n`);
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
});

test('the game connection’s cmd and save are checked too: a console command is one line of 1 to 256 characters', () => {
  const read = (msg: object) => readGameLine(JSON.stringify(msg));
  assert.deepEqual(read({ type: 'cmd', id: '1', command: '/players', extra: 1 }), { msg: { type: 'cmd', id: '1', command: '/players' } });
  assert.deepEqual(read({ type: 'cmd', id: '2', command: 'x'.repeat(256) }).msg, { type: 'cmd', id: '2', command: 'x'.repeat(256) });
  for (const command of ['x'.repeat(257), '', '/c a\nb', '/players\u007f', 7]) {
    assert.deepEqual(read({ type: 'cmd', id: '3', command }), { msg: null, id: '3', why: 'invalid cmd' }, JSON.stringify(command));
  }
  assert.deepEqual(read({ type: 'save', name: 'ignored' }), { msg: { type: 'save' } });
});

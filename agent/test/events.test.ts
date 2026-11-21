// `GameEvents` with UDP injected from Factorio's port and from a stranger's: wrong source port, oversize and
// closed-gate datagrams dropped; the log check (no line or a forged chat or `log()` line: off at the deadline, logged
// once; the failure line, also after the Opening line as Factorio writes it on a taken port: off at once; the next
// start: on; a previous run's log not read); `state` once per change (off at the deadline or the failure line, on at a
// start with the line), and off while the agent's own UDP port is taken past one retry; `seq` gaps and the hello
// baseline; `/orrery-hello` once per start; `socketState` on Factorio's log lines. The setup is `events-world.ts`'s.

import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { GameEvents, type EventsState } from '../src/events.ts';
import { MAX_DATAGRAM, socketState } from '../src/events-gate.ts';
import { eventually } from './fake-hub.ts';
import { BANNER, CLOSED, FAILED, HOSTING, RCON_LINE, opened, printed, setup, udp, unit, up } from './events-world.ts';

test('packets from a wrong source port are dropped; the same from Factorio’s port is relayed, only while the unit is active', async (t) => {
  const s = await setup(t);
  await s.send(s.factorio, { seq: 1, t: 'chat', player: 'Alice', message: 'before any start' });
  await s.start([BANNER, up(s.factorioPort)]);
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

  // Factorio 2.1.24 with the port taken (the e2e loop): the Opening line comes before the close and the failure, so
  // whoever holds the port (it sends from Factorio's port) gets nothing through.
  await s.start([BANNER, opened(s.factorioPort), ...CLOSED, FAILED, HOSTING]);
  await eventually(() => s.events.gate === 'off');
  assert.equal(off().length, 4);
  assert.match(off()[3]!, /could not open its Lua UDP socket/);
  await s.send(s.factorio, { seq: 4, t: 'chat', player: 'forged', message: 'from whoever holds the port' });
  await sleep(50);
  assert.deepEqual(s.got, []);

  await s.start([BANNER, RCON_LINE, up(s.factorioPort)]);
  await eventually(() => s.events.gate === 'on');
  await s.send(s.factorio, { seq: 5, t: 'join', player: 'Alice' });
  await eventually(() => s.got.length === 1);
  assert.deepEqual(s.got, [{ type: 'join', player: 'Alice' }]);
  assert.equal(off().length, 4, 'each start reports once');
});

test('whether events reach the hub is a state, emitted once per change: off with why, on again at a start with the line', async (t) => {
  t.mock.method(console, 'error', () => {});
  const s = await setup(t);
  await s.start([BANNER, RCON_LINE]);
  await eventually(() => s.states.length === 1, 2000, 'off at the deadline');
  assert.equal(s.states[0]!.on, false);
  assert.match((s.states[0] as { reason: string }).reason, /^no "Opening socket" line for 127\.0\.0\.1:\d+ in .* within 0\.3 s: off until Factorio starts again$/);
  await s.start([BANNER, FAILED]); // off again: no change
  await eventually(() => s.events.gate === 'off');
  await s.start([BANNER, up(s.factorioPort)]);
  await eventually(() => s.states.length === 2, 2000, 'on again');
  assert.deepEqual(s.states[1], { on: true });
  await s.start([BANNER, up(s.factorioPort)]); // on again: no change
  await eventually(() => s.events.gate === 'on');
  await s.start([BANNER, FAILED]);
  await eventually(() => s.states.length === 3, 2000, 'off at the failure line');
  assert.deepEqual(s.states[2], { on: false, reason: `Factorio could not open its Lua UDP socket (is 127.0.0.1:${s.factorioPort} taken?): off until Factorio starts again` });
  await sleep(50);
  assert.equal(s.states.length, 3);
});

test("the agent's own UDP port taken past one retry is off too; on once it listens and a start's log shows the socket", async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  const holder = await udp(); // another local process on the agent's port
  const port = holder.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'orrery-events-'));
  const log = join(dir, 'factorio-current.log');
  const events = new GameEvents({ port, factorioPort: 34198, log, players: () => [], run: async () => '', retryMs: 20, pollMs: 10 });
  const states: EventsState[] = [];
  events.on('state', (state) => states.push(state));
  t.after(async () => {
    events.stop();
    await rm(dir, { recursive: true, force: true });
  });
  events.start();
  await eventually(() => states.length === 1, 2000, 'off once the retry failed');
  assert.equal(states[0]!.on, false);
  assert.match((states[0] as { reason: string }).reason, new RegExp(`^the agent can't listen on UDP 127\\.0\\.0\\.1:${port} \\(.*EADDRINUSE.*\\), where the mod sends them: trying again every 0\\.02 s$`));
  await sleep(100); // more failed retries: still one
  assert.equal(states.length, 1);
  holder.close();
  await eventually(() => events.bound === port, 2000, 'listening');
  await sleep(50);
  assert.equal(states.length, 1, 'listening, but no start has shown the socket: nothing to say yet');
  await writeFile(log, `${BANNER}\n${up(34198)}\n`);
  events.service(unit('active', Math.floor(Date.now() / 1000) * 1000 - 5000));
  await eventually(() => states.length === 2, 2000, 'on');
  assert.deepEqual(states[1], { on: true });
});

test('a log not written since the start is the previous run’s: it is not read until Factorio replaces it', async (t) => {
  const s = await setup(t, { deadlineMs: 5000 });
  const since = Math.floor(Date.now() / 1000) * 1000 - 10_000;
  // A restart the agent didn't see stopped: the previous run's log, last written in the second the unit became active.
  await writeFile(s.log, `${BANNER}\n${up(s.factorioPort)}\n`);
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

test('UDP seq gaps are logged; the hello datagram is the baseline, again after each start', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const s = await setup(t);
  const seqLines = () => printed(log).filter((l) => /lost|went back/.test(l));
  await s.start([BANNER, up(s.factorioPort)]);
  await eventually(() => s.events.gate === 'on');
  await s.send(s.factorio, { seq: 5, t: 'hello' });
  await s.send(s.factorio, { seq: 6, t: 'join', player: 'Alice' });
  await s.send(s.factorio, { seq: 9, t: 'leave', player: 'Alice', reason: 'quit' });
  await s.send(s.factorio, { seq: 10, t: 'join', player: 'Alice' });
  await s.send(s.factorio, { seq: 3, t: 'leave', player: 'Alice', reason: 'quit' });
  await eventually(() => s.got.length === 4);
  assert.deepEqual(seqLines(), ['[events] 2 game events lost: seq 7 to 8 never came', '[events] seq went back from 10 to 3']);

  // After a restart the map may have rewound (a crash, a restore): no baseline until the next hello or event.
  await s.start([BANNER, up(s.factorioPort)]);
  await eventually(() => s.events.gate === 'on');
  await s.send(s.factorio, { seq: 2, t: 'join', player: 'Alice' });
  await s.send(s.factorio, { seq: 4, t: 'join', player: 'Alice' });
  await eventually(() => s.got.length === 6);
  assert.deepEqual(seqLines().slice(2), ['[events] 1 game event lost: seq 3 never came']);
});

test('/orrery-hello once per start, after the gate opens and RCON answers; a hello datagram that never comes is logged', async (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const log = t.mock.method(console, 'log', () => {});
  const helloMs = 200; // far over a datagram's way on loopback, so one sent in time is never late
  const s = await setup(t, { helloMs });
  s.events.rconUp();
  await s.start([BANNER, up(s.factorioPort)]);
  s.events.rconUp(); // still checking
  await eventually(() => s.events.gate === 'on');
  assert.deepEqual(s.commands, []);
  s.events.rconUp();
  s.events.rconUp();
  await eventually(() => s.commands.length === 1);
  assert.deepEqual(s.commands, ['/orrery-hello']);
  await eventually(() => printed(error).some((l) => l.includes('no hello datagram came')), 2000, 'the missing hello logged');

  await s.start([BANNER, up(s.factorioPort)]);
  await eventually(() => s.events.gate === 'on');
  s.events.rconUp();
  await eventually(() => s.commands.length === 2);
  await s.send(s.factorio, { seq: 7, t: 'hello' }); // in time this time
  await eventually(() => printed(log).includes("[events] the mod's hello came: seq 7"), 2000, 'the hello');
  await sleep(helloMs + 50);
  assert.equal(printed(error).filter((l) => l.includes('no hello datagram came')).length, 1);
});

test('socketState: the Opening line for that port counts once the next line is in and is not Factorio closing it; the failure line anywhere is off; whole lines only', () => {
  assert.equal(socketState(`${BANNER}\n${up(34198)}\n`, 34198), 'on');
  assert.equal(socketState(`${BANNER}\r\n${opened(34198)}\r\n${HOSTING}\r\n`, 34198), 'on');
  assert.equal(socketState(`${BANNER}\n${opened(34198)}`, 34198), null, 'a line still being written');
  assert.equal(socketState(`${BANNER}\n${opened(34198)}\n`, 34198), null, 'the bind\'s outcome is not logged yet');
  assert.equal(socketState(`${BANNER}\n${opened(34198)}\n${HOSTING}`, 34198), null, 'the next line still being written');
  assert.equal(socketState(`${BANNER}\n${up(34198)}\n`, 34199), null);
  assert.equal(socketState(`${BANNER}\n${FAILED}\n${up(34198)}\n`, 34198), 'off');
  // Factorio 2.1.24 with 127.0.0.1:34198 taken: the Opening line comes first, then the close and the failure.
  assert.equal(socketState(`${BANNER}\n${opened(34198)}\n${CLOSED.join('\n')}\n${FAILED}\n${HOSTING}\n`, 34198), 'off');
  assert.equal(socketState(`${BANNER}\n${opened(34198)}\n${CLOSED[0]}\n`, 34198), 'off', 'closed before the failure line is in');
  assert.equal(socketState(`${opened(34198)}\n${FAILED}\n`, 34198), 'off');
  assert.equal(socketState(`10000.123 Info UDPSocket.cpp:41: Opening socket at (IP ADDR:({127.0.0.1:34198}))\n${HOSTING}\n`, 34198), 'on');
  assert.equal(socketState(`   0.512 Info UDPSocket.cpp:38: Opening socket at (IP ADDR:({0.0.0.0:34198}))\n${HOSTING}\n`, 34198), null);
  assert.equal(socketState(`2026-10-31 12:00:05 [CHAT] Bob:    0.5 Info A.cpp:1: Opening Lua UDP Socket failed\n`, 34198), null);
  assert.equal(socketState(`   7.943 Script @__evil__/control.lua:1: Opening Lua UDP Socket failed\n`, 34198), null);
});

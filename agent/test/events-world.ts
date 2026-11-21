// The setup the `GameEvents` tests share (`events.test.ts`, `events-link.test.ts`, `events-budget.test.ts`,
// `events-commands.test.ts`): Factorio's log lines as 2.1.24 writes them, a bound UDP socket (`udp`), `GameEvents` on a
// free port with "Factorio" and a stranger, a temp log, Alice online and an RCON that records its commands (`setup`),
// a unit state (`unit`), and the lines a mocked console method got (`printed`).

import { createSocket, type Socket } from 'node:dgram';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { GameEvents, type EventsOptions, type EventsState, type GameEvent } from '../src/events.ts';
import type { UnitState } from '../src/service.ts';
import { eventually } from './fake-hub.ts';

export const BANNER = '   0.000 2026-10-31 12:00:00; Factorio 2.1.24 (build 87808, linux64, headless, space-age)';
export const RCON_LINE = '   0.210 Info RemoteCommandProcessor.cpp:119: Starting RCON interface at IP ADDR:({127.0.0.1:27015})';
export const opened = (port: number) => `   0.512 Info UDPSocket.cpp:38: Opening socket at (IP ADDR:({127.0.0.1:${port}}))`;
export const FAILED = '   0.498 Warning Game.cpp:73: Opening Lua UDP Socket failed: Binding IPv4 socket failed: Address already in use';
/** What Factorio 2.1.24 logs after the Lua UDP socket's Opening line: the game's own socket (a bind that worked)... */
export const HOSTING = '   0.512 Hosting game at IP ADDR:({127.0.0.1:34197})';
/** ...or, on a taken port, these before FAILED (seen with 127.0.0.1:34198 held by another process). */
export const CLOSED = ['   0.498 Info UDPSocket.cpp:238: Closing socket', '   0.498 Info UDPSocket.cpp:268: Socket closed'];
/** The Lua UDP socket bound: its Opening line and the line after it. */
export const up = (port: number) => `${opened(port)}\n${HOSTING}`;

export async function udp(): Promise<Socket> {
  const socket = createSocket('udp4');
  await new Promise<void>((r) => socket.bind(0, '127.0.0.1', r));
  return socket;
}

/**
 * A GameEvents on a free port, with "Factorio" (a UDP socket whose port is the configured `factorioUdpPort`) and a
 * stranger (any other local socket), a temp log, Alice online, and an RCON that records its commands.
 */
export async function setup(t: TestContext, options: Partial<EventsOptions> = {}) {
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
  const states: EventsState[] = [];
  events.on('state', (state) => states.push(state));
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
  return { events, factorio, stranger, factorioPort, players, commands, got, states, log, send, start };
}

export const unit = (active: string, since: number): UnitState => ({ unit: 'factorio.service', active, sub: active === 'active' ? 'running' : 'dead', since, result: 'success' });

/** The console lines a mocked console method got. */
export const printed = (mock: { mock: { calls: { arguments: unknown[] }[] } }) => mock.mock.calls.map((c) => String(c.arguments[0]));

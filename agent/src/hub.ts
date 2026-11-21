// `HubClient`, the two connections to the hub's Agent port: its public API, on what it keeps (`HubState`,
// `hub-state.ts`), with the Agent connection in `hub-agent.ts`, the game connection in `hub-game.ts`, one TCP
// connection in `hub-link.ts`, the reconnect rules in `hub-retry.ts` and its files in `hub-files.ts`; it re-exports
// their public names. On the Agent connection, once welcomed: `serviceState`, `saves`, `installed`, `events` (whether
// game events reach the hub, its `reason` `printable` and cut to 2 KiB) and `settings` (`GameSettings`' report: its
// `problem` and `rolledBack` `printable` and cut to 2 KiB, its lists to the hub's limits; never twice the same on one
// connection) on connect and on each change (`installed` never twice the same in a row, and kept in
// `<state>/installed.json`, read back shape-checked at start, so a restarted agent sends it on connect while its
// server is stopped too; `latestInstalled`, for a game update's `from` and `to`), `hostSample` when given (never
// queued), `send` for a game update's steps (false while not connected), `deliver` for `updateDone` and
// `deployResult` (resolves true only once the line's write succeeded; false while not connected, when the write
// fails, or after 30 s: the caller keeps it and sends it again on each connect, and the hub ignores a repeat). On the
// game connection: a `heartbeat` per RCON answer (`status`), each game event given to `event` and each `backup`
// (dropped while the game connection isn't up); `stopping`, `stalled`, `down` and `service` drive when it closes
// (`hub-game.ts`'s stopping rule). `start` opens the Agent connection; `connected` and `gameUp` say whether each
// connection is welcomed and not closed (`gameUp`: a game update's gate). `stop`: `bye`, then once it is written the
// game connection and the Agent connection end, 2 s at most.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMsg, AgentRequest, GameSettingsReport, HostSample } from '../../hub/src/types.ts';
import type { Config } from './config.ts';
import type { EventsState, GameEvent } from './events.ts';
import { connect, tellEvents, tellSettings } from './hub-agent.ts';
import { INSTALLED, writeAtomic } from './hub-files.ts';
import { announce, closeGame, endRun, openGame } from './hub-game.ts';
import type { Link } from './hub-link.ts';
import { connected, hubState, type HubState } from './hub-state.ts';
import type { BackupResult, SavesMsg } from './saves.ts';
import type { UnitState } from './service.ts';
import type { Reading } from './status.ts';
import type { InstalledMsg } from './update.ts';
import { LIMITS, cut, printable, type Request, type ToGame } from './wire.ts';

export { writeAtomic } from './hub-files.ts';
export { HUB_WELCOME_GAP_MS, backoff, tooFastWait } from './hub-retry.ts';

/** What answers a request: resolves with its reply's `data` (undefined: none); a throw is the reply's `error`. */
export type Handlers = { [T in AgentRequest['type']]?: (req: Request<T>) => Promise<unknown> };

export type HubOptions = {
  config: Pick<Config, 'id' | 'hub' | 'server' | 'token' | 'root' | 'state'>;
  /** This release, `agent-vX.Y.Z`: the hello's `agentVersion` and the `connected` file's `version`. */
  version: string;
  /** The requests this agent carries out; any other is answered `ok: false`. */
  handlers?: Handlers;
  /** Carries out the hub's `say`, `notice` and `linkResult` from the game connection in game. */
  toGame?: (msg: ToGame) => void;
  /** Runs a console `cmd` from the game connection, resolving with its `cmdResult` output. */
  command?: (command: string) => Promise<string[]>;
  /** The game connection's `save`: makes a named save, whose outcome comes back through `backup`. */
  save?: () => void;
  /** After each welcome, once the state pushed on connect is out: a game update's step and outcome, and a deploy's outcome, go again. */
  welcomed?: () => void;
  pingMs?: number;
  /** For the TCP connect and the hub's answer to a hello. */
  handshakeMs?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  random?: () => number;
  /** How soon after its last welcome the hub welcomes the Agent connection again (`HUB_WELCOME_GAP_MS`). */
  welcomeGapMs?: number;
};

/** How long `deliver` waits for its write to go out before it counts as not delivered (it goes again on a connect). */
const DELIVER_MS = 30_000;

/**
 * The agent's two connections to the hub (docs/protocol.md, "Agent connection"). The Agent connection opens with
 * `agentHello`, sends nothing before `welcome`, then pings every 10 s, pushes the unit's state, the saves, what is
 * installed and whether game events reach the hub (`events`) (on connect and on change) and host samples, carries a
 * game update's steps and a deploy's outcome (`send`), and answers each request by its id. It reconnects after any
 * close, with capped exponential backoff and jitter, logging once per change of state, so with no hub reachable the
 * agent just keeps trying; a hello the hub refuses as `reconnecting too fast` is no failure: the next waits out the
 * hub's 5 s. After each welcome it writes `<root>/connected` (`{ version, time }`, atomically) for its deploy's gate
 * (deploy/deploy-agent.sh).
 *
 * The game connection opens only while the Agent connection is up and RCON answers: a `hello` with the agent's token
 * and the orrery mod's version, `started` once per run of the unit, then a heartbeat per `/orrery-status` answer, the
 * mod's game events and `backup`s. The hub's `say`, `notice` and `linkResult` on it go to `toGame`, a `cmd` to
 * `command` (answered with `cmdResult`), `save` to `save`. It closes with the Agent connection, or when the run ends:
 * right after `stopping` for a stop the agent started (`stopping`), else at the unit's final state (`RunWatch`), with
 * `stopping` first only if that says stopped; not while RCON only stalls or is gone with the unit still active (then
 * the hub's hung detection decides). No new one opens until the unit's next run. `stop` sends `bye`, then closes both.
 */
export class HubClient {
  #s: HubState;

  constructor(o: HubOptions) {
    this.#s = hubState(o);
  }

  /** Whether the Agent connection is up: welcomed and not closed. */
  get connected(): boolean {
    return connected(this.#s);
  }

  /** The latest `installed`, sent or to be sent, kept across restarts (a game update's `from` and `to`); null before one. */
  get latestInstalled(): InstalledMsg | null {
    return this.#s.installed;
  }

  /** Whether the game connection is up: welcomed and not closed (a game update's health gate). */
  get gameUp(): boolean {
    return this.#s.game?.welcomed === true && !this.#s.stopping;
  }

  start(): void {
    if (!this.#s.agent && !this.#s.stopping) connect(this.#s);
  }

  /** RCON answered: opens the game connection if it isn't open, else sends the heartbeat (once there is a rate). */
  status(r: Reading): void {
    this.#s.reading = r;
    if (!this.connected || this.#s.stopping || this.#s.ended !== null) return;
    const game = this.#s.game;
    if (!game) openGame(this.#s, r.modVersion);
    else if (game.welcomed && r.ups !== null) game.send({ type: 'heartbeat', tps: r.ups, players: r.players, paused: r.paused });
  }

  /**
   * RCON stalled (no answer in time, or no status): no new game connection, but an open one stays, heartbeats stop,
   * and the hub's hung detection decides (a frozen server shows as hung, not as a crash).
   */
  stalled(): void {
    this.#s.reading = null;
  }

  /**
   * RCON is gone (refused, or closed by the server): heartbeats stop, and the game connection waits for the unit's
   * final state to say how the run ended. With no unit state known there is nothing to wait for: it closes.
   */
  down(): void {
    this.#s.reading = null;
    if (!this.#s.service) closeGame(this.#s, 'RCON is gone', false);
  }

  /**
   * The unit's new state, sent now if connected, and on every connect. A run that ended without the agent stopping it
   * closes the game connection as `RunWatch` says (`stopping` first if stopped); a new run lets the next one open.
   */
  service(state: UnitState): void {
    this.#s.service = state;
    if (this.connected) this.#s.agent!.send({ type: 'serviceState', ...state });
    const end = this.#s.runs.next(state);
    if (end && this.#s.ended === null) endRun(this.#s, end);
    if (this.#s.ended !== null && state.active === 'active' && state.since !== this.#s.ended) this.#s.ended = null;
    announce(this.#s);
  }

  /**
   * The agent stopped or restarted the unit itself (`serviceAct`, an update's stop): `stopping` on the game connection
   * now, then it closes, before Factorio goes; no new one until the unit's next run.
   */
  stopping(): void {
    if (this.#s.ended === null) this.#s.ended = this.#s.runs.run ?? this.#s.service?.since ?? 0;
    closeGame(this.#s, 'the agent stopped the server', true);
  }

  /** The current save list, sent now if connected, and on every connect. */
  saves(msg: SavesMsg): void {
    this.#s.saves = msg;
    if (this.connected) this.#s.agent!.send({ type: 'saves', ...msg });
  }

  /**
   * What the server runs, as `/orrery-status` last said: sent when it changed and on every connect (never the same
   * twice in a row, so each answer costs the hub nothing). Kept in `<state>/installed.json`, so a restarted agent
   * sends it on connect while the server is stopped too.
   */
  installed(msg: InstalledMsg): void {
    const key = JSON.stringify(msg);
    if (key === this.#s.installedKey) return;
    this.#s.installedKey = key;
    this.#s.installed = msg;
    if (this.connected) this.#s.agent!.send({ type: 'installed', ...msg });
    const file = join(this.#s.config.state, INSTALLED);
    this.#s.saving = this.#s.saving
      .then(() => mkdir(this.#s.config.state, { recursive: true }))
      .then(() => writeAtomic(file, key + '\n'))
      .catch((err: Error) => console.error(`[hub] can't write ${file}: ${err.message}`));
  }

  /** A message on the Agent connection (a game update's `updateStep`, `updateDone`; `deployResult`): false while it isn't up. */
  send(msg: AgentMsg): boolean {
    if (!this.connected || this.#s.stopping) return false;
    this.#s.agent!.send(msg);
    return true;
  }

  /**
   * An outcome the hub must not miss (a game update's `updateDone`, `deployResult`): resolves true once its write on
   * the Agent connection succeeded, false while it isn't up, when the write failed, or when it hasn't gone out within
   * `DELIVER_MS` (a hub that stopped reading). The caller keeps it until true, and sends it again on the next connect
   * (the hub ignores a repeat).
   */
  deliver(msg: AgentMsg): Promise<boolean> {
    if (!this.connected || this.#s.stopping) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), DELIVER_MS).unref();
      this.#s.agent!.send(msg, (written) => {
        clearTimeout(timer);
        resolve(written);
      });
    });
  }

  /**
   * Whether game events reach the hub, on each change (`GameEvents`' `state`): sent now if connected, and on every
   * connect, so a hub that restarted hears it while they are off, and one that missed the change while the agent was
   * away (or on a connection that was closing) hears it on the next. The hub posts only a change.
   */
  events(state: EventsState): void {
    this.#s.events = state;
    tellEvents(this.#s);
  }

  /**
   * The game settings as read (`GameSettings`, at connect, after its own writes and when the unit becomes active): sent
   * now if connected and not the same as the last sent on this connection (the hub drops an identical one anyway, but
   * it would count), and on every connect. Cut to the hub's limits first.
   */
  settings(report: GameSettingsReport): void {
    this.#s.settings = {
      ...report,
      admins: report.admins.slice(0, LIMITS.admins),
      problem: report.problem === null ? null : cut(printable(report.problem), LIMITS.detail),
      pending: report.pending.slice(0, LIMITS.pending),
      extra: report.extra.slice(0, LIMITS.extra),
      rolledBack: report.rolledBack === null ? null : cut(printable(report.rolledBack), LIMITS.detail),
    };
    tellSettings(this.#s);
  }

  /** A save's outcome, as the game connection's `backup` (dropped while it isn't up, like a Mod's). */
  backup(result: BackupResult): void {
    if (this.#s.game?.welcomed && !this.#s.stopping) this.#s.game.send({ type: 'backup', ...result });
    else console.log(`[game] backup not sent, no game connection: ${result.detail}`);
  }

  /** A game event, sent on the game connection while it is up; dropped otherwise, as a Mod drops them while disconnected. */
  event(msg: GameEvent): void {
    if (this.#s.game?.welcomed && !this.#s.stopping) this.#s.game.send(msg);
  }

  /** A host sample, sent only while connected (never queued). */
  sample(sample: HostSample): void {
    if (this.connected) this.#s.agent!.send({ type: 'hostSample', sample });
  }

  /** A planned exit: `bye` on the Agent connection, then both connections closed; resolves once they are (2 s at most). */
  async stop(): Promise<void> {
    this.#s.stopping = true;
    clearTimeout(this.#s.retry);
    clearInterval(this.#s.ping);
    const agent = this.#s.agent;
    const game = this.#s.game;
    const links = [agent, game].filter((l): l is Link => l !== null);
    if (agent?.welcomed) {
      // The game connection closes only once bye is out, so the hub reads its close as part of a planned exit.
      agent.send({ type: 'bye' }, () => {
        game?.end('stopping');
        agent.end('stopping');
      });
    } else for (const l of links) l.drop('stopping');
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(links.map((l) => l.closed)), new Promise((r) => (timer = setTimeout(r, 2000)))]);
    clearTimeout(timer);
    for (const l of links) l.drop('stopping');
  }
}

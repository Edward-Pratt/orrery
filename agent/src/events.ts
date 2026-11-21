// The Factorio mod's game events, both ways (factorio/CLAUDE.md): its UDP datagrams in, checked and turned into the
// game connection's messages, and the hub's say, notice and linkResult out, as the mod's RCON commands.
//
// `GameEvents`: a UDP listener on 127.0.0.1:`agentUdpPort` (retried every 10 s while the port is taken) that takes
// datagrams only from 127.0.0.1:`factorioUdpPort`, only while the unit is `active`, and after each start only once
// Factorio's log shows it bound that port itself (the UDP gate's rules, the 4 KiB cap and `Gate` are
// `events-gate.ts`'s). `state` (`EventsState`) says on each change whether events reach the hub, for the Agent
// connection's `events`: off, with why, once the gate is off or while the UDP port can't be listened on past one
// retry; on once the gate is on and the port listened on (the first decision since the agent started counts as a
// change). Over 4 KiB, or not the mod's shape (`events-datagram.ts`, the event checks): dropped, each kind logged once
// per start. `seq` gaps (and going back) are logged; the baseline is the mod's `hello` datagram, asked for with
// `/orrery-hello` once per start after the gate opens and RCON answers (`rconUp`); one that doesn't come within 5 s is
// logged. Emits the events within `EventBudget` (`events-budget.ts`); a link or unlink for a name not online goes
// through the link flow (`events-link.ts`, through `LinkCtx`). The hub's messages out, as the mod's commands, are
// `events-commands.ts`'s (`toCommand`, `toGame`), its options and `EventsState` `events-options.ts`'s. Every name this
// file exported before is re-exported here.
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { EventBudget } from './events-budget.ts';
import { answeredOk } from './events-commands.ts';
import { parseDatagram, type GameEvent } from './events-datagram.ts';
import { HEAD_MAX, MAX_DATAGRAM, socketState, type Gate } from './events-gate.ts';
import { confirmOnline, type LinkCtx } from './events-link.ts';
import type { EventsOptions, EventsState } from './events-options.ts';
import { head } from './files.ts';
import type { UnitState } from './service.ts';
import { printable } from './wire.ts';

export { DROP_LOG_MS, EVENT_BURST, EVENT_RATE, EventBudget } from './events-budget.ts';
export { commandJson, toCommand, toGame } from './events-commands.ts';
export { deathMessage, parseDatagram, type Datagram, type GameEvent } from './events-datagram.ts';
export { ENGINE, MAX_DATAGRAM, openingLine, socketState, type Gate } from './events-gate.ts';
export type { EventsOptions, EventsState } from './events-options.ts';

/**
 * The mod's game events: a UDP listener on 127.0.0.1:`port` taking datagrams only from 127.0.0.1:`factorioPort`, and
 * only while the unit is active and, after each start, once `factorio-current.log` shows Factorio bound that port
 * itself (so no other local process took it first). A log not written since the agent saw the unit stopped (or, for
 * a restart between two readings, since the second after it became active) is the previous run's, which Factorio
 * has not replaced yet, so it is read again until it is. `Opening Lua UDP Socket failed`, or neither line within
 * 60 s, turns events off until the next start, logged once. A datagram over 4 KiB, or that isn't the mod's shape,
 * is dropped, each kind of drop logged once per start. Gaps in `seq` are logged; its baseline is the `hello` datagram
 * that `/orrery-hello` makes the mod send, once per start after the gate opens and RCON answers. Emits each event as
 * the game connection's message, within `EventBudget` (5 a second, 30 at once; the rest dropped, counted in the log
 * once a minute). A `link` or `unlink` for a player not online at the latest poll (who may have joined since) waits
 * for a fresh `/orrery-status`, and is dropped, each one logged, if that doesn't have them online either.
 *
 * Emits `state` on each change of whether events reach the hub: off (with why) once the gate is `off`, or while the
 * port can't be listened on past one retry; on once the gate is `on` with the port listened on. The first decision
 * since the agent started is a change too.
 */
export class GameEvents extends EventEmitter<{ event: [GameEvent]; state: [EventsState] }> {
  #o: Required<EventsOptions>;
  #socket: Socket | null = null;
  #bound: number | null = null;
  #retry: NodeJS.Timeout | undefined;
  #listenFailed = false;
  /** Why listening failed, while the latest two attempts in a row did (the first try and its retry); else null. */
  #listenWhy: string | null = null;
  #listenFailures = 0;
  /** Why the gate is `off`. */
  #offWhy = '';
  /** What `state` last said (null: nothing yet). */
  #told: boolean | null = null;
  #stopped = true;
  #unit: UnitState | null = null;
  /** When the agent last saw the unit with no Factorio running (inactive, failed or activating), since the last start. */
  #endedAt: number | null = null;
  #gate: Gate = 'closed';
  /** Counts starts and stops, so a log read or a hello from an earlier run is ignored. */
  #run = 0;
  #timer: NodeJS.Timeout | undefined;
  #helloTimer: NodeJS.Timeout | undefined;
  #hello: 'none' | 'sent' | 'answered' | 'came' = 'none';
  #last: number | null = null;
  #dropped = new Set<string>();
  #budget: EventBudget;
  #link: LinkCtx;

  constructor(options: EventsOptions) {
    super();
    this.#o = { deadlineMs: 60_000, pollMs: 1000, helloMs: 5000, retryMs: 10_000, now: () => performance.now(), ...options };
    this.#budget = new EventBudget(this.#o.now);
    this.#link = {
      run: (command) => this.#o.run(command),
      starts: () => this.#run,
      gate: () => this.#gate,
      emit: (event) => {
        this.emit('event', event);
      },
    };
  }

  get gate(): Gate {
    return this.#gate;
  }

  /** The UDP port listened on; null until it is bound. */
  get bound(): number | null {
    return this.#bound;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#listen();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#retry);
    this.#close();
    this.#socket?.close();
    this.#socket = null;
    this.#bound = null;
    this.#budget.flush();
  }

  /** The unit's state, on each change: a start (it became active, or its change time moved while active) opens a check of the log. */
  service(state: UnitState): void {
    const prev = this.#unit;
    this.#unit = state;
    if (state.active !== 'active') {
      if (state.active === 'inactive' || state.active === 'failed' || state.active === 'activating') this.#endedAt = Date.now();
      if (this.#gate !== 'closed') this.#close();
      return;
    }
    if (prev?.active === 'active' && prev.since === state.since) return; // the same run
    const freshAfter = this.#endedAt ?? state.since + 1000; // `since` is whole seconds
    this.#endedAt = null;
    this.#begin(freshAfter);
  }

  /** RCON answered `/orrery-status`: the first time after the gate opens, `/orrery-hello` asks the mod for its `seq`. */
  rconUp(): void {
    if (this.#gate !== 'on' || this.#hello !== 'none') return;
    this.#hello = 'sent';
    const run = this.#run;
    this.#o.run('/orrery-hello').then(
      (reply) => {
        if (run !== this.#run || this.#hello !== 'sent') return;
        this.#hello = 'answered';
        if (!answeredOk(reply)) return console.error(`[events] /orrery-hello answered ${printable(JSON.stringify(reply.slice(0, 200)))}`);
        this.#helloTimer = setTimeout(() => {
          console.error(`[events] no hello datagram came on UDP 127.0.0.1:${this.#o.port}: the mod sends to 34199 from ${this.#o.factorioPort}; are the ports right?`);
        }, this.#o.helloMs);
      },
      (err: Error) => {
        if (run !== this.#run) return;
        if (this.#hello === 'sent') this.#hello = 'none'; // RCON didn't run it: again at the next answer
        console.error(`[events] can't send /orrery-hello: ${err.message}`);
      },
    );
  }

  #listen(): void {
    if (this.#stopped) return;
    const socket = createSocket('udp4');
    this.#socket = socket;
    let bound = false;
    socket.on('message', (data, from) => this.#packet(data, from));
    socket.on('error', (err) => {
      if (bound) return console.error(`[events] UDP: ${err.message}`);
      try {
        socket.close();
      } catch {
        // never bound: nothing to close
      }
      if (this.#socket === socket) this.#socket = null;
      if (!this.#listenFailed) console.error(`[events] can't listen on UDP 127.0.0.1:${this.#o.port} (${err.message}): retrying`);
      this.#listenFailed = true;
      if (++this.#listenFailures >= 2) {
        this.#listenWhy = `the agent can't listen on UDP 127.0.0.1:${this.#o.port} (${err.message}), where the mod sends them: trying again every ${this.#o.retryMs / 1000} s`;
        this.#report();
      }
      if (!this.#stopped) this.#retry = setTimeout(() => this.#listen(), this.#o.retryMs);
    });
    socket.bind({ address: '127.0.0.1', port: this.#o.port }, () => {
      bound = true;
      this.#bound = socket.address().port;
      this.#listenFailed = false;
      this.#listenFailures = 0;
      this.#listenWhy = null;
      console.log(`[events] listening on UDP 127.0.0.1:${this.#bound}`);
      this.#report();
    });
  }

  /** Closes the gate: no events until the next start. */
  #close(): void {
    this.#run++;
    this.#gate = 'closed';
    clearTimeout(this.#timer);
    clearTimeout(this.#helloTimer);
    this.#dropped.clear();
  }

  #begin(freshAfter: number): void {
    this.#close();
    this.#gate = 'checking';
    this.#hello = 'none';
    this.#last = null; // the map may have rewound (a crash or a restore): the next hello is the baseline
    const run = this.#run;
    const until = Date.now() + this.#o.deadlineMs;
    const look = async (): Promise<void> => {
      // The previous run's log (written before `freshAfter`) is no answer: read again until Factorio replaces it.
      const text = await head(this.#o.log, HEAD_MAX, freshAfter);
      if (run !== this.#run) return;
      const state = text === null ? null : socketState(text, this.#o.factorioPort);
      // check-events.ts (S4) reads this line, the "off" one below, and the hello lines from agent.log: keep their wording.
      if (state === 'on') {
        this.#gate = 'on';
        console.log(`[events] on: Factorio opened its Lua UDP socket on 127.0.0.1:${this.#o.factorioPort}`);
        return this.#report();
      }
      if (state === 'off' || Date.now() >= until) {
        this.#gate = 'off';
        const why =
          state === 'off'
            ? `Factorio could not open its Lua UDP socket (is 127.0.0.1:${this.#o.factorioPort} taken?)`
            : `no "Opening socket" line for 127.0.0.1:${this.#o.factorioPort} in ${this.#o.log} within ${this.#o.deadlineMs / 1000} s`;
        console.error(`[events] game events are off until Factorio starts again: ${why}`);
        this.#offWhy = `${why}: off until Factorio starts again`;
        return this.#report();
      }
      this.#timer = setTimeout(() => void look(), this.#o.pollMs);
    };
    void look();
  }

  /** Emits `state` when whether events reach the hub changed: off while listening fails or the gate is off, on once both are fine. */
  #report(): void {
    const why = this.#listenWhy ?? (this.#gate === 'off' ? this.#offWhy : null);
    if (why !== null) {
      if (this.#told === false) return;
      this.#told = false;
      return void this.emit('state', { on: false, reason: why });
    }
    if (this.#gate !== 'on' || this.#bound === null || this.#told === true) return;
    this.#told = true;
    this.emit('state', { on: true });
  }

  #drop(kind: string, why: string): void {
    if (this.#dropped.has(kind)) return;
    this.#dropped.add(kind);
    console.log(`[events] dropped a datagram: ${why} (logged once until Factorio starts again)`);
  }

  #packet(data: Buffer, from: RemoteInfo): void {
    const port = this.#o.factorioPort;
    if (from.family !== 'IPv4' || from.address !== '127.0.0.1' || from.port !== port) {
      return this.#drop('source', `from ${from.address}:${from.port}, not Factorio's 127.0.0.1:${port}`);
    }
    if (this.#gate !== 'on') {
      const why = { closed: 'the server is not running', checking: "Factorio's Lua UDP socket is not confirmed yet", off: 'game events are off' }[this.#gate];
      return this.#drop('gate', why);
    }
    if (data.length > MAX_DATAGRAM) return this.#drop('size', `${data.length} bytes, over ${MAX_DATAGRAM}`);
    const d = parseDatagram(data);
    if (typeof d === 'string') return this.#drop(d, d);
    this.#seq(d.seq, d.event === null);
    const event = d.event;
    if (!event) return;
    // Over the budget: counted, and its seq taken above, so no gap is logged. Taken before a fresh /orrery-status
    // too, so a flood of links for names not online can't flood RCON.
    if (!this.#budget.take()) return;
    if ((event.type === 'link' || event.type === 'unlink') && !this.#o.players().includes(event.player)) return void confirmOnline(this.#link, event);
    this.emit('event', event);
  }

  #seq(seq: number, hello: boolean): void {
    const last = this.#last;
    this.#last = seq;
    if (hello) {
      // The mod's hello is the last event's seq, not one of its own: the next event is seq + 1.
      clearTimeout(this.#helloTimer);
      if (this.#hello !== 'came') console.log(`[events] the mod's hello came: seq ${seq}`);
      this.#hello = 'came';
      return;
    }
    if (last === null || seq === last + 1) return;
    if (seq > last + 1) {
      const lost = seq - last - 1;
      console.log(`[events] ${lost} game event${lost === 1 ? '' : 's'} lost: seq ${lost === 1 ? last + 1 : `${last + 1} to ${seq - 1}`} never came`);
    }
    else console.log(`[events] seq went back from ${last} to ${seq}`);
  }
}

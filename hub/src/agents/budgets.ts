// The Agent port's budgets, for `Agents`: the one table of them (docs/protocol.md, "Rate rules"). The line budget
// (`LINES`, a token bucket: 20 lines/s in bursts of 100; lines over it are dropped, and a connection still dropping
// 10 s on is closed), before and after the handshake, then each parsed message within its type's budget in that
// connection (both budgets kept per connection, not per socket: the Agent connection's by its Agent's id, the game
// connection's by its server's, a first line's by its peer address, so a reconnect goes on with what the last one
// left; `TYPES`: game events together 2/s in bursts of 30, `link`/`unlink` 1/s in 5, `updateStep` 5/s in 20,
// `serviceState`, `saves`, `installed` and `settings` each 1/s in 10 and dropped when deep-equal to the last one of
// their type passed on (`SAME`), `heartbeat` 1/s in 5, `backup` 1 per 10 s in 3, `events` 1 per 10 s in 3 taken only
// by a change; others only the line budget, none of which posts or stores per line; over it dropped, the connection
// kept; and `NEW_PLAYERS`: a heartbeat's names not on its server's player list yet, 1 per 10 s in bursts of 200, a
// name over it left out of that heartbeat, so churning names, or reconnecting (the list is empty while offline), can't
// make playtime sessions faster), drops logged at most once a minute with the count since the last line
// (`everyMinute`, exported for its test: the first at once, later ones summed and logged when the minute is up, by a
// timer once drops stop, cleared by `close`); a host sample at most one per 10 s per Agent (`SAMPLE_MS`). Its
// throttles by the hub's clock (drop logs, and through `ago` the handshakes and host samples of `Agents`) treat a time
// before their last stamp, a clock stepped back, as long after it. Hub core.

import type { Socket } from 'node:net';
import { isDeepStrictEqual } from 'node:util';
import { LIMITS } from '../protocol.ts';

export type Rate = { perSecond: number; burst: number; overMs: number };

/*
 * The Agent port's budgets (docs/protocol.md, "Rate rules"). The Agent stays under them, except that it forwards game
 * events at up to 5 a second, so the hub drops a busy server's game events over 2 a second; they are the hub's safety
 * net against a token holder, so what a connection can make the hub store, post or stream stays small.
 *
 * - `LINES`: every line of a connection (an Agent's or a game one, each its own), before and after the handshake. A
 *   line over it is dropped; a connection still dropping lines 10 s on is closed.
 * - `TYPES`: a message type's own token bucket within its connection, shared by the types listed together (the game
 *   events), one each otherwise. A message over it is dropped and its connection stays. A type not listed has only
 *   `LINES`, and none of those makes the hub post or store per line: `started` counts once per connection, `stopping`
 *   only marks its close a stop, `cmdResult` and `reply` only answer what waits for them, and `updateDone` and
 *   `deployResult` are each taken once: the one its update (by id) or deploy (by tag) waits for, then no more.
 * - `NEW_PLAYERS`: names a game connection's heartbeat adds to its server's player list (not on it already), each a
 *   playtime session row: one over it is left out of that heartbeat, to come in a later one. Its burst is a full list,
 *   so a reconnect's first heartbeat (the list is empty while offline) passes whole.
 * - `SAME`: a push deep-equal to the last one of its type passed on from its connection is dropped before its budget
 *   (the hub already holds it).
 * - `SAMPLE_MS`: at most one host sample per 10 s per Agent (whatever its connections), stored with the hub's clock as
 *   its `ts`: an Agent's clock is never trusted for what is stored.
 *
 * `LINES`, `TYPES` and `NEW_PLAYERS` belong to the connection, not its socket: the Agent connection's are kept by its
 * Agent's id and the game connection's by its server's, so one that replaces another goes on with what that one left
 * (reconnecting never starts a fresh burst); a first line, before anyone is known, takes from its peer address's.
 * `HANDSHAKE_MS`: a connection is welcomed at most once per 5 s (each kind for each Agent), so reconnecting can't churn
 * the server's connected and crashed events either. `SAME` stays its socket's: the first push after a reconnect is
 * always taken.
 *
 * Drops are logged at most once a minute (per connection, per budget), with how many since the last log.
 */
export const LINES = { perSecond: 20, burst: 100, overMs: 10_000 };
const TYPES: { name: string; types: string[]; perSecond: number; burst: number }[] = [
  { name: 'game events', types: ['chat', 'join', 'leave', 'death', 'milestone'], perSecond: 2, burst: 30 },
  { name: 'link', types: ['link', 'unlink'], perSecond: 1, burst: 5 },
  { name: 'updateStep', types: ['updateStep'], perSecond: 5, burst: 20 },
  { name: 'serviceState', types: ['serviceState'], perSecond: 1, burst: 10 },
  { name: 'saves', types: ['saves'], perSecond: 1, burst: 10 },
  { name: 'installed', types: ['installed'], perSecond: 1, burst: 10 },
  { name: 'settings', types: ['settings'], perSecond: 1, burst: 10 },
  // Its Agent sends one per RCON round trip (5 s): 1 a second bounds its `paused` changes and TPS events.
  { name: 'heartbeat', types: ['heartbeat'], perSecond: 1, burst: 5 },
  // One per Save now, or per 6 h of play: each one is a notice posted to Discord.
  { name: 'backup', types: ['backup'], perSecond: 1 / 10, burst: 3 },
  // Taken only by a change (a repeat, such as the one it sends on each connect, posts nothing and takes none): each
  // change is a notice posted to Discord, and an Agent's come at most once per Factorio start.
  { name: 'events on or off', types: ['events'], perSecond: 1 / 10, burst: 3 },
];
const NEW_PLAYERS = { name: 'new players', perSecond: 1 / 10, burst: LIMITS.players };
const BUDGET_OF = new Map(TYPES.flatMap((b) => b.types.map((type) => [type, b] as const)));
const SAME = new Set(['serviceState', 'saves', 'installed', 'settings']);
export const SAMPLE_MS = 10_000;
const LOG_MS = 60_000;

/** How long ago `stamp` was by the hub's clock, `now`: as long ago as can be if the clock has stepped back past it. */
export const ago = (now: number, stamp: number) => (now < stamp ? Infinity : now - stamp);

/** The timers of `everyMinute`'s pending logs, which `Agents.close` clears; after `close`, none is set. */
export type DropLogs = { timers: Set<NodeJS.Timeout>; closed: boolean };

/**
 * Counts drops and logs them at most once a minute, `say(count)` with the drops since the last line: the first at
 * once, later ones summed and logged when the minute is up (at the next drop then, or by a timer in `logs`).
 */
export function everyMinute(say: (count: number) => string, logs: DropLogs): () => void {
  let count = 0;
  let at = -Infinity;
  let timer: NodeJS.Timeout | undefined;
  const log = () => {
    if (timer) logs.timers.delete(timer);
    clearTimeout(timer);
    timer = undefined;
    console.error(say(count));
    at = Date.now();
    count = 0;
  };
  return () => {
    count++;
    const wait = LOG_MS - ago(Date.now(), at);
    if (wait <= 0) return log();
    if (timer || logs.closed) return;
    timer = setTimeout(log, wait).unref();
    logs.timers.add(timer);
  };
}

/** A token bucket: whether one more fits now, `perSecond` refilled up to `burst` (a clock stepping back adds none). */
function bucket(perSecond: number, burst: number): (now: number) => boolean {
  let tokens = burst;
  let last = Date.now();
  return (now) => {
    tokens = Math.min(burst, tokens + (Math.max(0, now - last) * perSecond) / 1000);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

/**
 * A connection's budgets, which outlive its sockets (`Agents` keeps one per Agent connection, game connection and peer
 * address): `lines(socket)` whether a line may be handled now (`LINES`: lines over it are dropped, logged at most once
 * a minute, and a connection still dropping lines `overMs` after its first drop, with no drop-free second between, has
 * `socket` closed); `fits(type)` whether a message of `type` is within its type's budget (`TYPES`), and `newPlayer()`
 * whether one more name may join its server's player list (`NEW_PLAYERS`), each else counted by `dropped`;
 * `dropped(name)` counts a message (or a name) dropped over budget `name`, logged at most once a minute. `label`
 * names it in the logs.
 */
export type Budget = { lines: (socket: Socket) => boolean; fits: (type: string) => boolean; newPlayer: () => boolean; dropped: (name: string) => void };

export function budget(label: string, rate: Rate, drops: DropLogs): Budget {
  const take = bucket(rate.perSecond, rate.burst);
  const logLines = everyMinute((n) => `[agents] ${label}: over ${rate.perSecond} lines/s, dropping lines (${n} dropped)`, drops);
  let overSince = 0;
  let lastDrop = 0;
  const lines = (socket: Socket) => {
    const now = Date.now();
    if (take(now)) {
      if (overSince && now - lastDrop >= 1000) overSince = 0;
      return true;
    }
    logLines();
    lastDrop = now;
    overSince ||= now;
    if (now - overSince >= rate.overMs) {
      console.error(`[agents] ${label}: over the line rate for ${rate.overMs / 1000} s, closing`);
      socket.destroy();
    }
    return false;
  };
  const buckets = new Map<string, (now: number) => boolean>();
  const logs = new Map<string, () => void>();
  const dropped = (name: string) => {
    let log = logs.get(name);
    if (!log) logs.set(name, (log = everyMinute((n) => `[agents] ${label}: over the ${name} budget, dropped ${n}`, drops)));
    log();
  };
  const takes = (of: { name: string; perSecond: number; burst: number }) => {
    let takeOne = buckets.get(of.name);
    if (!takeOne) buckets.set(of.name, (takeOne = bucket(of.perSecond, of.burst)));
    if (takeOne(Date.now())) return true;
    dropped(of.name);
    return false;
  };
  const fits = (type: string) => {
    const of = BUDGET_OF.get(type);
    return !of || takes(of);
  };
  return { lines, fits, newPlayer: () => takes(NEW_PLAYERS), dropped };
}

/**
 * A connection's per-type budgets on one socket: `allows(msg)` whether a parsed message may be handled now, false for
 * a push deep-equal to the last one of its type this socket passed on (`SAME`, silently: so the first after a
 * reconnect is always taken) or one over its type's budget (`budget.fits`, counted); `dropped` is `budget`'s.
 */
export function connBudgets(budget: Budget): { allows: (msg: { type: string }) => boolean; dropped: (name: string) => void } {
  const last = new Map<string, unknown>();
  const allows = (msg: { type: string }) => {
    const same = SAME.has(msg.type);
    if (same && isDeepStrictEqual(last.get(msg.type), msg)) return false;
    if (!budget.fits(msg.type)) return false;
    if (same) last.set(msg.type, msg);
    return true;
  };
  return { allows, dropped: budget.dropped };
}

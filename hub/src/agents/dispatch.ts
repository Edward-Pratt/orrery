// What a welcomed connection's lines do, for `Agents`. An Agent connection's (`agentLine`): each line refreshes its
// silence timer (an Agent with no line for 20 s is lost), junk is ignored, and each message is taken within its type's
// budget (`events` from its own only on a change); `bye` is a planned exit; a `hostSample` goes to its Host's
// `HostMonitor` (`Hosts`, by the Agent's id), at most one per 10 s per Agent across its connections (`SAMPLE_MS`), its
// `ts` replaced by the hub's clock; an Agent's `events` (whether its server's game events reach the hub) posts an
// `eventsOff` host notice (its `reason`) or `eventsOn` only when it changes what the hub last heard from that Agent
// (kept while it is away), so its send on every connect posts nothing; a `reply` settles the request waiting for it
// (`Conn.pending`, by id): refused (`AgentRefused`, its `error`: an `ok: false` reply), an ok reply's data through
// `parseReplyData`, malformed rejected, late or unknown ignored; what it pushes (`serviceState`, `saves`,
// `installed`, `updateStep`, `updateDone`, `deployResult`, `settings`, each the parser's schema-only copy) goes on
// the `Agents` emitter. Requests (`ask`): each waits in `pending` under its id, rejected after its timeout or, when its
// connection closes, by `dropPending`. A game connection's heartbeat (`newPlayers`): only as many names new to its
// server's player list as `NEW_PLAYERS` has room for. Hub core.

import type { Socket } from 'node:net';
import type { AgentConfig } from '../config.ts';
import type { Hosts } from './host.ts';
import { parseAgentLine, parseReplyData, REPLY_WITH_DATA, type AgentMsg, type AgentReplyData, type AgentRequest, type ModMsg } from '../protocol.ts';
import type { ServerHub } from '../servers/servers.ts';
import { ago, SAMPLE_MS, type Budget, type connBudgets } from './budgets.ts';
import { send } from './listener.ts';
import { AgentRefused, type AgentAnswer, type AgentCall, type Pushed } from './public.ts';

export type Waiting = { request: AgentRequest['type']; resolve: (data: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };
type Budgets = ReturnType<typeof connBudgets>;
export type Conn = { socket: Socket; bye: boolean; silence: NodeJS.Timeout; pending: Map<string, Waiting>; budgets: Budgets };

/** What `agentLine` needs of `Agents`: its hub and Hosts, its maps of every Agent (by reference) and its emitter. */
export type Dispatch = {
  hub: Pick<ServerHub, 'publishTarget'>;
  hosts: Pick<Hosts, 'get'>;
  sampled: Map<string, number>; // when each Agent's latest stored host sample came (the hub's clock)
  eventsOff: Set<string>; // the Agents whose game events are off, as the latest `events` each sent said
  emit: (event: Pushed['type'], id: string, msg: Pushed) => boolean;
};

export function agentLine(cfg: AgentConfig, conn: Conn, line: string, { hub, hosts, sampled, eventsOff, emit }: Dispatch): void {
  conn.silence.refresh();
  const msg = parseAgentLine(line);
  // Junk after the handshake is ignored; over its budget, dropped (`events` takes from its own only on a change).
  if (!msg || (msg.type !== 'events' && !conn.budgets.allows(msg))) return;
  switch (msg.type) {
    case 'agentHello':
    case 'hello': // first lines only
    case 'ping':
      return;
    case 'bye':
      conn.bye = true;
      return void conn.socket.destroy(); // a planned exit: its server is lost, nothing posted
    case 'hostSample': {
      // Per Agent, not per connection, so reconnecting never lets more in; stored with the hub's clock, never the Agent's.
      const now = Date.now();
      if (ago(now, sampled.get(cfg.id) ?? -Infinity) < SAMPLE_MS) return conn.budgets.dropped('hostSample');
      sampled.set(cfg.id, now);
      return hosts.get(cfg.id)?.record({ ...msg.sample, ts: now });
    }
    case 'events':
      return events(cfg, conn, msg, eventsOff, hub);
    case 'reply':
      return reply(conn, msg);
    default: // what it pushes: serviceState, saves, installed, updateStep, updateDone, deployResult, settings
      emit(msg.type, cfg.id, msg);
  }
}

/**
 * Its server's game events went off or came back on: one host notice per change the hub hears, within the `events`
 * budget (one over it is dropped, so the hub hears of it at the next change or connect). A repeat (the Agent sends
 * its state on each connect) posts nothing and takes no budget; the hub keeps what it heard while the Agent is away.
 */
function events(cfg: AgentConfig, conn: Conn, msg: Extract<AgentMsg, { type: 'events' }>, eventsOff: Set<string>, hub: Dispatch['hub']): void {
  const off = eventsOff.has(cfg.id);
  if (msg.on !== off || !conn.budgets.allows(msg)) return; // no change, or over its budget
  const at = { target: 'host', id: cfg.id, type: 'notice', name: cfg.name } as const;
  if (msg.on) {
    eventsOff.delete(cfg.id);
    return hub.publishTarget({ ...at, severity: 'good', kind: 'eventsOn' });
  }
  eventsOff.add(cfg.id);
  hub.publishTarget({ ...at, severity: 'warning', kind: 'eventsOff', reason: msg.reason ?? 'no reason given' });
}

/** Sends `call` as request `id` on an Agent connection and waits for its reply (`reply`), or `timeoutMs`. */
export function ask<C extends AgentCall>(conn: Conn, agentId: string, call: C, id: string, timeoutMs: number): Promise<AgentAnswer<C['type']>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`agent ${agentId} did not answer in time`));
    }, timeoutMs);
    conn.pending.set(id, { request: call.type, resolve: resolve as (data: unknown) => void, reject, timer });
    send(conn.socket, { ...call, id } as AgentRequest);
  });
}

function reply(conn: Conn, msg: Extract<AgentMsg, { type: 'reply' }>): void {
  const waiting = conn.pending.get(msg.id);
  if (!waiting) return; // late or unknown
  conn.pending.delete(msg.id);
  clearTimeout(waiting.timer);
  if (!msg.ok) return waiting.reject(new AgentRefused(msg.error ?? `${waiting.request} refused`));
  if (!REPLY_WITH_DATA.has(waiting.request)) return waiting.resolve(undefined);
  const data = parseReplyData(waiting.request as keyof AgentReplyData, msg.data);
  if (data === null) return waiting.reject(new Error(`the agent's ${waiting.request} reply is malformed`));
  waiting.resolve(data);
}

/** Rejects every request still waiting on an Agent connection that closed. */
export function dropPending(conn: Conn, agentId: string): void {
  for (const waiting of conn.pending.values()) {
    clearTimeout(waiting.timer);
    waiting.reject(new Error(`agent ${agentId} disconnected`));
  }
  conn.pending.clear();
}

/**
 * A heartbeat with only as many names new to its server's player list (not on it now: none are while it is offline)
 * as `NEW_PLAYERS` has room for, the others left out until a later heartbeat: so fresh names can't make playtime
 * sessions faster than that, whether they replace each other or come back after a reconnect.
 */
export function newPlayers(hub: Pick<ServerHub, 'get'>, serverId: string, budget: Budget, beat: Extract<ModMsg, { type: 'heartbeat' }>): ModMsg {
  const on = new Set(hub.get(serverId)?.players);
  const players = beat.players.filter((name) => on.has(name) || budget.newPlayer());
  return players.length === beat.players.length ? beat : { ...beat, players };
}

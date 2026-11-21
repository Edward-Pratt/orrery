// What `ServerHub`'s flows outside the class share with it (`ServerCtx`): its options, its maps and sets (by
// reference), whether the Mod port is open and whether the hub is closing (scalars, so they live here and the class
// reads and writes them here), the raw `event` emit and the audit; the config and option types callers import from
// `servers.ts`; a game connection's own state (`Conn`, its pending commands) and late output's handlers; and `send`,
// one line of JSON to a game connection. Hub core.

import type { Socket } from 'node:net';
import type { HubMsg } from '../protocol.ts';
import type { AuditEntry, Game, HubEvent, ServerState } from '../types.ts';
import type { LifecycleBudget } from './lifecycle-budget.ts';

/** No token: the server can't connect (the Minecraft integration is off, or it isn't a minecraft server). */
export type ServerConfig = { id: string; name: string; game: Game; token?: string };

export type HubOptions = {
  hungMs?: number;
  cmdTimeoutMs?: number;
  helloTimeoutMs?: number;
  graceMs?: number;
  lateMs?: number;
  /**
   * How long a factorio server's game connection that closed without `stopping`, while its Agent connection is up,
   * waits for that one to close too (then its Agent is lost, not the server crashed).
   */
  settleMs?: number;
  /** Where audit entries go (the hub's database). */
  audit?: (entry: AuditEntry) => void;
};

export type Late = { command: string; by: string; onLate?: (output: string[]) => void; timer: NodeJS.Timeout };

export type Pending = { resolve: (output: string[]) => void; reject: (err: Error) => void; timer: NodeJS.Timeout };
export type Conn = {
  socket: Socket;
  stopping: boolean;
  lastBeat: number;
  hung: boolean;
  pending: Map<string, Pending>;
  /** The last TPS put on the event stream. */
  sentTps: number | null;
  /** Its `started` is on the stream: one per connection (a Mod's server starts once per connection anyway). */
  started: boolean;
};

/** What the flows need of `ServerHub`: see the header. */
export type ServerCtx = {
  // The class's own, by reference: see `ServerHub`.
  configs: Map<string, ServerConfig>;
  states: Map<string, ServerState>;
  conns: Map<string, Conn>;
  modVersions: Map<string, string>;
  downs: Map<string, number>;
  agentsUp: Set<string>;
  settling: Map<string, NodeJS.Timeout>;
  lifecycle: Map<string, LifecycleBudget>;
  late: Map<string, Late>;
  listening: boolean; // the Mod port is open: without it a minecraft server has no way to connect
  closing: boolean;
  hungMs: number;
  cmdTimeoutMs: number;
  lateMs: number;
  helloTimeoutMs: number;
  settleMs: number;
  /** The class's `this.emit('event', e)`. */
  emit: (e: HubEvent) => void;
  /** The class's `audit`. */
  audit: (actor: string, action: string, target: string, details?: string) => void;
};

export function send(socket: Socket, msg: HubMsg): void {
  socket.write(JSON.stringify(msg) + '\n');
}

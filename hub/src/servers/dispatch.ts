// What a game connection's messages do (`handle`, each already parsed by `parseModLine`) and hung detection over their
// heartbeats (`checkHung`), over `ServerHub`'s state (`ServerCtx`). A heartbeat sets the state's TPS, players and
// dims, and arms hung detection; `paused` (only an Agent's heartbeat has it) is put on each `ServerState`, a change
// emitted as `paused`; while paused the rate is ignored, not put on the state or the stream, but heartbeats still count
// for hung detection; `tps` is emitted when the TPS moved by 0.1 or more. `started` is emitted once per connection, a
// repeat on it ignored. A command's result resolves its pending command; late output (`cmdLate`) goes on the stream as
// `console` with `late` and to its `onLate`. Every other message is a game event with its server's id. Hung detection
// is off only while a factorio server's Agent is away, and after `stopping`. Hub core.

import type { ModMsg } from '../protocol.ts';
import { emitLifecycle } from './lifecycle-budget.ts';
import type { Conn, ServerCtx } from './server-ctx.ts';

export function handle(c: ServerCtx, id: string, conn: Conn, msg: ModMsg): void {
  const state = c.states.get(id)!;
  switch (msg.type) {
    case 'heartbeat':
      conn.lastBeat = Date.now(); // paused or not: a frozen game stops them, so hung detection stays on
      if ((msg.paused === true) !== state.paused) {
        // Only an Agent's heartbeat has `paused`; the card shows it, so a change goes on the stream.
        state.paused = msg.paused === true;
        c.emit({ serverId: id, type: 'paused', paused: state.paused });
      }
      if (!state.paused) {
        // While paused the rate means nothing: it is left out of the state and the stream (and so of lag and history).
        if (conn.sentTps === null || Math.abs(msg.tps - conn.sentTps) >= 0.1) {
          conn.sentTps = msg.tps;
          c.emit({ serverId: id, type: 'tps', tps: msg.tps });
        }
        state.tps = msg.tps;
      }
      state.players = msg.players;
      state.dims = msg.dims ?? [];
      if (conn.hung) {
        conn.hung = state.hung = false;
        emitLifecycle(c, id, 'recovered');
      }
      return;
    case 'started':
      if (conn.started) return; // a repeat would be another lifecycle row and another post for one start
      conn.started = true;
      return emitLifecycle(c, id, 'started');
    case 'stopping':
      conn.stopping = true;
      return;
    case 'cmdResult': {
      const p = conn.pending.get(msg.id);
      if (!p) return; // late or unknown id
      conn.pending.delete(msg.id);
      clearTimeout(p.timer);
      return p.resolve(msg.output);
    }
    case 'cmdLate': {
      const late = c.late.get(msg.id);
      if (!late) return; // expired or unknown
      c.emit({ serverId: id, type: 'console', command: late.command, by: late.by, output: msg.output, late: true });
      try {
        late.onLate?.(msg.output);
      } catch (err) {
        console.error('[hub] late output handler failed:', err);
      }
      return;
    }
    default:
      // `msg` is parseModLine's copy of only the schema's fields; serverId last: a mod can't speak for another server.
      c.emit({ ...msg, serverId: id });
  }
}

export function checkHung(c: ServerCtx): void {
  const now = Date.now();
  for (const [id, conn] of c.conns) {
    // A factorio server whose Agent is lost has its own one host notice instead (its connection is dropped anyway).
    if (c.states.get(id)!.game === 'factorio' && !c.agentsUp.has(id)) continue;
    // Armed by the first heartbeat (world load sends none) and disarmed by `stopping` (shutdown save).
    if (conn.hung || conn.stopping || conn.lastBeat === 0 || now - conn.lastBeat < c.hungMs) continue;
    conn.hung = true;
    c.states.get(id)!.hung = true;
    emitLifecycle(c, id, 'hung');
  }
}

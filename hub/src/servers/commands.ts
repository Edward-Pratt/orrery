// A console command to a server's game connection (`runCommand`, over `ServerHub`'s state, `ServerCtx`): control
// characters taken out; a Mod's command without a leading `/`, a factorio server's as typed, `/players`, and at most
// 256 characters, as its Agent runs no longer one: else `CommandRefused`, before it is audited or sent. Audited as
// `command`, it resolves with its output (put on the stream as `console`) or rejects on a timeout or a disconnect;
// output that comes after the result goes to `onLate` for `lateMs` (15 min). `servers.ts` re-exports
// `CommandRefused`. Hub core.

import { randomUUID } from 'node:crypto';
import { LIMITS } from '../protocol.ts';
import { send, type ServerCtx } from './server-ctx.ts';

/**
 * A console command its server's game connection would not take, refused before it is audited or sent: a factorio
 * server's over `LIMITS.text` (256) characters, which its Agent refuses (docs/protocol.md, `cmd`).
 */
export class CommandRefused extends Error {}

/** `ServerHub.runCommand`: see there. */
export function runCommand(c: ServerCtx, id: string, command: string, by: string, onLate?: (output: string[]) => void): Promise<string[]> {
  const conn = c.conns.get(id);
  if (!conn) return Promise.reject(new Error(`${c.states.get(id)?.name ?? id} is offline`));
  const typed = command.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  const factorio = c.states.get(id)!.game === 'factorio';
  const cmd = factorio ? typed : typed.replace(/^\//, '');
  if (!cmd) return Promise.reject(new Error('empty command'));
  if (factorio && cmd.length > LIMITS.text) {
    return Promise.reject(new CommandRefused(`A Factorio console command is at most ${LIMITS.text} characters`));
  }
  c.audit(by, 'command', id, cmd);
  const cmdId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(cmdId);
      reject(new Error('command timed out — it may still run when the server responds'));
    }, c.cmdTimeoutMs);
    conn.pending.set(cmdId, {
      resolve: (output) => {
        c.late.set(cmdId, { command: cmd, by, onLate, timer: setTimeout(() => c.late.delete(cmdId), c.lateMs) });
        c.emit({ serverId: id, type: 'console', command: cmd, by, output });
        resolve(output);
      },
      reject,
      timer,
    });
    send(conn.socket, { type: 'cmd', id: cmdId, command: cmd });
  });
}

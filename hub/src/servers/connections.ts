// A game connection's life, over `ServerHub`'s state (`ServerCtx`); the sockets and the listener stay the class's. A
// Mod's on the Mod port (`readHandshake`): every line through `parseModLine`, the first a hello within
// `helloTimeoutMs`, else the socket is destroyed; a hello refused (`checkHello`: its protocol out of range, an unknown
// server or a bad token, compared with `timingSafeEqual`) gets a `reject`; junk after the handshake is ignored. An
// accepted one, a Mod's or an Agent's (`open`), is welcomed and its server online, replacing an older one without an
// alert, its messages handled by `dispatch.ts`. When it closes (`closed`): `stopping` first is a stop, else a crash;
// but one an Agent's, closing while that Agent connection is up, waits `settleMs` (5 s) for that one to close too
// (then the Agent is lost, `agentDown`), else it crashed (`settle`). `offline` counts each going away in `downs`.
// Hub core.

import type { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { parseModLine, type Hello, type ModMsg } from '../protocol.ts';
import { handle } from './dispatch.ts';
import { emitLifecycle } from './lifecycle-budget.ts';
import { send, type Conn, type ServerCtx } from './server-ctx.ts';
import { protocolRefusal, tokenMatches } from './server-text.ts';

/** A socket accepted on the Mod port, until its hello is accepted or refused; `onClose` runs first on its `close`. */
export function readHandshake(c: ServerCtx, socket: Socket, onClose: () => void): void {
  let onMsg: ((msg: ModMsg) => void) | null = null;
  socket.on('error', () => {}); // 'close' always follows and does the cleanup
  const helloTimer = setTimeout(() => socket.destroy(), c.helloTimeoutMs);
  const lines = createInterface({ input: socket, crlfDelay: Infinity });
  lines.on('error', () => {});
  lines.on('line', (line) => {
    if (socket.destroyed || socket.writableEnded) return;
    const msg = parseModLine(line);
    if (onMsg) {
      if (msg && msg.type !== 'hello') onMsg(msg); // junk after handshake is ignored
      return;
    }
    clearTimeout(helloTimer);
    if (msg?.type !== 'hello') return void socket.destroy();
    const reason = checkHello(c, msg);
    if (reason) {
      send(socket, { type: 'reject', reason });
      return void socket.end();
    }
    onMsg = open(c, socket, msg.serverId, msg.modVersion);
  });
  socket.on('close', () => {
    onClose();
    clearTimeout(helloTimer);
  });
}

/** Makes an accepted game connection its server's: welcomed, online, and its messages handled from then on. */
export function open(c: ServerCtx, socket: Socket, id: string, modVersion: string): (msg: ModMsg) => void {
  settle(c, id); // a crash waiting on the Agent is decided before the new connection counts
  const conn: Conn = { socket, stopping: false, lastBeat: 0, hung: false, pending: new Map(), sentTps: null, started: false };
  const old = c.conns.get(id);
  c.conns.set(id, conn);
  old?.socket.destroy();
  Object.assign(c.states.get(id)!, { online: true, hung: false });
  c.modVersions.set(id, modVersion); // before `connected`, which a Mod deploy waits on
  send(socket, { type: 'welcome' });
  emitLifecycle(c, id, 'connected');
  socket.on('close', () => closed(c, id, conn));
  return (msg) => {
    if (!socket.destroyed && !socket.writableEnded) handle(c, id, conn, msg);
  };
}

function closed(c: ServerCtx, id: string, conn: Conn): void {
  for (const p of conn.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error('server disconnected'));
  }
  conn.pending.clear();
  if (c.conns.get(id) !== conn) return; // replaced by a newer connection, or dropped with its Agent: no alert
  c.conns.delete(id);
  offline(c, id);
  if (c.closing) return;
  if (conn.stopping) return emitLifecycle(c, id, 'stopped');
  if (!c.agentsUp.has(id)) return emitLifecycle(c, id, 'crashed');
  // An Agent's game connection, with the Agent connection still up: if that one closes too, the Agent is lost.
  c.settling.set(
    id,
    setTimeout(() => settle(c, id), c.settleMs),
  );
}

/** Decides a game connection waiting on its Agent (see `closed`): a crash. */
function settle(c: ServerCtx, id: string): void {
  const timer = c.settling.get(id);
  if (!timer) return;
  clearTimeout(timer);
  c.settling.delete(id);
  emitLifecycle(c, id, 'crashed');
}

export function offline(c: ServerCtx, id: string): void {
  c.downs.set(id, (c.downs.get(id) ?? 0) + 1);
  Object.assign(c.states.get(id)!, { online: false, hung: false, paused: false, tps: null, players: [], dims: [] });
}

function checkHello(c: ServerCtx, hello: Hello): string | null {
  const refused = protocolRefusal(hello.protocol);
  if (refused) return refused;
  const cfg = c.configs.get(hello.serverId);
  if (!cfg?.token || !tokenMatches(cfg.token, hello.token)) return 'unknown serverId or bad token';
  return null;
}

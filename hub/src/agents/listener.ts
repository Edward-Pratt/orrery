// The Agent port's sockets, for `Agents`. `accept`: a connection is paused at accept and destroyed without a word
// unless its peer address is a configured Agent's and has fewer than 4 open (`PEER_SOCKETS`, handshaken or not; the
// fifth logged at most once a minute, by `tooMany`), so nothing is read first; its lines are read from raw chunks
// with `LIMITS.lineBytes` as the cap (`readLines`: a longer one destroys it) and its line budget, before and after
// the handshake; a line whose handling throws ends only its own connection. Its first line, within 5 s
// (`helloTimeoutMs`), goes to `agentHello` or `gameHello`, whose `Next` is the line budget and the handler of its next
// lines; any other first line destroys it. `reject` refuses a first line: its `reject`, then the connection is ended
// and destroyed within 2 s whatever the peer does. `send` writes one message as a line. Hub core.

import type { Socket } from 'node:net';
import { LIMITS, parseAgentLine, type AgentHello, type Hello, type HubAgentMsg } from '../protocol.ts';
import type { Budget } from './budgets.ts';

/** What a first line leads to: the line budget the connection's next lines take from, and what handles them. */
export type Next = { lines: Budget['lines']; onLine: (line: string) => void };

/** Connections at once from one peer address, handshaken or not: an Agent connection, a game connection, two spare. */
export const PEER_SOCKETS = 4;
/** How long a refused connection may take to close after its `reject`, whatever the peer does. */
const END_MS = 2_000;
const ignore = () => {};

/** What `accept` needs of `Agents`: its address check, its open sockets and counts (by reference) and its first lines. */
export type Port = {
  addresses: Set<string>;
  perPeer: Map<string, number>; // open connections by peer address, handshaken or not
  sockets: Set<Socket>;
  tooMany: () => void;
  helloTimeoutMs: number;
  budget: (key: string) => Budget;
  agentHello: (socket: Socket, peer: string, hello: AgentHello) => Next;
  gameHello: (socket: Socket, peer: string, hello: Hello) => Next;
};

export function accept(socket: Socket, { addresses, perPeer, sockets, tooMany, helloTimeoutMs, budget, agentHello, gameHello }: Port): void {
  // Paused since accept: nothing is read before the peer's address is known to be an Agent's.
  const peer = socket.remoteAddress?.replace(/^::ffff:/, '');
  if (peer === undefined || !addresses.has(peer)) return void socket.destroy();
  const open = perPeer.get(peer) ?? 0;
  if (open >= PEER_SOCKETS) {
    tooMany();
    return void socket.destroy();
  }
  perPeer.set(peer, open + 1);
  sockets.add(socket);
  socket.on('error', () => {}); // 'close' always follows and does the cleanup
  const helloTimer = setTimeout(() => socket.destroy(), helloTimeoutMs);
  socket.on('close', () => {
    sockets.delete(socket);
    clearTimeout(helloTimer);
    const left = perPeer.get(peer)! - 1;
    if (left) perPeer.set(peer, left);
    else perPeer.delete(peer);
  });
  let lines = budget(peer).lines; // first lines: nobody is known yet, so its peer address's
  let onLine = (line: string) => {
    clearTimeout(helloTimer);
    const msg = parseAgentLine(line);
    const next = msg?.type === 'agentHello' ? agentHello(socket, peer, msg) : msg?.type === 'hello' ? gameHello(socket, peer, msg) : null;
    if (next) ({ lines, onLine } = next);
    else socket.destroy();
  };
  readLines(socket, LIMITS.lineBytes, (line) => {
    if (socket.destroyed || socket.writableEnded || !lines(socket)) return;
    try {
      onLine(line);
    } catch (err) {
      // One bad line must never take the hub down: it ends only its own connection.
      console.error(`[agents] ${peer}: a line failed, closing:`, err);
      socket.destroy();
    }
  });
  socket.resume();
}

/**
 * Splits a socket's bytes into lines as they arrive, at most `max` bytes each (the newline not counted, a `\r` before
 * it dropped): a longer line destroys the socket before more of it is kept.
 */
function readLines(socket: Socket, max: number, onLine: (line: string) => void): void {
  let parts: Buffer[] = [];
  let size = 0;
  socket.on('data', (chunk: Buffer) => {
    let start = 0;
    while (start < chunk.length && !socket.destroyed) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      size += end - start;
      if (size > max) {
        console.error(`[agents] ${socket.remoteAddress}: a line over ${max} bytes, closing`);
        return void socket.destroy();
      }
      parts.push(chunk.subarray(start, end));
      if (nl === -1) return;
      const line = Buffer.concat(parts).toString('utf8'); // whole first: a character may span two chunks
      parts = [];
      size = 0;
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
      start = nl + 1;
    }
  });
}

/** Refuses a first line: its `reject`, then the connection is ended and destroyed within 2 s, whatever the peer does. */
export function reject(socket: Socket, reason: string): Next {
  send(socket, { type: 'reject', reason });
  socket.end(() => socket.destroy());
  const timer = setTimeout(() => socket.destroy(), END_MS);
  socket.once('close', () => clearTimeout(timer));
  return { lines: () => false, onLine: ignore }; // its lines are not read on: it is ending
}

export function send(socket: Socket, msg: HubAgentMsg): void {
  socket.write(JSON.stringify(msg) + '\n');
}

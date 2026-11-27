// `readLines`, both ports' line reader (the Agent port's `agents/listener.ts`, the Mod port's
// `servers/connections.ts`): a socket's bytes split into lines as they arrive, each at most `max()` bytes (asked per
// chunk, so a port may allow more once its hello is accepted; the newline not counted, a `\r` before it dropped). A
// longer line destroys the socket before more of it is kept, so no peer grows the hub's heap. Hub core.

import type { Socket } from 'node:net';

/** Splits `socket`'s bytes into lines for `onLine`, destroying it on a line over `max()` bytes; `tag` prefixes the log line. */
export function readLines(socket: Socket, max: () => number, onLine: (line: string) => void, tag: string): void {
  let parts: Buffer[] = [];
  let size = 0;
  socket.on('data', (chunk: Buffer) => {
    let start = 0;
    while (start < chunk.length && !socket.destroyed) {
      const nl = chunk.indexOf(0x0a, start);
      const end = nl === -1 ? chunk.length : nl;
      size += end - start;
      const cap = max();
      if (size > cap) {
        console.error(`${tag} ${socket.remoteAddress}: a line over ${cap} bytes, closing`);
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

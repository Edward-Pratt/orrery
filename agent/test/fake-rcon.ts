import { createServer, type AddressInfo, type Socket } from 'node:net';
import { AUTH, AUTH_RESPONSE, EXEC, RESPONSE, decode, encode, type Packet } from '../src/rcon.ts';

export const PASSWORD = 'rcon-test-password';

/** A command's reply: one body, or the bodies of several packets. Nothing (undefined): like a hung server, no more answers. */
export type Reply = string | Buffer[] | undefined;

/**
 * A fake RCON server shaped like a Source one: an empty response before the auth answer, and commands answered in
 * the order they came, each reply sent before the next command is handled. `handle` sees every command but the
 * client's empty end marker, which is always answered with an empty reply.
 */
export async function fakeRcon(handle: (command: string, socket: Socket) => Reply | Promise<Reply> = () => '') {
  const received: Packet[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    let buf: Buffer = Buffer.alloc(0);
    let chain = Promise.resolve();
    socket.on('data', (chunk: Buffer) => {
      const decoded = decode(Buffer.concat([buf, chunk]));
      buf = decoded.rest;
      for (const p of decoded.packets) {
        received.push(p);
        if (p.type === AUTH) {
          const ok = p.body.toString('utf8') === PASSWORD;
          socket.write(Buffer.concat([encode(p.id, RESPONSE, ''), encode(ok ? p.id : -1, AUTH_RESPONSE, '')]));
        } else if (p.type === EXEC) {
          const command = p.body.toString('utf8');
          chain = chain.then(async () => {
            const reply = command === '' ? '' : await handle(command, socket);
            if (reply === undefined) return new Promise<void>(() => {});
            if (socket.destroyed) return;
            for (const body of typeof reply === 'string' ? [reply] : reply) socket.write(encode(p.id, RESPONSE, body));
          });
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    received,
    /** The commands received, end markers left out. */
    commands: () => received.filter((p) => p.type === EXEC && p.body.length > 0).map((p) => p.body.toString('utf8')),
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

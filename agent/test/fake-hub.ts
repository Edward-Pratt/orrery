import { createServer, type AddressInfo, type Socket } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseAgentLine, parseModLine } from '../../hub/src/protocol.ts';

type Msg = Record<string, unknown>;

/** How the fake hub answers a connection's first line: `welcome`, a reject, nothing yet, or a reset. */
export type Answer = 'welcome' | { reject: string } | 'silent' | 'destroy';

/** One connection to the fake hub, as the hub sees it. */
export type HubConn = {
  socket: Socket;
  /** When it connected (`performance.now()`). */
  at: number;
  /** Every line received, parsed with the hub's own parser: `parseAgentLine` for the first line and an Agent connection, `parseModLine` after a game `hello`. */
  lines: Msg[];
  /** Lines the hub's parser refused (raw). */
  invalid: string[];
  /** The first line's type: `agentHello` or `hello`. */
  readonly kind: string | undefined;
  closed: boolean;
  send(msg: object): void;
};

/**
 * A fake hub's Agent port: a TCP server on 127.0.0.1 that reads lines like the hub does (each through the hub's
 * parsers, so a line the real hub would refuse shows up in `invalid`) and answers each first line as `answer` says.
 */
export async function fakeHub(answer: (hello: Msg, conn: HubConn) => Answer = () => 'welcome', port = 0) {
  const conns: HubConn[] = [];
  const server = createServer((socket) => {
    socket.on('error', () => {});
    let buf = '';
    const conn: HubConn = {
      socket,
      at: performance.now(),
      lines: [],
      invalid: [],
      get kind() {
        return this.lines[0]?.type as string | undefined;
      },
      closed: false,
      send: (msg) => socket.writable && socket.write(JSON.stringify(msg) + '\n'),
    };
    conns.push(conn);
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => {
      buf += d;
      for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        const msg = conn.kind === 'hello' ? parseModLine(line) : parseAgentLine(line);
        if (!msg) {
          conn.invalid.push(line);
          continue;
        }
        conn.lines.push(msg as Msg);
        if (conn.lines.length > 1) continue;
        const a = answer(msg as Msg, conn);
        if (a === 'welcome') conn.send({ type: 'welcome' });
        else if (a === 'destroy') socket.destroy();
        else if (a !== 'silent') {
          conn.send({ type: 'reject', reason: a.reject });
          socket.end();
        }
      }
    });
    socket.on('close', () => (conn.closed = true));
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    conns,
    /** The connections whose first line is `kind`, in order. */
    of: (kind: 'agentHello' | 'hello') => conns.filter((c) => c.kind === kind),
    close: () => {
      for (const c of conns) c.socket.destroy();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** Waits until `fn` returns something other than undefined, null or false, polling every 5 ms; throws after `ms`. */
export async function eventually<T>(fn: () => T | undefined | null | false, ms = 2000, what = 'the condition'): Promise<T> {
  const until = performance.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== null && v !== false) return v;
    if (performance.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

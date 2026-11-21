// `Link`, one TCP connection to the hub's Agent port, for either of `HubClient`'s two connections (`hub-agent.ts`,
// `hub-game.ts`): its hello sent on connect, then lines read under the cap (`LIMITS.lineBytes`) and given to `onLine`,
// and lines sent under it (`encode` trims what it can; a message that can't fit is logged, not sent). A line from the
// hub over the cap destroys that connection (then a reconnect); so does no `welcome` within `handshakeMs`. `onClose`
// gets why it closed: the socket's error, or what `end` or `drop` said, else that the hub closed it.

import { connect, type Socket } from 'node:net';
import { LIMITS, LineReader, encode, type OutMsg } from './wire.ts';

/** One TCP connection to the hub's Agent port: its hello sent on connect, lines read under the cap, lines sent under it. */
export class Link {
  readonly socket: Socket;
  readonly closed: Promise<void>;
  welcomed = false;
  /** The hub refused its hello as `TOO_FAST`: no failure, the retry waits out the hub's gap. */
  tooFast = false;
  #why = 'the hub closed the connection';
  #handshake: NodeJS.Timeout;

  constructor(host: string, port: number, hello: OutMsg, onLine: (line: string) => void, onClose: (why: string) => void, handshakeMs: number) {
    const socket = connect({ host, port });
    this.socket = socket;
    const reader = new LineReader(LIMITS.lineBytes);
    this.#handshake = setTimeout(() => this.drop('no welcome in time'), handshakeMs);
    this.closed = new Promise((resolve) => socket.once('close', () => resolve()));
    socket.setNoDelay(true);
    socket.on('connect', () => this.send(hello));
    socket.on('data', (chunk) => {
      let lines: string[];
      try {
        lines = reader.push(chunk as Buffer); // no encoding is set, so chunks are Buffers
      } catch (err) {
        return this.drop(`the hub sent ${(err as Error).message}`);
      }
      for (const line of lines) {
        if (socket.destroyed) return;
        onLine(line);
      }
    });
    socket.on('error', (err) => {
      this.#why = err.message;
    });
    socket.on('close', () => {
      clearTimeout(this.#handshake);
      onClose(this.#why);
    });
  }

  welcome(): void {
    this.welcomed = true;
    clearTimeout(this.#handshake);
  }

  /**
   * Sends one line, if it fits the cap (`encode` trims what it can); a message that can't fit is logged, not sent.
   * `then` gets whether the write succeeded (false: not writable, too big, or the write failed).
   */
  send(msg: OutMsg, then?: (written: boolean) => void): void {
    if (!this.socket.writable) return then?.(false);
    const line = encode(msg);
    if (line === null) {
      console.error(`[hub] a ${msg.type} over ${LIMITS.lineBytes} bytes was not sent`);
      return then?.(false);
    }
    this.socket.write(line, (err) => then?.(!err));
  }

  /** Closes after what was sent is flushed. */
  end(why: string): void {
    this.#why = why;
    this.socket.end();
  }

  drop(why: string): void {
    this.#why = why;
    this.socket.destroy();
  }
}

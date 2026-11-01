import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';

/** Packet types (Source RCON). AUTH_RESPONSE and EXEC share a value; the direction tells them apart. */
export const RESPONSE = 0;
export const EXEC = 2;
export const AUTH_RESPONSE = 2;
export const AUTH = 3;

/**
 * The largest packet either side may send, length field excluded. Factorio sends a reply of any size as one packet
 * (5 MB seen), so this is far above any real reply; a longer length is a broken or hostile peer.
 */
export const MAX_PACKET = 16 * 1024 * 1024;

/** id 4 + type 4 + two NULs: the body's terminator and the empty string after it. */
const MIN_PACKET = 10;
const MAX_ID = 0x7fffffff;

export type Packet = { id: number; type: number; body: Buffer };

export class RconError extends Error {}
/** The server took the connection but didn't answer in time: it may be busy (a blocking save) or frozen, not gone. */
export class RconTimeout extends RconError {}
/** A command was sent and got no answer in time: Factorio may still run it, once it answers again (a blocking save). */
export class RconNoAnswer extends RconTimeout {}
/** A command was never sent: its connection ended while it waited its turn, so it did not run. */
export class RconNotSent extends RconError {}
/** RCON refused the password (an auth answer with id -1): trying again can't help. */
export class RconRefused extends RconError {}

/** One packet: int32 LE length (of the rest), id and type, then the body and two NULs. */
export function encode(id: number, type: number, body: string | Buffer): Buffer {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  const buf = Buffer.alloc(4 + MIN_PACKET + bytes.length); // zero-filled: the two NULs are already there
  buf.writeInt32LE(MIN_PACKET + bytes.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bytes.copy(buf, 12);
  return buf;
}

/**
 * Splits the whole packets off the front of buf; rest is an incomplete one still arriving (a packet may span many TCP
 * reads). Throws RconError on a length out of range (as soon as its 4 bytes are in, so a huge one is never waited
 * for) or a missing terminator.
 */
export function decode(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let at = 0;
  while (buf.length - at >= 4) {
    const size = buf.readInt32LE(at);
    if (size > MAX_PACKET) throw new RconError(`RCON packet too large: length ${size}, over the ${MAX_PACKET} cap`);
    if (size < MIN_PACKET) throw new RconError(`malformed RCON packet: length ${size}`);
    if (buf.length - at < 4 + size) break;
    const end = at + 4 + size;
    if (buf[end - 2] !== 0 || buf[end - 1] !== 0) throw new RconError('malformed RCON packet: no terminator');
    packets.push({ id: buf.readInt32LE(at + 4), type: buf.readInt32LE(at + 8), body: buf.subarray(at + 12, end - 2) });
    at = end;
  }
  return { packets, rest: buf.subarray(at) };
}

type Current = { onPacket: (p: Packet) => void; fail: (err: Error) => void };

/**
 * A Source RCON client for Factorio's RCON, one connection: `Rcon.connect` opens and authenticates it, `exec` runs a
 * command and resolves with its reply, one command at a time (later calls wait their turn). Factorio answers each
 * command with exactly one response packet carrying its id, of any size, its `rcon.print` lines each ending in `\n`
 * (an empty body if nothing was printed); the client strips one trailing `\n`. Any other packet is dropped.
 * Factorio never answers a packet with an empty body, so none is ever sent: no end marker, and an empty command is
 * refused.
 *
 * A command that times out ends the connection (`RconNoAnswer`: it was sent, so it may still run), since a server
 * that stops answering is the caller's signal to reconnect; the commands waiting behind it reject with `RconNotSent`.
 * Once authenticated, the connection ending for any reason but `close()` emits `close` once, with why; a new
 * connection is a new `Rcon`.
 */
export class Rcon extends EventEmitter<{ close: [Error] }> {
  #socket: Socket;
  #chunks: Buffer[] = [];
  #have = 0;
  /** Bytes needed before decode can finish a packet: a length field, then the whole packet it announces. */
  #need = 4;
  #nextId = 1;
  #current: Current | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #ready = false;
  #ended = false;

  /** Use `Rcon.connect`. */
  constructor(socket: Socket) {
    super();
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => this.#data(chunk));
    socket.on('error', (err) => this.#end(new RconError(`RCON connection failed: ${err.message}`), true));
    socket.on('close', () => this.#end(new RconError('RCON connection closed'), true));
  }

  /** Connects and authenticates within timeoutMs. Rejects (and emits nothing) on a refused password or no answer. */
  static connect(host: string, port: number, password: string, timeoutMs: number): Promise<Rcon> {
    const rcon = new Rcon(connect({ host, port }));
    return rcon.#auth(password, timeoutMs).then(() => rcon);
  }

  /** Runs a command and resolves with its whole reply. Rejects if it times out or the connection ends first. */
  exec(command: string, timeoutMs = 10_000): Promise<string> {
    if (command === '') return Promise.reject(new RconError('RCON command is empty'));
    if (command.includes('\0')) return Promise.reject(new RconError('RCON command contains a NUL'));
    if (Buffer.byteLength(command) > MAX_PACKET - MIN_PACKET) return Promise.reject(new RconError('RCON command too long'));
    const run = this.#queue.then(() => this.#run(command, timeoutMs));
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Ends the connection without a `close` event; a command running or waiting rejects. */
  close(): void {
    this.#end(new RconError('RCON connection closed'), false);
  }

  #auth(password: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = this.#id();
      const timer = setTimeout(() => this.#end(new RconTimeout(`RCON did not answer within ${timeoutMs} ms`), false), timeoutMs);
      this.#current = {
        onPacket: (p) => {
          // Source servers send an empty response before the auth answer; tolerated in case Factorio does too.
          if (p.type === RESPONSE) return;
          if (p.type === AUTH_RESPONSE && p.id === id) {
            clearTimeout(timer);
            this.#current = null;
            this.#ready = true;
            resolve();
          } else {
            const refused = p.type === AUTH_RESPONSE && p.id === -1;
            this.#end(refused ? new RconRefused('RCON password refused') : new RconError('unexpected RCON auth answer'), false);
          }
        },
        fail: (err) => {
          clearTimeout(timer);
          this.#current = null;
          reject(err);
        },
      };
      this.#socket.once('connect', () => this.#socket.write(encode(id, AUTH, password)));
    });
  }

  #run(command: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.#ended) return reject(new RconNotSent('RCON connection closed before the command was sent'));
      const id = this.#id();
      const timer = setTimeout(() => this.#end(new RconNoAnswer(`RCON command timed out after ${timeoutMs} ms`), true), timeoutMs);
      this.#current = {
        onPacket: (p) => {
          if (p.id !== id || p.type !== RESPONSE) return; // not this command's reply: dropped
          clearTimeout(timer);
          this.#current = null;
          const body = p.body.at(-1) === 0x0a ? p.body.subarray(0, -1) : p.body;
          resolve(body.toString('utf8'));
        },
        fail: (err) => {
          clearTimeout(timer);
          this.#current = null;
          reject(err);
        },
      };
      this.#socket.write(encode(id, EXEC, command));
    });
  }

  /** Non-zero and rising, wrapping before int32 runs out (-1 means a refused password). */
  #id(): number {
    const id = this.#nextId;
    this.#nextId = id >= MAX_ID - 1 ? 1 : id + 1;
    return id;
  }

  #data(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#have += chunk.length;
    if (this.#have < this.#need) return; // a big reply still arriving: its chunks are joined once, when all are in
    let packets: Packet[];
    let rest: Buffer;
    try {
      ({ packets, rest } = decode(Buffer.concat(this.#chunks, this.#have)));
    } catch (err) {
      return this.#end(err as Error, true);
    }
    this.#chunks = [rest];
    this.#have = rest.length;
    this.#need = rest.length >= 4 ? 4 + rest.readInt32LE(0) : 4; // decode has checked that length
    for (const p of packets) {
      if (this.#ended) return;
      this.#current?.onPacket(p);
    }
  }

  #end(err: Error, signal: boolean): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#socket.destroy();
    this.#current?.fail(err);
    if (signal && this.#ready) this.emit('close', err);
  }
}

/**
 * Commands on one kept RCON connection of their own: opened on the first command, and again on the next one after it
 * ends (refused, timed out, closed by the server). Kept apart from the status poll's connection, so a command that
 * times out (a blocking save) never reads as Factorio gone there. Commands run in the order they were given; one that
 * was never sent because the connection ended before its turn (`RconNotSent`) runs once more on a new connection, and
 * one that was sent is never sent again.
 */
export class RconSession {
  #host: string;
  #port: number;
  #password: string;
  #timeoutMs: number;
  #rcon: Promise<Rcon> | null = null;
  #closed = false;

  constructor(port: number, password: string, timeoutMs = 4000, host = '127.0.0.1') {
    this.#host = host;
    this.#port = port;
    this.#password = password;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * Runs a command and resolves with its reply; rejects if RCON can't be reached or doesn't answer in time
   * (`RconNoAnswer`: sent, so it may still run).
   */
  async exec(command: string): Promise<string> {
    for (let retried = false; ; retried = true) {
      if (this.#closed) throw new RconError('RCON session closed');
      const connecting = this.#connection();
      const rcon = await connecting;
      try {
        return await rcon.exec(command, this.#timeoutMs);
      } catch (err) {
        this.#forget(connecting);
        rcon.close();
        if (!(err instanceof RconNotSent) || retried || this.#closed) throw err;
      }
    }
  }

  /** Ends the connection; later commands reject. */
  close(): void {
    this.#closed = true;
    void this.#rcon?.then(
      (rcon) => rcon.close(),
      () => {},
    );
    this.#rcon = null;
  }

  /** The kept connection, or a new one (another command may have opened it already: sharing it keeps their order). */
  #connection(): Promise<Rcon> {
    if (this.#rcon) return this.#rcon;
    const p = Rcon.connect(this.#host, this.#port, this.#password, this.#timeoutMs);
    this.#rcon = p;
    p.then(
      (rcon) => {
        if (this.#closed) rcon.close();
        rcon.on('close', () => this.#forget(p));
      },
      () => this.#forget(p),
    );
    return p;
  }

  #forget(p: Promise<Rcon>): void {
    if (this.#rcon === p) this.#rcon = null;
  }
}

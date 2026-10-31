import { EventEmitter } from 'node:events';
import { connect, type Socket } from 'node:net';

/** Packet types (Source RCON). AUTH_RESPONSE and EXEC share a value; the direction tells them apart. */
export const RESPONSE = 0;
export const EXEC = 2;
export const AUTH_RESPONSE = 2;
export const AUTH = 3;

/** The largest packet either side may send, length field excluded. A longer length is a broken or hostile peer. */
export const MAX_PACKET = 4 * 1024 * 1024;

/** id 4 + type 4 + two NULs: the body's terminator and the empty string after it. */
const MIN_PACKET = 10;
const MAX_ID = 0x7fffffff;

export type Packet = { id: number; type: number; body: Buffer };

export class RconError extends Error {}

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
 * Splits the whole packets off the front of buf; rest is an incomplete one still arriving. Throws RconError on a
 * length out of range (as soon as its 4 bytes are in, so a huge one is never waited for) or a missing terminator.
 */
export function decode(buf: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let at = 0;
  while (buf.length - at >= 4) {
    const size = buf.readInt32LE(at);
    if (size < MIN_PACKET || size > MAX_PACKET) throw new RconError(`malformed RCON packet: length ${size}`);
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
 * A Source RCON client (Factorio's RCON) for one connection: `Rcon.connect` opens and authenticates it, `exec` runs a
 * command and resolves with its whole reply, one command at a time (later calls wait their turn). A reply may come in
 * several packets: each command is followed by an empty one with the next id, and the reply is every response packet
 * up to that one's answer, joined before decoding (a UTF-8 character may be split between packets). That Factorio
 * answers the empty command with an empty reply, and nothing else, is a smoke-test item.
 *
 * A command that times out ends the connection, since a server that stops answering is the caller's signal to
 * reconnect. Once authenticated, the connection ending for any reason but `close()` emits `close` once, with why;
 * a new connection is a new `Rcon`.
 */
export class Rcon extends EventEmitter<{ close: [Error] }> {
  #socket: Socket;
  #buf: Buffer = Buffer.alloc(0);
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
      const timer = setTimeout(() => this.#end(new RconError(`RCON did not answer within ${timeoutMs} ms`), false), timeoutMs);
      this.#current = {
        onPacket: (p) => {
          if (p.type === RESPONSE) return; // Source servers send an empty response before the auth answer
          if (p.type === AUTH_RESPONSE && p.id === id) {
            clearTimeout(timer);
            this.#current = null;
            this.#ready = true;
            resolve();
          } else {
            const refused = p.type === AUTH_RESPONSE && p.id === -1;
            this.#end(new RconError(refused ? 'RCON password refused' : 'unexpected RCON auth answer'), false);
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
      if (this.#ended) return reject(new RconError('RCON connection closed'));
      const id = this.#id();
      const marker = this.#id();
      const parts: Buffer[] = [];
      const timer = setTimeout(() => this.#end(new RconError(`RCON command timed out after ${timeoutMs} ms`), true), timeoutMs);
      this.#current = {
        onPacket: (p) => {
          if (p.id === id && p.type === RESPONSE) parts.push(p.body);
          else if (p.id === marker) {
            clearTimeout(timer);
            this.#current = null;
            resolve(Buffer.concat(parts).toString('utf8'));
          }
          // Anything else answers an earlier request: dropped.
        },
        fail: (err) => {
          clearTimeout(timer);
          this.#current = null;
          reject(err);
        },
      };
      this.#socket.write(Buffer.concat([encode(id, EXEC, command), encode(marker, EXEC, '')]));
    });
  }

  /** Non-zero and rising, wrapping before int32 runs out (-1 means a refused password). */
  #id(): number {
    const id = this.#nextId;
    this.#nextId = id >= MAX_ID - 1 ? 1 : id + 1;
    return id;
  }

  #data(chunk: Buffer): void {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    let packets: Packet[];
    try {
      ({ packets, rest: this.#buf } = decode(this.#buf));
    } catch (err) {
      return this.#end(err as Error, true);
    }
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

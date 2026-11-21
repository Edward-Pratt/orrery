// Reading a tar stream for `unpack` (unpack.ts): exact byte counts from a stream of chunks (`Bytes`), a header's text
// and octal fields, its checksum, and a pax extended header's records (ustar, GNU long names and links, pax
// `path`/`linkpath`/`size`). Nothing here trusts the archive: a malformed field, a bad length or a stream that ends in
// the middle of an entry throws `Refused`, which refuses the whole release.

/** An archive entry the agent won't unpack, or an archive it can't read: the whole release is refused. */
export class Refused extends Error {}

export const BLOCK = 512;

/** Reads exact byte counts from a stream of chunks. */
export class Bytes {
  #it: AsyncIterator<Buffer>;
  #buf: Buffer = Buffer.alloc(0);
  #end = false;

  constructor(src: AsyncIterable<Buffer>) {
    this.#it = src[Symbol.asyncIterator]();
  }

  async #more(): Promise<boolean> {
    if (this.#end) return false;
    const r = await this.#it.next();
    if (r.done) {
      this.#end = true;
      return false;
    }
    const chunk = Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value);
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    return true;
  }

  /** The next `n` bytes; null if the input ended exactly here. */
  async read(n: number): Promise<Buffer | null> {
    while (this.#buf.length < n) {
      if (await this.#more()) continue;
      if (this.#buf.length === 0) return null;
      throw new Refused('the archive ends in the middle of an entry');
    }
    const out = this.#buf.subarray(0, n);
    this.#buf = this.#buf.subarray(n);
    return out;
  }

  /** The next `n` bytes, in pieces. */
  async *take(n: number): AsyncGenerator<Buffer> {
    while (n > 0) {
      if (this.#buf.length === 0 && !(await this.#more())) throw new Refused('the archive ends in the middle of an entry');
      const piece = this.#buf.subarray(0, Math.min(n, this.#buf.length));
      this.#buf = this.#buf.subarray(piece.length);
      n -= piece.length;
      yield piece;
    }
  }

  async skip(n: number): Promise<void> {
    for await (const _ of this.take(n));
  }

  async close(): Promise<void> {
    await this.#it.return?.();
  }
}

/** A header field as text, up to its first NUL. */
export const text = (b: Buffer): string => {
  const z = b.indexOf(0);
  return (z === -1 ? b : b.subarray(0, z)).toString('utf8');
};

/** An octal header number (the base-256 form, for entries over 8 GiB, is never in a release). */
export function octal(b: Buffer): number {
  if (b[0]! & 0x80) throw new Refused('an archive entry too big for a Factorio release');
  const s = text(b).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new Refused('a malformed archive header');
  return parseInt(s, 8);
}

/** Whether a header's checksum holds (its checksum field counted as spaces). */
export function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  return sum === octal(h.subarray(148, 156));
}

/** A pax extended header's `<length> <key>=<value>\n` records. */
export function parsePax(body: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  for (let pos = 0; pos < body.length; ) {
    const space = body.indexOf(0x20, pos);
    const len = space === -1 ? NaN : Number(body.subarray(pos, space).toString('latin1'));
    if (!Number.isSafeInteger(len) || len <= space - pos || pos + len > body.length) throw new Refused('a malformed pax header');
    const record = body.subarray(space + 1, pos + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

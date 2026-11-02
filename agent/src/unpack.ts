// A game update's release from its archive: Factorio's headless tarball unpacked without trusting its entries, and the
// highest glibc its binary needs, read from the ELF's version needs (agent/CLAUDE.md, "Trust boundaries").
//
// `unpack(stream, target, strip = 1)`: a tar stream (ustar, GNU long names and links, pax `path`/`linkpath`/`size`)
// into an empty folder of the agent's own, trusting no entry: checksums checked, each path's first component dropped
// (setup's `--strip-components=1`), absolute paths, `..` and NULs refused, files created
// `O_CREAT`/`O_EXCL`/`O_NOFOLLOW` with modes 755 or 644 only, nothing below a symlink of the archive, a symlink only
// relative and staying inside step by step, and at the end every one must `realpath` inside (a chain can't lead out);
// a hard link only to a file unpacked before it; any other kind (devices, FIFOs, sparse) refused; 4 GiB and 500,000
// entries at most. A refusal throws `Refused`. `unxz(file)`: `xz -dc -- <file>`'s output (no shell; Node has no xz).
// `glibcNeed(file)`: the highest `GLIBC_X.Y` in an ELF's version needs (`.gnu.version_r` and its string table; 32 or
// 64 bit, either byte order), null if none, a malformed file throws; `compareGlibc` compares them as numbers.
import { spawn } from 'node:child_process';
import { constants, link, mkdir, open, realpath, symlink } from 'node:fs/promises';
import { posix } from 'node:path';

/** An archive entry the agent won't unpack, or an archive it can't read: the whole release is refused. */
export class Refused extends Error {}

/** Far over a Factorio release unpacked (about 1 GB): a tarball that unpacks to more is refused. */
export const UNPACK_MAX = 4 * 1024 ** 3;
/** Far over a Factorio release's file count (tens of thousands). */
const ENTRIES_MAX = 500_000;
/** A GNU long name or a pax header bigger than this is no real one. */
const META_MAX = 1024 * 1024;
/** The ELF parts read (section headers, the version needs and their strings) are each at most this big. */
const ELF_PART_MAX = 64 * 1024 * 1024;
const BLOCK = 512;

/**
 * `file` decompressed by `xz -dc` (Node has no xz), as its output's chunks; a failing xz throws once its output ended.
 * The agent's own file only: no argument from the hub.
 */
export async function* unxz(file: string): AsyncGenerator<Buffer> {
  const child = spawn('xz', ['-dc', '--', file], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    if (err.length < 1024) err += d;
  });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  exit.catch(() => {}); // awaited below; an early return must not leave it unhandled
  try {
    for await (const chunk of child.stdout) yield chunk as Buffer;
    const code = await exit;
    if (code !== 0) throw new Error(`xz could not unpack it: ${err.trim().split('\n')[0] || `exit ${code}`}`);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

/** Reads exact byte counts from a stream of chunks. */
class Bytes {
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
const text = (b: Buffer): string => {
  const z = b.indexOf(0);
  return (z === -1 ? b : b.subarray(0, z)).toString('utf8');
};

/** An octal header number (the base-256 form, for entries over 8 GiB, is never in a release). */
function octal(b: Buffer): number {
  if (b[0]! & 0x80) throw new Refused('an archive entry too big for a Factorio release');
  const s = text(b).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) throw new Refused('a malformed archive header');
  return parseInt(s, 8);
}

/** Whether a header's checksum holds (its checksum field counted as spaces). */
function checksumOk(h: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  return sum === octal(h.subarray(148, 156));
}

/** A pax extended header's `<length> <key>=<value>\n` records. */
function parsePax(body: Buffer): Record<string, string> {
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

/**
 * An entry's path inside the release, its first `strip` components dropped (the tarball's `factorio/`, as setup's
 * `--strip-components=1`); null for the top folder itself. An absolute path, a `..` or a NUL is refused.
 */
function inside(name: string, strip: number): string | null {
  if (name.startsWith('/')) throw new Refused(`${name} is an absolute path`);
  if (name.includes('\0')) throw new Refused('an entry name with a NUL in it');
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) throw new Refused(`${name} leads out of the release`);
  const kept = parts.slice(strip);
  return kept.length === 0 ? null : kept.join('/');
}

/** A symlink's target: relative, and staying inside the release from the link's folder, step by step. */
function checkLink(rel: string, to: string): void {
  if (to === '' || to.startsWith('/') || to.includes('\0')) throw new Refused(`the symlink ${rel} points at an absolute path`);
  const at = rel.split('/').slice(0, -1);
  for (const part of to.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') at.push(part);
    else if (at.pop() === undefined) throw new Refused(`the symlink ${rel} leads out of the release`);
  }
}

/**
 * Unpacks a tar stream (ustar, GNU long names and pax headers) into `target`, an empty folder of the agent's own,
 * trusting none of its entries: each path loses its first `strip` components and must stay inside (no absolute path,
 * no `..`); files are created new (`O_CREAT | O_EXCL | O_NOFOLLOW`), modes only 755 or 644; nothing is written below
 * a symlink of the archive; a symlink must point inside, and at the end every one must resolve inside; a hard link
 * only to a file unpacked before it; devices, FIFOs and any other kind refused; 4 GiB and 500,000 entries at most.
 * Any refusal throws `Refused`, and what was unpacked is the caller's to remove.
 */
export async function unpack(src: AsyncIterable<Buffer>, target: string, strip = 1, maxBytes = UNPACK_MAX): Promise<{ files: number; bytes: number }> {
  const input = new Bytes(src);
  const links = new Set<string>();
  const files = new Set<string>();
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: Record<string, string> = {};
  let bytes = 0;
  let entries = 0;
  const under = (rel: string) => {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) if (links.has(parts.slice(0, i).join('/'))) return true;
    return false;
  };
  try {
    for (;;) {
      const h = await input.read(BLOCK);
      if (!h || h.every((b) => b === 0)) break;
      if (!checksumOk(h)) throw new Refused('an archive header with a bad checksum');
      if (++entries > ENTRIES_MAX) throw new Refused(`over ${ENTRIES_MAX} entries`);
      const type = String.fromCharCode(h[156]!);
      const headerSize = octal(h.subarray(124, 136));
      if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
        if (headerSize > META_MAX) throw new Refused('an archive header over 1 MiB');
        const block = headerSize === 0 ? Buffer.alloc(0) : await input.read(Math.ceil(headerSize / BLOCK) * BLOCK);
        if (block === null) throw new Refused('the archive ends in the middle of an entry');
        const body = block.subarray(0, headerSize);
        if (type === 'L') longName = text(body);
        else if (type === 'K') longLink = text(body);
        else if (type === 'x') pax = parsePax(body);
        continue;
      }
      const ustar = h.subarray(257, 263).toString('latin1') === 'ustar\0' && h[345] !== 0;
      const name = pax.path ?? longName ?? (ustar ? `${text(h.subarray(345, 500))}/` : '') + text(h.subarray(0, 100));
      const linkName = pax.linkpath ?? longLink ?? text(h.subarray(157, 257));
      const size = pax.size !== undefined ? Number(pax.size) : headerSize;
      if (!Number.isSafeInteger(size) || size < 0) throw new Refused(`${name} has a malformed size`);
      const mode = octal(h.subarray(100, 108));
      longName = longLink = null;
      pax = {};
      const data = Math.ceil(size / BLOCK) * BLOCK;
      const rel = inside(name, strip);
      if (rel === null) {
        if (type !== '5') throw new Refused(`${name} is not in the release's folder`);
        await input.skip(data);
        continue;
      }
      if (under(rel)) throw new Refused(`${name} is below a symlink of the archive`);
      const path = posix.join(target, rel);
      switch (type) {
        case '5':
          await mkdir(path, { recursive: true, mode: 0o755 });
          await input.skip(data);
          break;
        case '0':
        case '\0':
        case '7': {
          bytes += size;
          if (bytes > maxBytes) throw new Refused(`it unpacks to over ${maxBytes} bytes`);
          await mkdir(posix.dirname(path), { recursive: true, mode: 0o755 });
          const fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try {
            await fh.chmod(mode & 0o111 ? 0o755 : 0o644); // whatever the umask
            for await (const piece of input.take(size)) {
              for (let done = 0; done < piece.length; ) done += (await fh.write(piece, done, piece.length - done)).bytesWritten;
            }
          } finally {
            await fh.close();
          }
          await input.skip(data - size);
          files.add(rel);
          break;
        }
        case '2':
          checkLink(rel, linkName);
          await mkdir(posix.dirname(path), { recursive: true, mode: 0o755 });
          await symlink(linkName, path);
          links.add(rel);
          await input.skip(data);
          break;
        case '1': {
          const to = inside(linkName, strip);
          if (to === null || !files.has(to)) throw new Refused(`${name} is a hard link to ${linkName}, not to a file unpacked before it`);
          await mkdir(posix.dirname(path), { recursive: true, mode: 0o755 });
          await link(posix.join(target, to), path);
          files.add(rel);
          await input.skip(data);
          break;
        }
        default:
          throw new Refused(`${name} is a kind of entry a release never has (type ${JSON.stringify(type)})`);
      }
    }
    // Each link was checked on its own; a chain of them is checked where it really leads.
    const root = await realpath(target);
    for (const rel of links) {
      const real = await realpath(posix.join(target, rel)).catch(() => null);
      if (real === null || (real !== root && !real.startsWith(root + '/'))) throw new Refused(`the symlink ${rel} leads out of the release, or nowhere`);
    }
    return { files: files.size, bytes };
  } finally {
    await input.close();
  }
}

/** ELF's section type for the version needs (`.gnu.version_r`). */
const SHT_GNU_VERNEED = 0x6ffffffe;
const GLIBC = /^GLIBC_(\d+)\.(\d+)(?:\.\d+)?$/;

/** A glibc version `X.Y` as numbers, compared as numbers (`2.4` is older than `2.38`). */
export function compareGlibc(a: string, b: string): number {
  const [am, an] = a.split('.').map(Number) as [number, number];
  const [bm, bn] = b.split('.').map(Number) as [number, number];
  return am - bm || an - bn;
}

/**
 * The highest `GLIBC_X.Y` that the ELF file `file` needs, from its version needs (the `.gnu.version_r` section and its
 * string table, as `readelf -V` shows them), as `X.Y`; null if it has none. A file that isn't a well-formed ELF throws.
 */
export async function glibcNeed(file: string): Promise<string | null> {
  const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('not a regular file');
    const bad = () => new Error('not a well-formed ELF file');
    const at = async (pos: number, len: number): Promise<Buffer> => {
      if (!Number.isSafeInteger(pos) || !Number.isSafeInteger(len) || pos < 0 || len < 0 || len > ELF_PART_MAX || pos + len > st.size) throw bad();
      const b = Buffer.alloc(len);
      const { bytesRead } = await fh.read(b, 0, len, pos);
      if (bytesRead !== len) throw bad();
      return b;
    };
    const id = await at(0, Math.min(64, st.size));
    if (id.length < 52 || id.readUInt32BE(0) !== 0x7f454c46 || (id[4] !== 1 && id[4] !== 2) || (id[5] !== 1 && id[5] !== 2)) throw bad();
    const wide = id[4] === 2;
    const le = id[5] === 1;
    if (wide && id.length < 64) throw bad();
    const u16 = (b: Buffer, o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
    const u32 = (b: Buffer, o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
    const word = (b: Buffer, o: number) => (wide ? Number(le ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o)) : u32(b, o));
    const shoff = word(id, wide ? 0x28 : 0x20);
    const shentsize = u16(id, wide ? 0x3a : 0x2e);
    const shnum = u16(id, wide ? 0x3c : 0x30);
    if (shoff === 0 || shnum === 0) return null;
    if (shentsize < (wide ? 64 : 40)) throw bad();
    const table = await at(shoff, shnum * shentsize);
    const section = (i: number) => {
      const o = i * shentsize;
      return {
        type: u32(table, o + 4),
        offset: word(table, o + (wide ? 24 : 16)),
        size: word(table, o + (wide ? 32 : 20)),
        link: u32(table, o + (wide ? 40 : 24)),
        info: u32(table, o + (wide ? 44 : 28)),
      };
    };
    let best: string | null = null;
    for (let i = 0; i < shnum; i++) {
      const s = section(i);
      if (s.type !== SHT_GNU_VERNEED) continue;
      if (s.link >= shnum) throw bad();
      const strtab = section(s.link);
      const strs = await at(strtab.offset, strtab.size);
      const data = await at(s.offset, s.size);
      const name = (o: number) => {
        if (o >= strs.length) throw bad();
        const z = strs.indexOf(0, o);
        return strs.subarray(o, z === -1 ? strs.length : z).toString('latin1');
      };
      // Verneed: vn_version u16, vn_cnt u16, vn_file u32, vn_aux u32, vn_next u32; Vernaux: vna_hash u32,
      // vna_flags u16, vna_other u16, vna_name u32, vna_next u32. The same in 32- and 64-bit files.
      let need = 0;
      for (let n = 0; n < Math.min(s.info, 1000); n++) {
        if (need + 16 > data.length) throw bad();
        let aux = need + u32(data, need + 8);
        for (let k = 0; k < Math.min(u16(data, need + 2), 1000); k++) {
          if (aux + 16 > data.length) throw bad();
          const m = GLIBC.exec(name(u32(data, aux + 8)));
          if (m) {
            const v = `${m[1]}.${m[2]}`;
            if (best === null || compareGlibc(v, best) > 0) best = v;
          }
          const next = u32(data, aux + 12);
          if (next === 0) break;
          aux += next;
        }
        const next = u32(data, need + 12);
        if (next === 0) break;
        need += next;
      }
    }
    return best;
  } finally {
    await fh.close();
  }
}

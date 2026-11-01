// Archives and binaries for game update tests: a tar builder (ustar, GNU long names, pax), an ELF with version needs
// like a real dynamic binary's (`readelf -V`), and a Factorio headless tarball made of them.

/** One tar entry: `type` `0` a file (the default), `5` a folder (also for a name ending in `/`), `2` a symlink, `1` a hard link, anything else as is. */
export type Entry = { name: string; type?: string; data?: string | Buffer; link?: string; mode?: number; pax?: Record<string, string> };

const BLOCK = 512;
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((BLOCK - (b.length % BLOCK)) % BLOCK)]);

function header(name: string, type: string, size: number, link: string, mode: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'latin1');
  h.write('0001750\0', 108, 'latin1');
  h.write('0001750\0', 116, 'latin1');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  h.write('15076543210\0', 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(type, 156, 'latin1');
  h.write(link, 157, 100, 'utf8');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

/** A pax record, `<length> <key>=<value>\n`, its length counting itself. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

/** A tar archive of `entries` (names over 100 bytes as GNU long names), ended by two zero blocks. */
export function tar(entries: Entry[]): Buffer {
  const out: Buffer[] = [];
  for (const e of entries) {
    const type = e.type ?? (e.name.endsWith('/') ? '5' : '0');
    const data = Buffer.from(e.data ?? '');
    let name = e.name;
    if (e.pax) {
      const body = Buffer.from(Object.entries(e.pax).map(([k, v]) => paxRecord(k, v)).join(''));
      out.push(header('PaxHeader', 'x', body.length, '', 0o644), pad(body));
    }
    if (Buffer.byteLength(name) > 100) {
      const long = Buffer.from(`${name}\0`);
      out.push(header('././@LongLink', 'L', long.length, '', 0o644), pad(long));
      name = name.slice(0, 100);
    }
    const size = type === '0' ? data.length : 0;
    out.push(header(name, type, size, e.link ?? '', e.mode ?? (type === '5' ? 0o755 : 0o644)));
    if (size > 0) out.push(pad(data));
  }
  out.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(out);
}

/**
 * An ELF file whose version needs (`.gnu.version_r`, with its `.dynstr`) ask libc.so.6 for each of `needs`, as a
 * dynamic binary's do: 64-bit little-endian like Factorio's (aarch64), or 32-bit big-endian with `wide: false, le: false`.
 */
export function fakeElf(needs: string[], { wide = true, le = true } = {}): Buffer {
  const strs = ['', 'libc.so.6', ...needs];
  const dynstr = Buffer.from(strs.join('\0') + '\0');
  const at = (s: string) => Buffer.byteLength(strs.slice(0, strs.indexOf(s)).map((x) => `${x}\0`).join(''));
  const w16 = (b: Buffer, o: number, v: number) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const w32 = (b: Buffer, o: number, v: number) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  const wN = (b: Buffer, o: number, v: number) => (wide ? (le ? b.writeBigUInt64LE(BigInt(v), o) : b.writeBigUInt64BE(BigInt(v), o)) : w32(b, o, v));

  const verneed = Buffer.alloc(16 + 16 * needs.length);
  w16(verneed, 0, 1);
  w16(verneed, 2, needs.length);
  w32(verneed, 4, at('libc.so.6'));
  w32(verneed, 8, 16);
  w32(verneed, 12, 0);
  needs.forEach((need, i) => {
    const a = 16 + 16 * i;
    w32(verneed, a, 0x0d696910 + i);
    w16(verneed, a + 6, i + 2);
    w32(verneed, a + 8, at(need));
    w32(verneed, a + 12, i === needs.length - 1 ? 0 : 16);
  });
  const shstrtab = Buffer.from('\0.dynstr\0.gnu.version_r\0.shstrtab\0');

  const ehsize = wide ? 64 : 52;
  const shentsize = wide ? 64 : 40;
  const dynOff = ehsize;
  const vrOff = dynOff + dynstr.length;
  const shsOff = vrOff + verneed.length;
  const shOff = Math.ceil((shsOff + shstrtab.length) / 8) * 8;
  const file = Buffer.alloc(shOff + 4 * shentsize);
  file.writeUInt32BE(0x7f454c46, 0);
  file[4] = wide ? 2 : 1;
  file[5] = le ? 1 : 2;
  file[6] = 1;
  w16(file, 0x10, 3);
  w16(file, 0x12, wide ? 0xb7 : 0x28);
  w32(file, 0x14, 1);
  wN(file, wide ? 0x28 : 0x20, shOff);
  w16(file, wide ? 0x34 : 0x28, ehsize);
  w16(file, wide ? 0x3a : 0x2e, shentsize);
  w16(file, wide ? 0x3c : 0x30, 4);
  w16(file, wide ? 0x3e : 0x32, 3);
  dynstr.copy(file, dynOff);
  verneed.copy(file, vrOff);
  shstrtab.copy(file, shsOff);
  const section = (i: number, name: number, type: number, offset: number, size: number, link = 0, info = 0) => {
    const o = shOff + i * shentsize;
    w32(file, o, name);
    w32(file, o + 4, type);
    wN(file, o + (wide ? 24 : 16), offset);
    wN(file, o + (wide ? 32 : 20), size);
    w32(file, o + (wide ? 40 : 24), link);
    w32(file, o + (wide ? 44 : 28), info);
  };
  section(1, 1, 3, dynOff, dynstr.length);
  section(2, 9, 0x6ffffffe, vrOff, verneed.length, 1, 1);
  section(3, 24, 3, shsOff, shstrtab.length);
  return file;
}

/** The game's own mods in a fake release: `data/<name>/info.json` (and `core`, which is no mod). */
export const OWN_MODS = ['base', 'space-age'];

/**
 * A Factorio headless tarball as factorio.com's (one top folder, `factorio/`): the x64 binary as a fake ELF needing
 * `glibc` (2.17 and 2.38, like 2.1's), the game's own mods at `version`, and `extra` entries.
 */
export function releaseTar(version: string, o: { glibc?: string[]; extra?: Entry[] } = {}): Buffer {
  const info = (name: string) => JSON.stringify({ name, version, title: name });
  return tar([
    { name: 'factorio/' },
    { name: 'factorio/bin/' },
    { name: 'factorio/bin/x64/' },
    { name: 'factorio/bin/x64/factorio', data: fakeElf(o.glibc ?? ['GLIBC_2.17', 'GLIBC_2.38', 'GLIBC_2.35']), mode: 0o755 },
    { name: 'factorio/data/' },
    { name: 'factorio/data/core/info.json', data: info('core') },
    ...OWN_MODS.map((name) => ({ name: `factorio/data/${name}/info.json`, data: info(name) })),
    { name: 'factorio/config-path.cfg', data: 'config-path=__PATH__executable__/../../config\n' },
    ...(o.extra ?? []),
  ]);
}

// The highest glibc a game update's binary needs, read from the ELF's version needs (agent/CLAUDE.md, "Trust
// boundaries"): `glibcNeed(file)`: the highest `GLIBC_X.Y` in an ELF's version needs (`.gnu.version_r` and its string
// table; 32 or 64 bit, either byte order), null if none, a malformed file throws; `compareGlibc` compares them as
// numbers. unpack.ts re-exports both.
import { constants, open } from 'node:fs/promises';

/** The ELF parts read (section headers, the version needs and their strings) are each at most this big. */
const ELF_PART_MAX = 64 * 1024 * 1024;

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

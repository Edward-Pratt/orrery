// A game update's release from its archive: Factorio's headless tarball unpacked without trusting its entries
// (agent/CLAUDE.md, "Trust boundaries"). The tar format is read in unpack-tar.ts (`Bytes`, the header fields, pax
// records, `Refused`), the path rules are in unpack-paths.ts, and the highest glibc the binary needs (`glibcNeed`,
// `compareGlibc`) in unpack-glibc.ts; this file re-exports what callers import from it.
//
// `unpack(stream, target, strip = 1)`: a tar stream (ustar, GNU long names and links, pax `path`/`linkpath`/`size`)
// into an empty folder of the agent's own, trusting no entry: checksums checked, each path's first component dropped
// (setup's `--strip-components=1`), absolute paths, `..` and NULs refused, files created
// `O_CREAT`/`O_EXCL`/`O_NOFOLLOW` with modes 755 or 644 only, nothing below a symlink of the archive, a symlink only
// relative and staying inside step by step, and at the end every one must `realpath` inside (a chain can't lead out);
// a hard link only to a file unpacked before it; any other kind (devices, FIFOs, sparse) refused; 4 GiB and 500,000
// entries at most. A refusal throws `Refused`. `unxz(file)`: `xz -dc -- <file>`'s output (no shell; Node has no xz).
import { spawn } from 'node:child_process';
import { constants, link, mkdir, open, realpath, symlink } from 'node:fs/promises';
import { posix } from 'node:path';
import { checkLink, inside } from './unpack-paths.ts';
import { BLOCK, Bytes, checksumOk, octal, parsePax, Refused, text } from './unpack-tar.ts';

export { compareGlibc, glibcNeed } from './unpack-glibc.ts';
export { Refused } from './unpack-tar.ts';

/** Far over a Factorio release unpacked (about 1 GB): a tarball that unpacks to more is refused. */
export const UNPACK_MAX = 4 * 1024 ** 3;
/** Far over a Factorio release's file count (tens of thousands). */
const ENTRIES_MAX = 500_000;
/** A GNU long name or a pax header bigger than this is no real one. */
const META_MAX = 1024 * 1024;

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

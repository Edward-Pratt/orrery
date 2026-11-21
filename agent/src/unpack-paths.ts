// The path rules `unpack` (unpack.ts) holds every entry to: each path's first component dropped (setup's
// `--strip-components=1`), absolute paths, `..` and NULs refused; a symlink only relative and staying inside step by
// step (at the end `unpack` checks that every one resolves inside, by `realpath`, so a chain can't lead out). A refusal
// throws `Refused`.
import { Refused } from './unpack-tar.ts';

/**
 * An entry's path inside the release, its first `strip` components dropped (the tarball's `factorio/`, as setup's
 * `--strip-components=1`); null for the top folder itself. An absolute path, a `..` or a NUL is refused.
 */
export function inside(name: string, strip: number): string | null {
  if (name.startsWith('/')) throw new Refused(`${name} is an absolute path`);
  if (name.includes('\0')) throw new Refused('an entry name with a NUL in it');
  const parts = name.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) throw new Refused(`${name} leads out of the release`);
  const kept = parts.slice(strip);
  return kept.length === 0 ? null : kept.join('/');
}

/** A symlink's target: relative, and staying inside the release from the link's folder, step by step. */
export function checkLink(rel: string, to: string): void {
  if (to === '' || to.startsWith('/') || to.includes('\0')) throw new Refused(`the symlink ${rel} points at an absolute path`);
  const at = rel.split('/').slice(0, -1);
  for (const part of to.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') at.push(part);
    else if (at.pop() === undefined) throw new Refused(`the symlink ${rel} leads out of the release`);
  }
}

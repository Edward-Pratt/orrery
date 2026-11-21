// How a game update touches files (`update.ts` and its modules): files in the data folder's subfolders only through
// the folder opened `O_DIRECTORY`/`O_NOFOLLOW` (`within`: `/proc/self/fd/<fd>/<name>`), each created
// `O_EXCL`/`O_NOFOLLOW` (`create`) and written whole (`writeAll`); `there`: whether a path is there, a link not followed.
import { constants, lstat, open, rm, type FileHandle } from 'node:fs/promises';

export const there = (path: string) => lstat(path).then(
  () => true,
  () => false,
);

/** `fn` on the folder `dir` opened once without following a symlink: the container may swap the folder for one. */
export async function within<T>(dir: string, fn: (base: string) => Promise<T>): Promise<T> {
  const fd = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    return await fn(`/proc/self/fd/${fd.fd}`);
  } finally {
    await fd.close();
  }
}

/** A new file at `path` (never through a link, never over one), written whole. */
export async function create(path: string): Promise<FileHandle> {
  await rm(path, { force: true }); // a file left there, or a link: removed, not followed
  return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
}

export async function writeAll(fh: FileHandle, chunk: Uint8Array): Promise<void> {
  for (let done = 0; done < chunk.length; ) done += (await fh.write(chunk, done, chunk.length - done)).bytesWritten;
}

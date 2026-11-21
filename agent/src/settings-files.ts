// The files the game settings (`settings.ts`'s `GameSettings`) read and write. `<data>/config/server-settings.json`
// and `server-adminlist.json` (`readSettingsFile`, `readAdminsFile`), each read through the config folder opened once
// (`O_DIRECTORY`, `O_NOFOLLOW`) through `files.ts`'s `within` and `readIn` (a regular file on that folder's
// filesystem, 1 MiB at most), as untrusted files that drive display only. `writeIn` writes one through the folder
// handle as `.<file>.<random>.partial` (`O_CREAT`/`O_EXCL`/`O_NOFOLLOW`, mode 600), synced and renamed over the file;
// `removePartials` (at `start`) removes partial files an exit left in the config folder. `<state>/settings.json`
// (`State`, mode 600: it holds `lastGood`'s password) keeps `lastGood`, `startedWith`, the gate's arming time, the
// failed keys and `rolledBack`, written whole after each change (`saveState`) and read back shape-checked
// (`readState`). `lastError`: Factorio's last `Error` line from `factorio-current.log` (`printable`).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { constants, lstat, mkdir, open, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { readIn, tail, within } from './files.ts';
import { ADMINS_FILE, ORDER, SETTINGS_FILE, copyModel, isObject, modelOk, parseAdmins, parseSettings, type FileRead, type Model } from './settings-rules.ts';
import { LIMITS, cut, printable } from './wire.ts';

/** `<state>/settings.json`: the Agent's own bookkeeping, holding a password (mode 600, in the folder the container never mounts). */
export type State = {
  /** The settings of the last good start that were fully readable. */
  lastGood: Model | null;
  /** What the run with this change time started with, as read when the unit became active (or when the agent came to it). */
  startedWith: { since: number; model: Model | null } | null;
  /** The start gate's arming time, or null. */
  armedAt: number | null;
  /** Live keys (and `admins`) a write couldn't apply to the running server: pending until the next start. */
  failedLive: string[];
  rolledBack: string | null;
};

export const STATE_FILE = 'settings.json';
const safeInt = (v: unknown): v is number => Number.isSafeInteger(v);

/** The state file read back, each part shape-checked; what fails is left out. */
export function readState(file: string): State {
  const state: State = { lastGood: null, startedWith: null, armedAt: null, failedLive: [], rolledBack: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return state;
  }
  if (!isObject(raw)) return state;
  if (modelOk(raw.lastGood)) state.lastGood = copyModel(raw.lastGood);
  const s = raw.startedWith;
  if (isObject(s) && safeInt(s.since)) state.startedWith = { since: s.since, model: modelOk(s.model) ? copyModel(s.model) : null };
  if (safeInt(raw.armedAt)) state.armedAt = raw.armedAt;
  if (Array.isArray(raw.failedLive)) state.failedLive = raw.failedLive.filter((k): k is string => typeof k === 'string' && ORDER.includes(k));
  if (typeof raw.rolledBack === 'string') state.rolledBack = cut(printable(raw.rolledBack), LIMITS.detail);
  return state;
}

/** One write of `<state>/settings.json` (`GameSettings` queues them one after another): mode 600, then renamed over it. */
export async function saveState(dir: string, file: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await rm(tmp, { force: true });
  await writeFile(tmp, content, { mode: 0o600, flag: 'wx' });
  await rename(tmp, file);
}

const PARTIAL = /^\.server-(settings|adminlist)\.json\.[0-9a-f]{12}\.partial$/;

/**
 * Writes `name` in `dir` whole or not at all, through the folder opened once: `.<name>.<random>.partial` created
 * there (`O_CREAT`, `O_EXCL`, `O_NOFOLLOW`, mode 600; never in /tmp, whose SELinux label the container can't read),
 * synced, then renamed over `name` (a link there is replaced, never followed).
 */
export async function writeIn(dir: string, name: string, content: string): Promise<void> {
  await within(dir, async (base) => {
    const partial = `.${name}.${randomBytes(6).toString('hex')}.partial`;
    const out = await open(`${base}/${partial}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        await out.writeFile(content);
        await out.sync();
      } finally {
        await out.close();
      }
      await rename(`${base}/${partial}`, `${base}/${name}`);
    } catch (err) {
      await unlink(`${base}/${partial}`).catch(() => {});
      throw new Error(`can't write ${name}: ${(err as NodeJS.ErrnoException).code ?? 'failed'}`);
    }
  });
}

/** Removes the partial files a write left in `config` when the agent exited during it. */
export function removePartials(config: string): Promise<void> {
  return within(config, async (base) => {
    for (const name of await readdir(base)) {
      if (!PARTIAL.test(name)) continue;
      const st = await lstat(`${base}/${name}`).catch(() => null);
      if (st?.isFile()) await unlink(`${base}/${name}`).catch(() => {});
    }
  }).catch((err: Error) => console.error(`[settings] can't look for partial files: ${printable(err.message)}`));
}

/** server-settings.json in `config`, read and parsed (`parseSettings`); a file or folder that can't be read is the problem. */
export async function readSettingsFile(config: string): Promise<FileRead> {
  try {
    const text = await within(config, (base) => readIn(base, SETTINGS_FILE));
    if (text === null) return { model: null, problem: `${SETTINGS_FILE} is missing or not a regular file`, extra: [], password: null };
    return parseSettings(text);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return { model: null, problem: e.code ? `the config folder can't be read (${e.code})` : e.message, extra: [], password: null };
  }
}

/** The adminlist's names; null when it can't be read (missing counts as none). */
export async function readAdminsFile(config: string): Promise<string[] | null> {
  try {
    const text = await within(config, (base) => readIn(base, ADMINS_FILE));
    return text === null ? [] : parseAdmins(text);
  } catch {
    return null;
  }
}

/** Factorio's last `Error` line in its log, without its uptime (e.g. `Error CommandLineMultiplayer.cpp:360: Hosting multiplayer game failed: …`). */
export async function lastError(log: string): Promise<string> {
  const lines = await tail(log, 200).catch(() => null);
  const line = lines?.findLast((l) => /^\s*\d+\.\d+ Error /.test(l));
  return line ? printable(line.replace(/^\s*\d+\.\d+ /, '')) : 'no error line in factorio-current.log';
}

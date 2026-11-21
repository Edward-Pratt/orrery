// The names, kinds, times and limits `Saves` and its flows share (`saves.ts`, `saves-folder.ts`, `saves-copy.ts`,
// `saves-upload.ts`), and their types. A save's `kind` by its name (`kindOf`: `orrery-<time>.zip` and
// `orrery-pre-update-<X.Y.Z>-<time>.zip` `named`, `_autosave*` `auto`, the rest `world`); `stamp`, the UTC time save
// names carry (`20261031T120000Z`); `loadedMap`, the path the last `Loading map <path>: <n> bytes.` engine line of
// `factorio-current.log` names (a mod's `log()` line can't match); `uploadedName`, what an upload is stored as
// (`uploaded-<time>-<the file's name in [A-Za-z0-9_-], 40 at most, or save>.zip`), and `UPLOAD_SPARE` (512 MiB), the
// room kept beside one. The constants (6 h, 20, 3, 5 s, 5 minutes) are not settings.
import type { AgentMsg, Save, SaveKind } from '../../hub/src/types.ts';
import type { UnitState } from './service.ts';

/** A named save every 6 h, if anyone played since the last one. */
export const SAVE_EVERY_MS = 6 * 60 * 60 * 1000;
/** The named saves kept (the newest; pre-update ones count), and the world files. */
export const KEEP_NAMED = 20;
export const KEEP_WORLD = 3;
/** A save is written once its file's size and time held for 5 s; it may take 5 minutes at most. */
export const STABLE_MS = 5000;
export const SAVE_WAIT_MS = 5 * 60 * 1000;
/**
 * A restored copy's time is this much newer than every other file's: `--start-server-load-latest` loads the newest
 * save, telling times apart only to the second.
 */
export const NEWER_MS = 2000;
/** Far past where Factorio logs the map it loads (its start); the rest of the log is not read. */
export const HEAD_MAX = 1024 * 1024;

/** The agent's own saves: `orrery-<time>.zip`, or before an update `orrery-pre-update-<from>-<time>.zip`. */
const NAMED = /^orrery-(?:pre-update-\d+\.\d+\.\d+-)?\d{8}T\d{6}Z\.zip$/;

/**
 * A copy while it is written: a restore's `.restored-<time>-<name>.partial` (the name a listed save's), or a game
 * update's `.orrery-pre-update-<from>-<time>.zip.partial` (`keep`).
 */
export const PARTIAL = /^\.(?:restored-\d{8}T\d{6}Z-.+|orrery-pre-update-\d+\.\d+\.\d+-\d{8}T\d{6}Z|upload-[0-9a-f]{32})\.zip\.partial$/;
/** The prefixes earlier restores put on a name: a restored copy's name carries only the newest one. */
export const RESTORED = /^(?:restored-\d{8}T\d{6}Z-)+/;

/** What kind of save a file is, by its name: the agent's (`named`), Factorio's autosave (`auto`), or anything else (`world`). */
export const kindOf = (name: string): SaveKind => (NAMED.test(name) ? 'named' : name.startsWith('_autosave') ? 'auto' : 'world');

/** A time as save names carry it, UTC: `20261031T120000Z` (`/orrery-save` takes letters, digits, `.`, `_` and `-` only). */
export const stamp = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');

/**
 * Factorio's own line for the map it loads, `<seconds> Loading map <absolute path>: <bytes> bytes.` (an engine
 * `Info File.cpp:N:` part allowed): a mod's `log()` line has `Script @__<mod>__/…` there, so it can't pass for one.
 */
const LOADING = /^ *\d+\.\d+ (?:\w+ [\w.]+:\d+: )?Loading map (\/.+): \d+ bytes\.$/;

/** The path in a log's last `Loading map` line (only whole lines count); null if it has none. */
export function loadedMap(log: string): string | null {
  const lines = log.split('\n');
  lines.pop(); // a line still being written, or nothing
  let path: string | null = null;
  for (const raw of lines) {
    const m = LOADING.exec(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
    if (m) path = m[1]!;
  }
  return path;
}

export type SavesMsg = Omit<Extract<AgentMsg, { type: 'saves' }>, 'type'>;
/** A save's outcome as the game connection's `backup` carries it. */
export type BackupResult = { ok: boolean; detail: string };

export type SavesOptions = {
  /** Factorio's saves folder, `<data>/saves`. */
  dir: string;
  /** `factorio-current.log`, whose `Loading map` line names the current world. */
  log: string;
  /** Runs an RCON command (`/orrery-save`). */
  run: (command: string) => Promise<string>;
  /** The unit's state now (a fresh `systemctl show`), for a restore. */
  unit: () => Promise<UnitState>;
  /** Between listings of the folder. */
  intervalMs?: number;
  /** Between looks at a save being written. */
  pollMs?: number;
  stableMs?: number;
  waitMs?: number;
  /** Wall-clock time (epoch ms): save names, the 6 h schedule, a restored copy's time. */
  now?: () => number;
};

export const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
/** A unit no Factorio runs from: a restore copies only then. */
export const isStopped = (unit: UnitState) => unit.active === 'inactive' || unit.active === 'failed';
export const span = (ms: number) => (ms >= 60_000 ? `${ms / 60_000} minutes` : `${ms / 1000} s`);
/** The saves of a kind past the newest `keep` (the list is newest first). */
export const past = (saves: Save[], kind: SaveKind, keep: number) => saves.filter((s) => s.kind === kind).slice(keep);

/** Whether `/orrery-save`'s reply is `{"ok": true, "name": <name>}`. */
export function saved(reply: string, name: string): boolean {
  try {
    const r = JSON.parse(reply) as unknown;
    return typeof r === 'object' && r !== null && (r as Record<string, unknown>).ok === true && (r as Record<string, unknown>).name === name;
  } catch {
    return false;
  }
}

/** What an uploaded save is stored as: `uploaded-<time>-<name>`, `name` the file's own without `.zip`, in safe characters only. */
export function uploadedName(file: string, ms: number): string {
  const safe = file.replace(/\.zip$/i, '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'save';
  return `uploaded-${stamp(ms)}-${safe}.zip`;
}

/** At least this much stays free beside an upload. */
export const UPLOAD_SPARE = 512 * 1024 * 1024;

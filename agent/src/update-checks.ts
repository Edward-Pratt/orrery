// A game update's input checks and its names (`Updates` in `update.ts`; agent/CLAUDE.md, "Trust boundaries"). The hub's
// `update` is checked first (`checkUpdate`; a refusal is the reply's `error`): versions `X.Y.Z`, mod names
// `^[A-Za-z0-9_. -]+$` with no `..`, each once, `orrery` among them (the gate reads its `/orrery-status`), hex hashes,
// a headless build for `process.arch` (arm64, or x64 for the dev loop), and every URL through `allowedUrl`: https on
// `ALLOWED_HOSTS` (`www.factorio.com`, `dl.factorio.com`, `dl-mod.factorio.com`: one constant, the last S11's mod CDN
// host), no port, no user. `updateDone`'s names (`labels`: `from`/`to` as the hub names its row, "2.1.24 · 5 mods",
// every enabled mod counted, the game's own (`GAME_MODS`, the hub's list) included; `from` the latest `installed` (the
// `installed` option: `HubClient`'s, kept across restarts), `to` the update's version with the game's own enabled in it
// and the update's mods; the bare versions before any `installed`). `installedOf`: a `Status` as `installed`. The
// version, mod name and release patterns, and the headless builds, the other update modules check with.
import type { AgentMsg } from '../../hub/src/types.ts';
import type { Status } from './status.ts';
import { LIMITS, cut, type Request } from './wire.ts';

/**
 * The only hosts an update's downloads come from, and the only ones a redirect may lead to: factorio.com's game
 * downloads, and the mod portal's CDN. S11 (2026-10-31) found that the portal's authenticated mod download answers
 * 302 to dl-mod.factorio.com, whose only query key is `secure` (a signed link, no credentials).
 */
export const ALLOWED_HOSTS: readonly string[] = ['www.factorio.com', 'dl.factorio.com', 'dl-mod.factorio.com'];

/** A Factorio version, and a mod's: `X.Y.Z`. */
export const VERSION = /^\d+\.\d+\.\d+$/;
/** A mod portal name (and never a `..` in it). */
export const MOD_NAME = /^[A-Za-z0-9_. -]+$/;
/** `/opt/factorio/current`'s target, as setup writes it: relative, to one release. */
export const RELEASE = /^releases\/(\d+\.\d+\.\d+)$/;

/** The headless build for this machine's architecture: its file in factorio.com's sha256 list, and its `bin/` folder. */
export const BUILDS: Record<string, { tarball: (version: string) => string; bin: string }> = {
  arm64: { tarball: (v) => `factorio-headless_linux-arm64_${v}.tar.xz`, bin: 'arm64' },
  x64: { tarball: (v) => `factorio-headless_linux_${v}.tar.xz`, bin: 'x64' },
};

/** The `installed` message's fields. */
export type InstalledMsg = Omit<Extract<AgentMsg, { type: 'installed' }>, 'type'>;

/** The game's own mods, as the hub counts them in an update's `to` (`GAME_MODS` in hub/src/updates/factorio.ts; a test compares). */
export const GAME_MODS: readonly string[] = ['base', 'elevated-rails', 'quality', 'recycler', 'space-age'];

/**
 * `updateDone`'s `from` and `to`, as the hub names its row (docs/protocol.md, "Game updates"): "2.1.24 · 5 mods",
 * every enabled mod counted, the game's own included. `from`: the latest `installed`; `to`: the update's version, with
 * the game's own mods enabled in that `installed` and the update's mods (one new in the target release is enabled too,
 * but neither side counts it: it is first seen in prepare). With no `installed` yet: the bare versions (`from` the
 * release `current` points at).
 */
export function labels(installed: InstalledMsg | null, current: string, req: Request<'update'>): { from: string; to: string } {
  if (!installed) return { from: current, to: req.factorio.version };
  const game = installed.mods.filter((m) => GAME_MODS.includes(m.name)).length;
  return { from: label(installed.factorio, installed.mods.length), to: label(req.factorio.version, game + req.mods.length) };
}
/** Within the hub's 256 characters for a string even for an absurd version. */
const label = (version: string, n: number) => cut(`${version} · ${n} mod${n === 1 ? '' : 's'}`, LIMITS.text);
/** What `/orrery-status` says runs: the game's version and every enabled mod (`base` and the game's own included), by name. */
export const installedOf = (s: Status): InstalledMsg => ({
  factorio: s.version,
  mods: Object.entries(s.mods)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, version]) => ({ name, version })),
});

/**
 * `url` checked as the hub's download link (or a redirect's target): https, on `ALLOWED_HOSTS`, no port, no user. The
 * errors never show the URL's query string.
 */
export function allowedUrl(url: string, what: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${what} is not a URL`);
  }
  if (u.protocol !== 'https:') throw new Error(`${what} is not https`);
  if (!ALLOWED_HOSTS.includes(u.hostname)) throw new Error(`${what} is on ${u.hostname}, not a host updates come from (${ALLOWED_HOSTS.join(', ')})`);
  if (u.port !== '' || u.username !== '' || u.password !== '') throw new Error(`${what} names a port or a user`);
  return u;
}

/**
 * The hub's `update` checked before anything happens (the reply refuses it): versions `X.Y.Z`, mod names of letters,
 * digits, `_`, `.`, `-` and spaces with no `..`, each mod once, `orrery` among them (the gate reads its
 * `/orrery-status`), hashes in hex, every URL allowed (`allowedUrl`), and a headless build for this machine.
 */
export function checkUpdate(req: Request<'update'>, arch: string): void {
  const { factorio, mods } = req;
  if (!BUILDS[arch]) throw new Error(`there is no Factorio headless build for this machine (${arch})`);
  if (!VERSION.test(factorio.version)) throw new Error(`${JSON.stringify(factorio.version)} is not a Factorio version (X.Y.Z)`);
  allowedUrl(factorio.url, `Factorio ${factorio.version}'s download`);
  if (!/^[0-9a-f]{64}$/.test(factorio.sha256)) throw new Error(`Factorio ${factorio.version}'s sha256 is not 64 hex digits`);
  const names = new Set<string>();
  for (const mod of mods) {
    if (!MOD_NAME.test(mod.name) || mod.name.includes('..')) throw new Error(`${JSON.stringify(mod.name)} is not a mod name`);
    if (names.has(mod.name)) throw new Error(`${mod.name} is in the mods twice`);
    names.add(mod.name);
    if (!VERSION.test(mod.version)) throw new Error(`${JSON.stringify(mod.version)} is not a version of ${mod.name} (X.Y.Z)`);
    allowedUrl(mod.url, `${mod.name} ${mod.version}'s download`);
    if (!/^[0-9a-f]{40}$/.test(mod.sha1)) throw new Error(`${mod.name} ${mod.version}'s sha1 is not 40 hex digits`);
  }
  if (!names.has('orrery')) throw new Error('the mods must include orrery: the health gate reads its /orrery-status');
}

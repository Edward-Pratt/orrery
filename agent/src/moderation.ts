// Moderation of the server's players (docs/notes/factorio-game-extras.md, "Part 2"): its bans and admins read from
// Factorio's own files, and kick, ban, unban, promote and demote as Factorio's own commands, built here from a name
// checked by the rule and a cleaned reason. The files are written by the container, so untrusted: they drive what is
// shown and how an action ended, never a command. Factorio's reply is never read for the outcome, nor sent on.
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Ban, ModerateOutcome, PlayerLists } from '../../hub/src/types.ts';
import { readIn, within } from './files.ts';
import { ADMINS_FILE, parseAdmins, SETTINGS_FILE } from './settings.ts';
import type { UnitState } from './service.ts';
import { parseStatus } from './status.ts';
import { cut, GAME_SETTINGS, LIMITS, type Request } from './wire.ts';

/** Factorio writes the banlist in its write-data folder (no `--server-banlist`), the adminlist in `config/`. */
export const BANS_FILE = 'server-banlist.json';

/** What a reason may not hold: C0, DEL, C1, the line and paragraph separators, the bidi controls and the BOM. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** A reason as one printable line of at most `LIMITS.reason` characters: what isn't safe becomes a space, runs of spaces one; null when empty. */
export function cleanReason(text: string): string | null {
  const clean = cut(text.replace(UNSAFE, ' ').replace(/\s+/g, ' ').trim(), LIMITS.reason).trim();
  return clean || null;
}

/** The banlist's text: each entry a name or `{ username, reason }` (every other key, an address too, ignored); null if not a list. */
export function parseBans(text: string): { bans: Ban[]; hidden: number } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const bans: Ban[] = [];
  let hidden = 0;
  for (const e of raw) {
    const entry = typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : null;
    const name = typeof e === 'string' ? e : typeof entry?.username === 'string' ? entry.username : null;
    if (name === null || !GAME_SETTINGS.admin.test(name)) {
      hidden++;
      continue;
    }
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    bans.push({ name, reason: typeof entry?.reason === 'string' ? cleanReason(entry.reason) : null });
  }
  bans.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { bans, hidden };
}

export type ModerationOptions = {
  /** The server's write-data folder (`config/` holds the adminlist and settings). */
  data: string;
  /** An RCON command on the hub's commands session; rejects when RCON can't run it. */
  run: (command: string) => Promise<string>;
  /** The players at the latest `/orrery-status`. */
  players: () => readonly string[];
  unit: () => UnitState | null;
  /** `require_user_verification` as the running server started with it; null when unknown (the file says then). */
  verification: () => boolean | null;
  /** After a promote or demote: the game settings read again and pushed, so the Settings tab follows. */
  adminsChanged: () => void;
  /** How long a ban, an unban, a promote or a demote has to show in its file, polled every `pollMs`; a kick's wait between its two status reads. */
  waitMs?: number;
  pollMs?: number;
};

type Read = { lists: PlayerLists; banned: Set<string>; admins: Set<string> };
type Ok = { text: string | null } | { problem: string };

/** The `playerLists` and `moderate` handlers. One `moderate` at a time. */
export class Moderation {
  #o: Required<ModerationOptions>;
  #running = false;

  constructor(o: ModerationOptions) {
    this.#o = { waitMs: 3000, pollMs: 200, ...o };
  }

  async lists(): Promise<PlayerLists> {
    return (await this.#read()).lists;
  }

  async act({ action, player, reason }: Request<'moderate'>): Promise<{ outcome: ModerateOutcome; lists: PlayerLists }> {
    if (!GAME_SETTINGS.admin.test(player)) throw new Error('not a player name');
    if (this.#running) throw new Error('a moderation request is running');
    this.#running = true;
    try {
      if (this.#o.unit()?.active !== 'active') throw new Error("the server isn't running");
      const why = action === 'kick' || action === 'ban' ? cleanReason(reason ?? '') : null;
      const before = await this.#read();
      let name = player;
      if (action === 'kick') {
        const online = await this.#online(player);
        if (online === null) return this.#end(action, player, 'notOnline', before.lists);
        name = online; // the status's spelling: it passed the status checks, and the rule below
        if (!GAME_SETTINGS.admin.test(name)) throw new Error('not a player name');
      }
      await this.#send(`/${action} ${name}${why ? ` ${why}` : ''}`);
      if (action === 'kick') return this.#end(action, name, (await this.#kicked(name)) ? 'done' : 'unconfirmed', (await this.#read()).lists);
      const key = name.toLowerCase();
      const has = (r: Read) => (action === 'ban' || action === 'unban' ? r.banned : r.admins).has(key);
      const wanted = action === 'ban' || action === 'promote';
      if (has(before) === wanted) return this.#end(action, name, 'already', before.lists);
      const after = await this.#until((r) => has(r) === wanted);
      if (action === 'promote' || action === 'demote') this.#o.adminsChanged();
      return this.#end(action, name, has(after) === wanted ? 'done' : 'unconfirmed', after.lists);
    } finally {
      this.#running = false;
    }
  }

  /** Logs the action, the name and the outcome (never the reason), and answers. */
  #end(action: string, name: string, outcome: ModerateOutcome, lists: PlayerLists) {
    console.log(`[moderation] ${action} ${name}: ${outcome}`);
    return { outcome, lists };
  }

  async #send(command: string): Promise<void> {
    try {
      await this.#o.run(command);
    } catch {
      throw new Error("Factorio didn't answer");
    }
  }

  /** `player`'s spelling among those online: the latest status's, else a fresh `/orrery-status`'s; null if not on. */
  async #online(player: string): Promise<string | null> {
    const key = player.toLowerCase();
    const latest = this.#o.players().find((p) => p.toLowerCase() === key);
    if (latest !== undefined) return latest;
    const fresh = await this.#fresh();
    if (fresh === null) throw new Error("the server's status can't be read");
    return fresh.find((p) => p.toLowerCase() === key) ?? null;
  }

  /** The players a fresh `/orrery-status` names; null when its reply isn't a status. */
  async #fresh(): Promise<string[] | null> {
    let reply: string;
    try {
      reply = await this.#o.run('/orrery-status');
    } catch {
      throw new Error("Factorio didn't answer");
    }
    return parseStatus(reply)?.players ?? null;
  }

  /** Whether a fresh status lacks `name`: asked twice, `waitMs` apart at most. A reply that isn't a status confirms nothing. */
  async #kicked(name: string): Promise<boolean> {
    for (let i = 0; i < 2; i++) {
      await sleep(i ? this.#o.waitMs : Math.min(this.#o.pollMs, this.#o.waitMs));
      const fresh = await this.#fresh();
      if (fresh !== null && !fresh.some((p) => p.toLowerCase() === name.toLowerCase())) return true;
    }
    return false;
  }

  /** The lists read again until `done` holds or `waitMs` passed. */
  async #until(done: (r: Read) => boolean): Promise<Read> {
    const end = performance.now() + this.#o.waitMs;
    for (;;) {
      const r = await this.#read();
      if (done(r) || performance.now() >= end) return r;
      await sleep(this.#o.pollMs);
    }
  }

  async #read(): Promise<Read> {
    const config = join(this.#o.data, 'config');
    const [bansFile, adminsFile, settingsFile] = await Promise.all([this.#file(this.#o.data, BANS_FILE), this.#file(config, ADMINS_FILE), this.#file(config, SETTINGS_FILE)]);
    const problems: string[] = [];
    let bans: Ban[] = [];
    let hidden = 0;
    if ('problem' in bansFile) problems.push(bansFile.problem);
    else if (bansFile.text !== null) {
      const parsed = parseBans(bansFile.text);
      if (parsed) ({ bans, hidden } = parsed);
      else problems.push(`${BANS_FILE} can't be read: not a JSON list.`);
    }
    let admins: string[] = [];
    if ('problem' in adminsFile) problems.push(adminsFile.problem);
    else if (adminsFile.text !== null) {
      const parsed = parseAdmins(adminsFile.text);
      if (parsed) admins = parsed;
      else problems.push(`${ADMINS_FILE} can't be read: not a JSON list.`);
    }
    const lists: PlayerLists = {
      bans: bans.slice(0, LIMITS.bans),
      bansTotal: bans.length,
      hidden,
      admins,
      verification: this.#o.verification() ?? verificationIn(settingsFile),
      problem: problems.length ? problems.join(' ') : null,
    };
    return { lists, banned: new Set(bans.map((b) => b.name.toLowerCase())), admins: new Set(admins.map((a) => a.toLowerCase())) };
  }

  /** A file's text (null when missing, or not a plain file), or why it can't be read, in fixed words. */
  async #file(dir: string, name: string): Promise<Ok> {
    try {
      return { text: await within(dir, (base) => readIn(base, name)) };
    } catch (err) {
      return { problem: `${name} can't be read: ${/over 1 MiB/.test((err as Error).message) ? 'larger than 1 MiB' : 'not readable'}.` };
    }
  }
}

/** `require_user_verification` from server-settings.json's text, when it is a boolean. */
function verificationIn(file: Ok): boolean | null {
  if (!('text' in file) || file.text === null) return null;
  try {
    const v = (JSON.parse(file.text) as Record<string, unknown>)?.require_user_verification;
    return typeof v === 'boolean' ? v : null;
  } catch {
    return null;
  }
}

import { randomInt } from 'node:crypto';
import type { Db } from './db.ts';
import type { ServerHub } from './servers.ts';
import type { Game } from './types.ts';

/** No 0/O or 1/I: codes are typed by hand in game. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CODE_MS = 10 * 60_000;
/** Wrong codes in a code's lifetime that lock a name (per game). */
const MAX_FAILS = 5;
/**
 * Wrong codes in a code's lifetime that lock a factorio server, whoever typed them, so fresh names can't guess on: with
 * 32^6 (about 10^9) codes, 20 guesses per 10 minutes find a given live code with a chance of about 2 in 10^8. Only
 * there: its Agent's link messages name any player it likes, while a Mod's come from players on the server (trusted
 * input), whom the per-name lock is enough for.
 */
const MAX_SERVER_FAILS = 20;
/** Names with recent wrong codes kept at most: past it the oldest are dropped. */
const FAILS_KEPT = 1000;
const TOO_MANY = 'Too many attempts; try again in a few minutes.';

export type RedeemResult = { ok: boolean; message: string; discordId?: string };

/**
 * Discord ↔ game account linking: `/link` issues a code, typed in game it is redeemed (`/discord link <code>` in
 * Minecraft, `/orrery-link <code>` in Factorio). A Discord user's link holds a name per game: the Minecraft one in
 * `links`, the Factorio one in `factorio_links`. Codes live in memory only. Handles the game connections' link/unlink
 * messages itself, by the server's game, and announces a new link on the hub's event stream. Hub core.
 */
export class Links {
  #db: Db;
  #codes = new Map<string, { discordId: string; discordName: string; expires: number }>();
  // "<game>:<lower-case player>" -> recent failed attempt times, in the order of each one's newest (oldest first)
  #fails = new Map<string, number[]>();
  #serverFails = new Map<string, number[]>(); // factorio server id -> recent failed attempt times

  constructor(db: Db, hub: Pick<ServerHub, 'on' | 'get' | 'sendLinkResult' | 'announce'>) {
    this.#db = db;
    hub.on('event', (e) => {
      if (e.type !== 'link' && e.type !== 'unlink') return;
      const game = hub.get(e.serverId)?.game;
      if (!game) return;
      if (e.type === 'link') {
        const result = this.redeem(e.code, game, e.player, e.uuid, Date.now(), e.serverId);
        hub.sendLinkResult(e.serverId, e.player, result.ok, result.message);
        if (result.ok && result.discordId) hub.announce(e.serverId, { type: 'linked', player: e.player, discordId: result.discordId });
      } else {
        // A player unlinks only their own game's link: a Factorio name never removes a Minecraft link of that name.
        const removed = game === 'factorio' ? this.#db.unlinkFactorioPlayer(e.player) : this.#db.unlinkPlayer(e.player);
        hub.sendLinkResult(e.serverId, e.player, removed, removed ? 'Unlinked from Discord.' : "You weren't linked.");
      }
    });
  }

  /** A fresh code for this Discord user (replacing any earlier one), valid for 10 minutes. */
  issue(discordId: string, discordName: string, now = Date.now()): string {
    this.#sweep(now);
    for (const [code, entry] of this.#codes) {
      if (entry.discordId === discordId || entry.expires <= now) this.#codes.delete(code);
    }
    let code: string;
    do {
      code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    } while (this.#codes.has(code));
    this.#codes.set(code, { discordId, discordName, expires: now + CODE_MS });
    return code;
  }

  /** How many names have recent wrong codes on record (at most 1000). */
  get failing(): number {
    return this.#fails.size;
  }

  /**
   * Links the code's Discord user to `player` in `game` (`uuid`: Minecraft's; Factorio has none), replacing that user's
   * and that name's earlier link in the game. Wrong codes are counted per game and name (five in 10 minutes lock it)
   * and, in Factorio, per server it was typed on (`serverId`, the game's name when not given; twenty in 10 minutes lock
   * it for everyone, a right code too, so fresh names can't guess on).
   */
  redeem(code: string, game: Game, player: string, uuid: string, now = Date.now(), serverId: string = game): RedeemResult {
    this.#sweep(now);
    const serverFails = (this.#serverFails.get(serverId) ?? []).filter((t) => now - t < CODE_MS);
    if (game === 'factorio' && serverFails.length >= MAX_SERVER_FAILS) return { ok: false, message: TOO_MANY };
    const key = `${game}:${player.toLowerCase()}`;
    const fails = (this.#fails.get(key) ?? []).filter((t) => now - t < CODE_MS);
    if (fails.length >= MAX_FAILS) return { ok: false, message: TOO_MANY };
    const normalized = code.trim().toUpperCase();
    const entry = this.#codes.get(normalized);
    if (!entry || entry.expires <= now) {
      if (game === 'factorio') this.#serverFails.set(serverId, [...serverFails, now]);
      this.#fails.delete(key); // re-added last: the Map stays in the order of each name's newest attempt
      this.#fails.set(key, [...fails, now]);
      for (const oldest of this.#fails.keys()) {
        if (this.#fails.size <= FAILS_KEPT) break;
        this.#fails.delete(oldest);
      }
      return { ok: false, message: 'That code is unknown or expired. Use /link in Discord for a new one.' };
    }
    this.#codes.delete(normalized);
    this.#fails.delete(key);
    if (game === 'factorio') this.#db.linkFactorio(entry.discordId, player, now);
    else this.#db.link(entry.discordId, player, uuid, now);
    return { ok: true, message: `Linked to ${entry.discordName} on Discord.`, discordId: entry.discordId };
  }

  /** Drops the names and servers whose newest wrong code is older than a code's lifetime. */
  #sweep(now: number): void {
    for (const fails of [this.#fails, this.#serverFails]) {
      for (const [key, times] of fails) if (now - times.at(-1)! >= CODE_MS) fails.delete(key);
    }
  }

  /** Discord's `/unlink`: the user's links in every game. */
  unlinkDiscord(discordId: string): boolean {
    return this.#db.unlinkDiscord(discordId);
  }
}

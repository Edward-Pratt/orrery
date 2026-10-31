import { randomInt } from 'node:crypto';
import type { Db } from './db.ts';
import type { ServerHub } from './servers.ts';
import type { Game } from './types.ts';

/** No 0/O or 1/I: codes are typed by hand in game. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CODE_MS = 10 * 60_000;
const MAX_FAILS = 5;

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
  #fails = new Map<string, number[]>(); // "<game>:<lower-case player>" -> recent failed attempt times

  constructor(db: Db, hub: Pick<ServerHub, 'on' | 'get' | 'sendLinkResult' | 'announce'>) {
    this.#db = db;
    hub.on('event', (e) => {
      if (e.type !== 'link' && e.type !== 'unlink') return;
      const game = hub.get(e.serverId)?.game;
      if (!game) return;
      if (e.type === 'link') {
        const result = this.redeem(e.code, game, e.player, e.uuid);
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

  /**
   * Links the code's Discord user to `player` in `game` (`uuid`: Minecraft's; Factorio has none), replacing that user's
   * and that name's earlier link in the game. Wrong codes are counted per game and name: five in 10 minutes lock it.
   */
  redeem(code: string, game: Game, player: string, uuid: string, now = Date.now()): RedeemResult {
    const key = `${game}:${player.toLowerCase()}`;
    const fails = (this.#fails.get(key) ?? []).filter((t) => now - t < CODE_MS);
    if (fails.length >= MAX_FAILS) return { ok: false, message: 'Too many attempts; try again in a few minutes.' };
    const normalized = code.trim().toUpperCase();
    const entry = this.#codes.get(normalized);
    if (!entry || entry.expires <= now) {
      this.#fails.set(key, [...fails, now]);
      return { ok: false, message: 'That code is unknown or expired. Use /link in Discord for a new one.' };
    }
    this.#codes.delete(normalized);
    this.#fails.delete(key);
    if (game === 'factorio') this.#db.linkFactorio(entry.discordId, player, now);
    else this.#db.link(entry.discordId, player, uuid, now);
    return { ok: true, message: `Linked to ${entry.discordName} on Discord.`, discordId: entry.discordId };
  }

  /** Discord's `/unlink`: the user's links in every game. */
  unlinkDiscord(discordId: string): boolean {
    return this.#db.unlinkDiscord(discordId);
  }
}

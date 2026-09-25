import { randomInt } from 'node:crypto';
import type { Db } from './db.ts';
import type { ServerHub } from './servers.ts';

/** No 0/O or 1/I: codes are typed by hand in game. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CODE_MS = 10 * 60_000;
const MAX_FAILS = 5;

export type RedeemResult = { ok: boolean; message: string; discordId?: string };

/**
 * Discord ↔ Minecraft account linking: `/link` issues a code, `/discord link <code>` in game redeems it. Codes live
 * in memory only. Handles the mod's link/unlink messages itself and announces a new link on the hub's event stream.
 * Hub core.
 */
export class Links {
  #db: Db;
  #codes = new Map<string, { discordId: string; discordName: string; expires: number }>();
  #fails = new Map<string, number[]>(); // lower-case player -> recent failed attempt times

  constructor(db: Db, hub: Pick<ServerHub, 'on' | 'sendLinkResult' | 'announce'>) {
    this.#db = db;
    hub.on('event', (e) => {
      if (e.type === 'link') {
        const result = this.redeem(e.code, e.player, e.uuid);
        hub.sendLinkResult(e.serverId, e.player, result.ok, result.message);
        if (result.ok && result.discordId) hub.announce(e.serverId, { type: 'linked', player: e.player, discordId: result.discordId });
      } else if (e.type === 'unlink') {
        const removed = this.#db.unlinkPlayer(e.player);
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

  redeem(code: string, player: string, uuid: string, now = Date.now()): RedeemResult {
    const key = player.toLowerCase();
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
    this.#db.link(entry.discordId, player, uuid, now);
    return { ok: true, message: `Linked to ${entry.discordName} on Discord.`, discordId: entry.discordId };
  }

  unlinkDiscord(discordId: string): boolean {
    return this.#db.unlinkDiscord(discordId);
  }
}

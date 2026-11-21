// `Db`'s account links layer (over `db-uptime.ts`): `links` (a Discord user's Minecraft name and uuid, `link`,
// `unlinkPlayer`, `linkByDiscord`, `linkByPlayer`) and `factorio_links`, its own table so `links` stays as an older hub
// reads it (a Discord user's Factorio name, unique without case, `linkFactorio`, `unlinkFactorioPlayer`,
// `factorioLinkByDiscord`, `factorioLinkByName`); a link replaces that user's and that name's earlier one in its own
// table only; `unlinkDiscord` clears both. Writes never throw.

import { UptimeDb } from './db-uptime.ts';

/** `Db`'s account links in every game. */
export class LinksDb extends UptimeDb {
  /** Links a Discord account to a Minecraft player, replacing any earlier Minecraft link of either. */
  link(discordId: string, player: string, uuid: string, ts: number): void {
    this.write('unlink old', 'DELETE FROM links WHERE discord_id = ? OR player = ? COLLATE NOCASE', discordId, player);
    this.write('link', 'INSERT INTO links (discord_id, player, uuid, linked_at) VALUES (?, ?, ?, ?)', discordId, player, uuid, ts);
  }

  /**
   * Links a Discord account to a Factorio name, replacing any earlier Factorio link of either. Its own table, so the
   * `links` table an older hub reads stays as it was (its `uuid` is required, and Factorio has none).
   */
  linkFactorio(discordId: string, name: string, ts: number): void {
    this.write('unlink old', 'DELETE FROM factorio_links WHERE discord_id = ? OR name = ? COLLATE NOCASE', discordId, name);
    this.write('link', 'INSERT INTO factorio_links (discord_id, name, linked_at) VALUES (?, ?, ?)', discordId, name, ts);
  }

  /** Removes a Discord account's links in every game. True if one was removed. */
  unlinkDiscord(discordId: string): boolean {
    const minecraft = this.#delete('DELETE FROM links WHERE discord_id = ?', discordId);
    const factorio = this.#delete('DELETE FROM factorio_links WHERE discord_id = ?', discordId);
    return minecraft || factorio;
  }

  /** Removes a Minecraft player's link (never a Factorio one of the same name). */
  unlinkPlayer(player: string): boolean {
    return this.#delete('DELETE FROM links WHERE player = ? COLLATE NOCASE', player);
  }

  /** Removes a Factorio name's link (never a Minecraft one of the same name). */
  unlinkFactorioPlayer(name: string): boolean {
    return this.#delete('DELETE FROM factorio_links WHERE name = ? COLLATE NOCASE', name);
  }

  #delete(sql: string, param: string): boolean {
    try {
      return Number(this.handle.prepare(sql).run(param).changes) > 0;
    } catch (err) {
      console.error('[db] unlink failed:', (err as Error).message);
      return false;
    }
  }

  linkByDiscord(discordId: string): { player: string; uuid: string } | null {
    const row = this.handle.prepare('SELECT player, uuid FROM links WHERE discord_id = ?').get(discordId) as
      | { player: string; uuid: string }
      | undefined;
    return row ? { player: row.player, uuid: row.uuid } : null;
  }

  linkByPlayer(player: string): { discordId: string; player: string } | null {
    const row = this.handle.prepare('SELECT discord_id, player FROM links WHERE player = ? COLLATE NOCASE').get(player) as
      | { discord_id: string; player: string }
      | undefined;
    return row ? { discordId: row.discord_id, player: row.player } : null;
  }

  factorioLinkByDiscord(discordId: string): { name: string } | null {
    const row = this.handle.prepare('SELECT name FROM factorio_links WHERE discord_id = ?').get(discordId) as { name: string } | undefined;
    return row ? { name: row.name } : null;
  }

  factorioLinkByName(name: string): { discordId: string; name: string } | null {
    const row = this.handle.prepare('SELECT discord_id, name FROM factorio_links WHERE name = ? COLLATE NOCASE').get(name) as
      | { discord_id: string; name: string }
      | undefined;
    return row ? { discordId: row.discord_id, name: row.name } : null;
  }
}

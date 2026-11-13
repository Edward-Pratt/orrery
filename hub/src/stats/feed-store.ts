// `FeedStore`, held by `Db` as `db.feed` on the same handle: the SQL behind the live feed's chat and console (the
// `feed` table, each event as JSON under its feed id). `record`, which every `FEED_CAP_EVERY` (100) inserts of a
// server deletes its rows beyond the newest `FEED_CAP` (10,000), so a flood stays bounded until the nightly prune;
// `newest(serverId)` the newest `FEED_KEPT` (500); `maxId`; `prune` (nightly, from `Db.maintain`: all but each
// server's newest 500 rows); and the feed's reserved ids (`reserve`, `reserved`: one number, `feed_reserved` in `Db`'s
// `meta` table, which an older hub after a Rollback ignores), so ids of events that are not stored are never issued
// twice either. Writes never throw: a database error is logged, as `Db`'s are. Hub core.

import type { DatabaseSync } from 'node:sqlite';
import type { FeedEvent } from '../servers/servers.ts';

/** A server's chat and console entries kept for the live feed, in its memory and in the `feed` table. */
export const FEED_KEPT = 500;
/**
 * A server's `feed` rows kept at most between nightly prunes, checked every `FEED_CAP_EVERY` of its inserts (so at
 * most 10,099 rows, about 10 MB of 1 KiB chat lines). Only the newest `FEED_KEPT` are ever read, so the cap loses
 * nothing anyone sees; it is 20 times that, so a Minecraft server (a few hundred lines a day) never reaches it, while
 * an Agent's chat at its budget (2/s, up to ~170,000 rows a day) stays bounded until the prune.
 */
export const FEED_CAP = 10_000;
export const FEED_CAP_EVERY = 100;

export class FeedStore {
  #db: DatabaseSync;
  #inserts = new Map<string, number>(); // per server, since its last cap check

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  #write(label: string, sql: string, ...params: (string | number | null)[]): void {
    try {
      this.#db.prepare(sql).run(...params);
    } catch (err) {
      console.error(`[db] ${label} failed:`, (err as Error).message);
    }
  }

  /**
   * A live feed event (a chat line or console entry) under its feed id, kept as JSON. Every `FEED_CAP_EVERY` inserts of
   * a server, its rows beyond the newest `FEED_CAP` are deleted.
   */
  record(id: number, e: FeedEvent & { serverId: string }): void {
    this.#write('feed', 'INSERT INTO feed (id, server_id, at, event) VALUES (?, ?, ?, ?)', id, e.serverId, e.at, JSON.stringify(e));
    const n = (this.#inserts.get(e.serverId) ?? 0) + 1;
    this.#inserts.set(e.serverId, n % FEED_CAP_EVERY);
    if (n < FEED_CAP_EVERY) return;
    this.#write(
      'cap feed',
      'DELETE FROM feed WHERE server_id = ? AND id <= (SELECT id FROM feed WHERE server_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)',
      e.serverId,
      e.serverId,
      FEED_CAP,
    );
  }

  /** A server's newest `limit` stored feed events, oldest first. */
  newest(serverId: string, limit = FEED_KEPT): [number, FeedEvent][] {
    return this.#db
      .prepare('SELECT id, event FROM feed WHERE server_id = ? ORDER BY id DESC LIMIT ?')
      .all(serverId, limit)
      .map((r): [number, FeedEvent] => [r.id as number, JSON.parse(r.event as string) as FeedEvent])
      .reverse();
  }

  /** The highest stored feed id, of any server (removed ones too); 0 if there is none. */
  maxId(): number {
    return ((this.#db.prepare('SELECT MAX(id) AS id FROM feed').get() as { id: number | null }).id ?? 0);
  }

  /** The id the live feed's reserved ids end below: every id it has issued is under it. 0 if it reserved none yet. */
  reserved(): number {
    const row = this.#db.prepare("SELECT value FROM meta WHERE key = 'feed_reserved'").get() as { value: number } | undefined;
    return row?.value ?? 0;
  }

  /** Reserves every id below `to` for the live feed, which calls it before issuing them. Never lowers what is reserved. */
  reserve(to: number): void {
    this.#write(
      'reserve feed ids',
      "INSERT INTO meta (key, value) VALUES ('feed_reserved', ?) ON CONFLICT (key) DO UPDATE SET value = MAX(value, excluded.value)",
      to,
    );
  }

  /** Nightly: all but each server's newest `FEED_KEPT` rows. */
  prune(): void {
    this.#write(
      'prune feed',
      'DELETE FROM feed WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY server_id ORDER BY id DESC) AS n FROM feed) WHERE n > ?)',
      FEED_KEPT,
    );
  }
}

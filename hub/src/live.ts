import { EventEmitter } from 'node:events';
import { FEED_KEPT, type Db } from './db.ts';
import type { FeedEvent, LiveEvent, ServerHub } from './servers.ts';

/** A server's events kept in `Db` too, so its Chat and Console panes survive a hub restart. */
const STORED = new Set<string>(['chat', 'join', 'leave', 'death', 'say', 'console']);

/**
 * Numbers every hub event, stamps it with the time it arrived (`at`), and keeps the last `perTarget` of each server's (and each host's, service's and check's)
 * in memory, so a live stream can replay them and resume after a given id. TPS events, host samples and check results stay
 * out of that buffer (they would push chat and notices out): only the latest of each is kept, a server's TPS until it goes
 * down, a server's latest `packUpdateStep` until its update finishes, and a library add's latest progress until it
 * finishes. A server's chat lines (`chat`, `join`, `leave`, `death`, `say`) and console entries are also stored in `Db`,
 * and seed its buffer when the hub starts (only for servers still in the config), so they survive a restart with their
 * ids and `at`; nothing else does. Ids start at the clock or above the highest stored one, whichever is later, so a
 * client's id from before a restart stays older than new ones.
 */
export class LiveFeed extends EventEmitter<{ event: [number, FeedEvent] }> {
  #next: number;
  #buffers = new Map<string, [number, FeedEvent][]>();
  #latest = new Map<string, [number, FeedEvent]>();

  constructor(hub: ServerHub, db: Db, perTarget = FEED_KEPT) {
    super();
    this.#next = Math.max(Date.now(), db.feedMaxId() + 1);
    for (const { id } of hub.list()) {
      const stored = db.feed(id, perTarget);
      if (stored.length) this.#buffers.set(`server:${id}`, stored);
    }
    const buffer = (key: string, entry: [number, FeedEvent]) => {
      const buf = this.#buffers.get(key) ?? [];
      this.#buffers.set(key, buf);
      if (buf.push(entry) > perTarget) buf.shift();
    };
    const stamp = (e: LiveEvent): [number, FeedEvent] => [this.#next++, { ...e, at: Date.now() }];
    hub.on('event', (e) => {
      const entry = stamp(e);
      if (e.type === 'tps') this.#latest.set(`server:${e.serverId}`, entry);
      else if (e.type === 'notice' && e.kind === 'packUpdateStep') this.#latest.set(`pack:${e.serverId}`, entry);
      else {
        if (e.type === 'notice' && e.kind === 'packUpdateFinished') this.#latest.delete(`pack:${e.serverId}`);
        if (e.type === 'stopped' || e.type === 'crashed') this.#latest.delete(`server:${e.serverId}`);
        buffer(`server:${e.serverId}`, entry);
        if (STORED.has(e.type)) db.recordFeed(entry[0], { ...e, at: entry[1].at });
      }
      this.emit('event', ...entry);
    });
    hub.on('target', (e) => {
      const entry = stamp(e);
      if (e.type === 'sample' || e.type === 'checked') this.#latest.set(`${e.target}:${e.id}`, entry);
      else if (e.type === 'libraryAdd' && e.phase === 'progress') this.#latest.set(`add:${e.target}:${e.id}`, entry);
      else {
        if (e.type === 'libraryAdd') this.#latest.delete(`add:${e.target}:${e.id}`);
        buffer(`${e.target}:${e.id}`, entry);
      }
      this.emit('event', ...entry);
    });
  }

  /** The newest event's id (one below the first if there is none yet). */
  get lastId(): number {
    return this.#next - 1;
  }

  /** Buffered events with an id after `lastId`, oldest first. */
  since(lastId = 0): [number, FeedEvent][] {
    return [...this.#buffers.values(), [...this.#latest.values()]]
      .flat()
      .filter(([id]) => id > lastId)
      .sort(([a], [b]) => a - b);
  }
}

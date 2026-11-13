// `LiveFeed`: numbers every hub event (ids start at the clock or above the highest stored one, so they keep rising
// across hub restarts), stamps it with `at` (when it arrived; kept in the replay), re-emits it, and keeps the last
// 500 per server (and per host, service and check) in memory for replay (`since(lastId)`; `lastId` is the newest id);
// a server's chat lines (`chat`, `join`, `leave`, `death`, `milestone`, `say`) and console entries are also written
// to `Db`'s `feed` table and seed its buffer at start (servers still in the config only), so Chat and Console survive
// a restart; nothing else does; `tps` and `paused` events, host `sample`s, check results (`checked`),
// `packUpdateStep` notices, a server's `settings` notices and a library add's progress stay out of that buffer, only
// the latest of each is kept (a server's TPS and `paused` dropped when it goes down or is `lost`, its step when its
// update finishes, an add's progress when it finishes; an Agent's heartbeats come at up to 1 a second, so toggling
// `paused` can't push chat out); no limit on its listeners (`setMaxListeners(0)`): `web.ts` adds one per open
// `/api/events` stream, the dashboard opening one per section, each removed when it closes, so over 10 is normal use,
// not a leak. Hub core.

import { EventEmitter } from 'node:events';
import type { Db } from './db.ts';
import { FEED_KEPT } from './feed-store.ts';
import type { FeedEvent, LiveEvent, ServerHub } from '../servers/servers.ts';

/** A server's events kept in `Db` too, so its Chat and Console panes survive a hub restart. */
const STORED = new Set<string>(['chat', 'join', 'leave', 'death', 'milestone', 'say', 'console']);

/**
 * Numbers every hub event, stamps it with the time it arrived (`at`), and keeps the last `perTarget` of each server's (and each host's, service's and check's)
 * in memory, so a live stream can replay them and resume after a given id. TPS and `paused` events, host samples and check
 * results stay out of that buffer (they would push chat and notices out, at an Agent's heartbeat budget of 1 a second too):
 * only the latest of each is kept, a server's TPS and `paused` until it goes down (or its Agent leaves), a server's latest
 * `packUpdateStep` until its update finishes, a server's latest game `settings` notice, and a library add's latest progress until it finishes. A server's chat lines (`chat`, `join`, `leave`, `death`, `milestone`, `say`) and console entries are also stored in `Db`,
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
    // One listener per open dashboard stream (GET /api/events: the dashboard opens one per section that follows it), each
    // removed when its stream closes: many at once are normal use, not a leak, so Node's warning at 11 is off.
    this.setMaxListeners(0);
    this.#next = Math.max(Date.now(), db.feed.maxId() + 1);
    for (const { id } of hub.list()) {
      const stored = db.feed.newest(id, perTarget);
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
      else if (e.type === 'paused') this.#latest.set(`paused:${e.serverId}`, entry);
      else if (e.type === 'notice' && e.kind === 'packUpdateStep') this.#latest.set(`pack:${e.serverId}`, entry);
      else if (e.type === 'notice' && e.kind === 'settings') this.#latest.set(`settings:${e.serverId}`, entry);
      else if (e.type === 'notice' && e.kind === 'saveUpload') this.#latest.set(`upload:${e.serverId}`, entry);
      else {
        if (e.type === 'notice' && e.kind === 'packUpdateFinished') this.#latest.delete(`pack:${e.serverId}`);
        if (e.type === 'stopped' || e.type === 'crashed' || e.type === 'lost') {
          this.#latest.delete(`server:${e.serverId}`);
          this.#latest.delete(`paused:${e.serverId}`);
        }
        buffer(`server:${e.serverId}`, entry);
        if (STORED.has(e.type)) db.feed.record(entry[0], { ...e, at: entry[1].at });
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

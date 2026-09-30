import { EventEmitter } from 'node:events';
import type { FeedEvent, LiveEvent, ServerHub } from './servers.ts';

/**
 * Numbers every hub event, stamps it with the time it arrived (`at`), and keeps the last `perTarget` of each server's (and each host's, service's and check's)
 * in memory, so a live stream can replay them and resume after a given id. TPS events, host samples and check results stay
 * out of that buffer (they would push chat and notices out): only the latest of each is kept, a server's TPS until it goes
 * down. Ids start at the clock, so a client's id from before a hub restart stays older than new ones. Nothing
 * survives a restart.
 */
export class LiveFeed extends EventEmitter<{ event: [number, FeedEvent] }> {
  #next = Date.now();
  #buffers = new Map<string, [number, FeedEvent][]>();
  #latest = new Map<string, [number, FeedEvent]>();

  constructor(hub: ServerHub, perTarget = 500) {
    super();
    const buffer = (key: string, entry: [number, FeedEvent]) => {
      const buf = this.#buffers.get(key) ?? [];
      this.#buffers.set(key, buf);
      if (buf.push(entry) > perTarget) buf.shift();
    };
    const stamp = (e: LiveEvent): [number, FeedEvent] => [this.#next++, { ...e, at: Date.now() }];
    hub.on('event', (e) => {
      const entry = stamp(e);
      if (e.type === 'tps') this.#latest.set(`server:${e.serverId}`, entry);
      else {
        if (e.type === 'stopped' || e.type === 'crashed') this.#latest.delete(`server:${e.serverId}`);
        buffer(`server:${e.serverId}`, entry);
      }
      this.emit('event', ...entry);
    });
    hub.on('target', (e) => {
      const entry = stamp(e);
      if (e.type === 'sample' || e.type === 'checked') this.#latest.set(`${e.target}:${e.id}`, entry);
      else buffer(`${e.target}:${e.id}`, entry);
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

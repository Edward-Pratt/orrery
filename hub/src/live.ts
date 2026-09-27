import { EventEmitter } from 'node:events';
import type { LiveEvent, ServerHub } from './servers.ts';

/**
 * Numbers every hub event and keeps the last `perTarget` of each server's (and each host's, service's and check's)
 * in memory, so a live stream can replay them and resume after a given id. TPS events stay out of that buffer
 * (heartbeats would push chat out): only each server's latest is kept, until it goes down. Ids start at the clock,
 * so a client's id from before a hub restart stays older than new ones. Nothing survives a restart.
 */
export class LiveFeed extends EventEmitter<{ event: [number, LiveEvent] }> {
  #next = Date.now();
  #buffers = new Map<string, [number, LiveEvent][]>();
  #tps = new Map<string, [number, LiveEvent]>();

  constructor(hub: ServerHub, perTarget = 500) {
    super();
    const buffer = (key: string, entry: [number, LiveEvent]) => {
      const buf = this.#buffers.get(key) ?? [];
      this.#buffers.set(key, buf);
      if (buf.push(entry) > perTarget) buf.shift();
    };
    hub.on('event', (e) => {
      const entry: [number, LiveEvent] = [this.#next++, e];
      if (e.type === 'tps') this.#tps.set(e.serverId, entry);
      else {
        if (e.type === 'stopped' || e.type === 'crashed') this.#tps.delete(e.serverId);
        buffer(`server:${e.serverId}`, entry);
      }
      this.emit('event', ...entry);
    });
    hub.on('target', (e) => {
      const entry: [number, LiveEvent] = [this.#next++, e];
      buffer(`${e.target}:${e.id}`, entry);
      this.emit('event', ...entry);
    });
  }

  /** Buffered events with an id after `lastId`, oldest first. */
  since(lastId = 0): [number, LiveEvent][] {
    return [...this.#buffers.values(), [...this.#tps.values()]]
      .flat()
      .filter(([id]) => id > lastId)
      .sort(([a], [b]) => a - b);
  }
}

import { EventEmitter } from 'node:events';
import type { HubEvent, ServerHub } from './servers.ts';

/**
 * Numbers every hub event and keeps the last `perServer` of each server's in memory, so a live stream can replay
 * them and resume after a given id. TPS events stay out of that buffer (heartbeats would push chat out): only each
 * server's latest is kept, until it goes down. Ids start at the clock, so a client's id from before a hub restart
 * stays older than new ones. Nothing survives a restart.
 */
export class LiveFeed extends EventEmitter<{ event: [number, HubEvent] }> {
  #next = Date.now();
  #buffers = new Map<string, [number, HubEvent][]>();
  #tps = new Map<string, [number, HubEvent]>();

  constructor(hub: ServerHub, perServer = 500) {
    super();
    hub.on('event', (e) => {
      const entry: [number, HubEvent] = [this.#next++, e];
      if (e.type === 'tps') this.#tps.set(e.serverId, entry);
      else {
        if (e.type === 'stopped' || e.type === 'crashed') this.#tps.delete(e.serverId);
        const buf = this.#buffers.get(e.serverId) ?? [];
        this.#buffers.set(e.serverId, buf);
        if (buf.push(entry) > perServer) buf.shift();
      }
      this.emit('event', ...entry);
    });
  }

  /** Buffered events with an id after `lastId`, oldest first. */
  since(lastId = 0): [number, HubEvent][] {
    return [...this.#buffers.values(), [...this.#tps.values()]]
      .flat()
      .filter(([id]) => id > lastId)
      .sort(([a], [b]) => a - b);
  }
}

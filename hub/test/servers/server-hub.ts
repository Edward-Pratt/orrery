// The `ServerHub` tests' hubs, shared by `test/servers/`'s tests of `servers.ts` and its parts: `setup` opens a
// minecraft server's hub on a random Mod port and records its events; `factorio` a factorio server's, its lifecycle rows
// in a database, the clock and timers mocked, and its game connections attached sockets.

import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import type { TestContext } from 'node:test';
import { Db } from '../../src/stats/db.ts';
import { ServerHub, type HubEvent, type HubOptions } from '../../src/servers/servers.ts';
import { TOKEN } from '../fake-mod.ts';

export async function setup(t: TestContext, opts: HubOptions = {}) {
  const hub = new ServerHub([{ id: 'gtnh', name: 'GTNH', game: 'minecraft', token: TOKEN }], opts);
  const port = await hub.listen(0);
  hub.start();
  const events: HubEvent[] = [];
  hub.on('event', (e) => events.push(e));
  t.after(() => hub.close());
  return { hub, port, events, types: () => events.map((e) => e.type) };
}

/**
 * A factorio server's hub, with its lifecycle rows in a database as `startHub` records them, the clock and timers
 * mocked; its game connections are attached sockets standing in for the ones `Agents` hands over.
 */
export function factorio(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const errors = t.mock.method(console, 'error', () => {});
  const hub = new ServerHub([{ id: 'space', name: 'Space Age', game: 'factorio' }]);
  const db = new Db(':memory:');
  const events: HubEvent[] = [];
  hub.on('event', (e) => {
    events.push(e);
    db.recordLifecycle(e.serverId, e.type);
  });
  const from = Date.now();
  t.after(() => hub.close());
  const attach = () => {
    const socket = new PassThrough();
    return { socket, send: hub.attach(socket as unknown as Socket, 'space', '1.0.0') };
  };
  const closed = () => new Promise((r) => setImmediate(r)); // a destroyed stream's 'close' comes on a later tick
  return { hub, db, events, errors, from, attach, closed, rows: () => db.states('space', from - 1) };
}

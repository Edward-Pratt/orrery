// The link flow: a `link`/`unlink` for a name not in `StatusPoller.players` (up to 5 s old: the player may have just
// joined) waits for a fresh `/orrery-status` on the command connection (never a UDP `join`), and is dropped, each one
// logged (its name `printable`), unless that has them online. `GameEvents` runs it through `LinkCtx`, which reads its
// state live, after the event budget took it.
import type { GameEvent } from './events-datagram.ts';
import type { Gate } from './events-gate.ts';
import { parseStatus } from './status.ts';
import { printable } from './wire.ts';

/** What the link flow takes from `GameEvents`: its RCON, its count of starts and stops, its gate, and its `event` emit. */
export type LinkCtx = {
  /** Runs an RCON command (the options' `run`). */
  run: (command: string) => Promise<string>;
  /** The count of starts and stops now, so a fresh status from an earlier run is ignored. */
  starts: () => number;
  gate: () => Gate;
  emit: (event: GameEvent) => void;
};

/**
 * A link or unlink for a name not online at the latest poll, which is up to 5 s old: a player who just joined. A
 * fresh `/orrery-status` decides (never the UDP `join`, which anyone in the container can send); not online there
 * either, it is dropped and logged.
 */
export async function confirmOnline(ctx: LinkCtx, event: Extract<GameEvent, { type: 'link' | 'unlink' }>): Promise<void> {
  const run = ctx.starts();
  let online = false;
  let why = 'not online at a fresh /orrery-status';
  try {
    const status = parseStatus(await ctx.run('/orrery-status'));
    if (status) online = status.players.includes(event.player);
    else why = '/orrery-status gave no status';
  } catch (err) {
    why = `/orrery-status failed: ${printable((err as Error).message)}`;
  }
  if (run !== ctx.starts() || ctx.gate() !== 'on') return; // the server stopped meanwhile
  if (online) return void ctx.emit(event);
  console.log(`[events] dropped ${event.type === 'link' ? 'a link' : 'an unlink'} for ${printable(event.player)}: ${why}`);
}

// The game connection, for `HubClient` (what it keeps: `HubState`). It opens only while the Agent connection is up,
// RCON answers (`status`) and the unit, if its state is known, is active (`openGame`): `hello` with the agent's token
// and the orrery mod's version, `started` once per run of the unit (its change time, kept in `<state>/started.json`,
// so a restarted agent doesn't announce a run again; `announce`), then (from `HubClient`) a `heartbeat { tps: UPS,
// players, paused }` per answer once there is a rate, each game event given to `event` and each `backup` (dropped
// while the game connection isn't up, as a Mod drops them while disconnected); the hub's `say`, `notice` and
// `linkResult` on it go to `toGame`, a `cmd` to `command` (answered by `cmdResult`, also with a `refused` line for one
// that isn't valid, so the hub never waits; a failure is "the command did not run", but one sent and not answered in
// time, `RconNoAnswer`, "may still run"), `save` to `save`. The stopping rule (`closeGame`): for a stop the agent
// started (`stopping`, from `serviceAct` stop or restart) it sends `stopping` and closes at once; any other end of a
// run is `RunWatch`'s, at the unit's final state (`endRun`): `stopping` then the close for `stopped`, the close alone
// for `crashed`. A stall (`stalled`), or RCON gone (`down`) while the unit is still active, only stops the heartbeats,
// so the hub's hung detection reports a frozen server as hung; with no unit state known, `down` closes it. After a run
// ended no game connection opens until the unit's next run (active with another change time). It also closes with the
// Agent connection; `gameUp` says whether it is welcomed (a game update's gate). A game `hello` the hub refuses
// (`reconnecting too fast` among them) closes only that connection: the next RCON answer (`status`) opens another, as
// many times as it takes, so an update's gate, which polls `gameUp` for its 5 minutes, never gives up after one.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './hub-files.ts';
import { Link } from './hub-link.ts';
import { connected, type HubState } from './hub-state.ts';
import { RconNoAnswer } from './rcon.ts';
import type { RunEnd } from './service.ts';
import { PROTOCOL_VERSION, readGameLine, type OutMsg } from './wire.ts';

/** A run ended that the agent didn't end itself: the hub hears it as a clean stop or a crash. */
export function endRun(s: HubState, end: RunEnd): void {
  s.ended = end.since;
  console.log(`[service] the server's run ${end.how === 'stopped' ? 'ended: stopped' : 'ended in a crash'}`);
  closeGame(s, end.how === 'stopped' ? 'the server stopped' : 'the server crashed', end.how === 'stopped');
}

/** Closes the game connection, if open, at once: after `stopping` (once that is written) when `stopped`. */
export function closeGame(s: HubState, why: string, stopped: boolean): void {
  const game = s.game;
  if (!game) return;
  s.game = null;
  if (!game.welcomed) return game.drop(why);
  if (stopped) game.send({ type: 'stopping' }, () => game.end(why));
  else game.end(why);
  gameClosedLog(s, why);
}

/** `started`, once per run of the unit (by its change time), on the game connection once it is up and the unit active. */
export function announce(st: HubState): void {
  const s = st.service;
  const game = st.game;
  if (!game?.welcomed || st.ended !== null || s?.active !== 'active' || s.since === st.started) return;
  st.started = s.since;
  game.send({ type: 'started' });
  const file = join(st.config.state, 'started.json');
  void mkdir(st.config.state, { recursive: true })
    .then(() => writeAtomic(file, JSON.stringify({ since: s.since }) + '\n'))
    .catch((err: Error) => console.error(`[hub] can't write ${file}: ${err.message}`));
}

/** Only for a run the hub may hear the end of: none while the unit, if its state is known, is not active. */
export function openGame(s: HubState, modVersion: string): void {
  if (s.game || !connected(s) || s.stopping || s.ended !== null) return;
  if (s.service && s.service.active !== 'active') return;
  const { host, port } = s.config.hub;
  const hello: OutMsg = { type: 'hello', protocol: PROTOCOL_VERSION, serverId: s.config.server.id, token: s.config.token, modVersion };
  const link: Link = new Link(host, port, hello, (line) => gameLine(s, link, line), (why) => gameClosed(s, link, why), s.handshakeMs);
  s.game = link;
}

function gameLine(s: HubState, link: Link, line: string): void {
  const r = readGameLine(line);
  if (!link.welcomed) {
    if (r.msg?.type !== 'welcome') {
      return link.drop(r.msg?.type === 'reject' ? `rejected: ${r.msg.reason}` : 'the hub answered the hello with something else');
    }
    link.welcome();
    if (s.gameLogged !== 'up') console.log(`[game] connected for server ${s.config.server.id}`);
    s.gameLogged = 'up';
    return announce(s);
  }
  if (r.msg === null) {
    // A cmd the agent won't run still gets its result, so the hub isn't left waiting for one.
    if (r.id !== null && r.why === 'invalid cmd') link.send({ type: 'cmdResult', id: r.id, output: ['refused: not a command the agent runs (one line, 1 to 256 characters)'] });
    return console.log(`[game] ignored a line from the hub: ${r.why}`);
  }
  switch (r.msg.type) {
    case 'welcome':
    case 'reject':
      return;
    case 'cmd':
      return void cmd(s, link, r.msg.id, r.msg.command);
    case 'save':
      return s.save();
    default:
      return s.toGame(r.msg);
  }
}

/** A console command's `cmdResult`: its output, or why there is none; one sent but not answered in time may still run. */
async function cmd(s: HubState, link: Link, id: string, command: string): Promise<void> {
  const output = await s.command(command).catch((err: Error) => [
    err instanceof RconNoAnswer
      ? `no answer in time (Factorio may be saving): the command may still run (${err.message})`
      : `the command did not run: ${err.message}`,
  ]);
  if (s.game === link) link.send({ type: 'cmdResult', id, output });
}

function gameClosed(s: HubState, link: Link, why: string): void {
  if (s.game !== link) return;
  s.game = null;
  gameClosedLog(s, why);
}

function gameClosedLog(s: HubState, why: string): void {
  if (why !== s.gameLogged) console.log(`[game] closed: ${why}`);
  s.gameLogged = why;
}

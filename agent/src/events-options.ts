// What `GameEvents` takes and tells: its options (`EventsOptions`: the agent's UDP port, Factorio's, the log, the
// players at the latest `/orrery-status`, RCON, and the waits) and whether game events reach the hub (`EventsState`,
// for the Agent connection's `events`).

/** Whether game events reach the hub, as the Agent connection's `events` tells it: off says why. */
export type EventsState = { on: true } | { on: false; reason: string };

export type EventsOptions = {
  /** The agent's UDP port on 127.0.0.1 (`agentUdpPort`, 34199; the mod sends there). */
  port: number;
  /** Factorio's Lua UDP port (`factorioUdpPort`, 34198): the only source port taken. */
  factorioPort: number;
  /** `factorio-current.log` in the server's data folder. */
  log: string;
  /** The players online at the latest `/orrery-status`: a link or unlink names one of them, or a fresh one decides. */
  players: () => readonly string[];
  /** Runs an RCON command (`/orrery-hello`, a fresh `/orrery-status`); rejects when RCON can't run it. */
  run: (command: string) => Promise<string>;
  /** How long after a start the log may take to show either line. */
  deadlineMs?: number;
  pollMs?: number;
  /** How long after `/orrery-hello`'s answer its datagram may take before that is logged. */
  helloMs?: number;
  /** Between attempts to listen when the port is taken. */
  retryMs?: number;
  /** The event budget's monotonic clock (ms; `performance.now`). */
  now?: () => number;
};

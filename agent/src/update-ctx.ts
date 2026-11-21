// What the game update flows outside the class share with `Updates` (`UpdatesCtx`): its options with their defaults
// filled in, the class's own state read live (the running update, which a throttle timer checks when it fires; the
// latest `/orrery-status` since the gate's start, which the swap and the rollback clear), and its `finish`, which ends
// the running update (`update-run.ts` ends one through it). `UpdatesOptions`: the roots, the unit, the saves, the
// Agent connection, `Http`, the decompressor, the arch and every wait, all injectable; the waits' defaults (`GATE_MS`,
// `STOP_WAIT_MS`, `STEP_MS`, `BEAT_MS`, `STALL_MS`).
import type { AgentMsg, PackFinished, ServiceVerb } from '../../hub/src/types.ts';
import type { Saves } from './saves.ts';
import type { UnitState } from './service.ts';
import type { Status } from './status.ts';
import type { InstalledMsg } from './update-checks.ts';
import type { Http } from './update-download.ts';
import type { Running } from './update-job.ts';

/** The health gate's limit, and the wait for a stop to finish (factorio.service stops within 200 s). */
export const GATE_MS = 5 * 60 * 1000;
export const STOP_WAIT_MS = 5 * 60 * 1000;
/** An `updateStep` per step at most this often, unless its state changes. */
export const STEP_MS = 1000;
/**
 * A running step goes out again after this long without one (a long unpack, save, gate or rollback), so the hub, which
 * gives an update up after 15 minutes without a word, hears it is alive.
 */
export const BEAT_MS = 60_000;
/** A download that gets no byte for this long (its answer, or its body) is stopped: prepare fails. */
export const STALL_MS = 60_000;

/** The server's unit as an update needs it: a fresh state, and the agent's own start and stop. */
export type UnitControl = { read(): Promise<UnitState>; act(verb: ServiceVerb): Promise<void> };

export type UpdatesOptions = {
  /** The game's releases and `current` (`/opt/factorio`; the container mounts it read-only). */
  install: string;
  /** The server's data folder (`/srv/factorio`; the container writes it all). */
  data: string;
  /** The agent's bookkeeping folder (`/srv/orrery-agent/state`), for `update.json`. */
  state: string;
  /** `/etc/orrery-agent/image.json`, setup's record of the container image and its glibc. */
  image: string;
  unit: UnitControl;
  saves: Pick<Saves, 'preUpdate' | 'keep' | 'list' | 'hold' | 'release' | 'restore'>;
  /** Sends on the Agent connection; false while it isn't up. */
  send: (msg: AgentMsg) => boolean;
  /** `updateDone` on the Agent connection (`HubClient.deliver`): true once its write succeeded. */
  deliver: (msg: AgentMsg) => Promise<boolean>;
  /** Whether the game connection is up (the gate's last condition). */
  gameUp: () => boolean;
  /** Whether the Agent connection is up: a rollback's gate asks for the game connection only then. */
  connected: () => boolean;
  /** The latest `installed` (`HubClient`'s, kept across restarts): an update's `from` and `to` are named from it. */
  installed: () => InstalledMsg | null;
  /**
   * Rejects while one of the agent's own deploys runs (`Deploys.idle`): its restart of the agent would cut the update
   * short, so an `update` is refused then, with that error.
   */
  idle: () => Promise<void>;
  http?: Http;
  /** A tarball's bytes, decompressed (`xz -dc`). */
  decompress?: (file: string) => AsyncIterable<Buffer>;
  /** This machine's architecture, as `process.arch`. */
  arch?: string;
  gateMs?: number;
  stopWaitMs?: number;
  /** Between looks at the gate and at a stopping unit. */
  pollMs?: number;
  stepMs?: number;
  beatMs?: number;
  stallMs?: number;
  /** A clock that only goes forward (ms), for the step throttle. */
  clock?: () => number;
};

/** What the game update flows need of `Updates`: see the header. */
export type UpdatesCtx = {
  o: Required<UpdatesOptions>;
  // The class's own, read and cleared live: see `Updates`.
  running: () => Running | null;
  latest: () => Status | null;
  clearLatest: () => void;
  finish: (r: Running, outcome: PackFinished) => Promise<void>;
};

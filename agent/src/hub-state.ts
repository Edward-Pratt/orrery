// `HubState`, everything one `HubClient` keeps, in one object it shares by reference with the modules that run its
// two connections (`hub-agent.ts`, `hub-game.ts`): its options with their defaults, both `Link`s and their timers,
// what is pushed on each connect, the runs of the unit and what was last logged. `hubState` builds it from the
// options, reading back `<state>/started.json` and `<state>/installed.json` (`hub-files.ts`). `connected` says whether
// the Agent connection is up: welcomed and not closed.

import { join } from 'node:path';
import type { GameSettingsReport } from '../../hub/src/types.ts';
import type { EventsState } from './events.ts';
import type { Handlers, HubOptions } from './hub.ts';
import { HUB_WELCOME_GAP_MS } from './hub-retry.ts';
import { INSTALLED, readInstalled, readStarted } from './hub-files.ts';
import type { Link } from './hub-link.ts';
import type { SavesMsg } from './saves.ts';
import { RunWatch, type UnitState } from './service.ts';
import type { Reading } from './status.ts';
import type { InstalledMsg } from './update.ts';
import type { ToGame } from './wire.ts';

export type HubState = {
  config: HubOptions['config'];
  version: string;
  handlers: Handlers;
  toGame: (msg: ToGame) => void;
  command: (command: string) => Promise<string[]>;
  save: () => void;
  onWelcome: () => void;
  pingMs: number;
  handshakeMs: number;
  backoffMs: number;
  maxBackoffMs: number;
  random: () => number;
  welcomeGapMs: number;
  /** When the Agent connection was last welcomed (`performance.now()`), null before the first. */
  welcomedAt: number | null;
  agent: Link | null;
  game: Link | null;
  failures: number;
  retry: NodeJS.Timeout | undefined;
  ping: NodeJS.Timeout | undefined;
  /** The latest RCON answer, null while RCON doesn't answer. */
  reading: Reading | null;
  service: UnitState | null;
  saves: SavesMsg | null;
  /** What the server runs, as `/orrery-status` last said, kept in `<state>/installed.json` across restarts. */
  installed: InstalledMsg | null;
  installedKey: string;
  /** Writes of `installed.json`, one after another (they share a temp file). */
  saving: Promise<void>;
  /** Whether game events reach the hub: `GameEvents`' latest `state`. */
  events: EventsState | null;
  /** The game settings' latest report (`GameSettings`), and the last one sent on the Agent connection now up. */
  settings: GameSettingsReport | null;
  settingsSent: string;
  runs: RunWatch;
  /** The change time of the run whose end the hub was told (or is being told): no game connection until the next run. */
  ended: number | null;
  /** The change time of the last run announced with `started`, kept in `<state>/started.json` across restarts. */
  started: number | null;
  stopping: boolean;
  logged: string;
  gameLogged: string;
};

export function hubState(o: HubOptions): HubState {
  const started = readStarted(join(o.config.state, 'started.json'));
  const installed = readInstalled(join(o.config.state, INSTALLED));
  return {
    config: o.config,
    version: o.version,
    handlers: o.handlers ?? {},
    toGame: o.toGame ?? (() => {}),
    command: o.command ?? (() => Promise.reject(new Error('console commands are not supported'))),
    save: o.save ?? (() => console.error('[game] save is not supported')),
    onWelcome: o.welcomed ?? (() => {}),
    pingMs: o.pingMs ?? 10_000,
    handshakeMs: o.handshakeMs ?? 10_000,
    backoffMs: o.backoffMs ?? 1000,
    maxBackoffMs: o.maxBackoffMs ?? 60_000,
    random: o.random ?? Math.random,
    welcomeGapMs: o.welcomeGapMs ?? HUB_WELCOME_GAP_MS,
    welcomedAt: null,
    agent: null,
    game: null,
    failures: 0,
    retry: undefined,
    ping: undefined,
    reading: null,
    service: null,
    saves: null,
    installed,
    installedKey: installed ? JSON.stringify(installed) : '',
    saving: Promise.resolve(),
    events: null,
    settings: null,
    settingsSent: '',
    runs: new RunWatch(),
    ended: null,
    started,
    stopping: false,
    logged: '',
    gameLogged: '',
  };
}

/** Whether the Agent connection is up: welcomed and not closed. */
export function connected(s: HubState): boolean {
  return s.agent?.welcomed === true;
}

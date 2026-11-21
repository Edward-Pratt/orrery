// The game settings tests' shared setup (`settings.test.ts`, `settings-rules.test.ts`, `settings-files.test.ts`,
// `settings-live.test.ts`): a temp config folder with setup's files (`host`), a `GameSettings` on it (`agent`) with a
// unit and a clock the test sets and RCON answering like Factorio 2.1.24 (`fake-rcon.ts`'s `factorioConfig`: each
// `/config set` option's change line, `/promote` and `/demote` rewriting the adminlist), a `settingsSet` as the
// agent's wire check passes it on (`request`), and the report taken by the hub's `parseAgentLine` (`hubTakes`).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { parseAgentLine } from '../../hub/src/protocol.ts';
import type { GameSettingsFields, GameSettingsReport } from '../../hub/src/types.ts';
import type { UnitState } from '../src/service.ts';
import { ADMINS_FILE, GameSettings, SETTINGS_FILE } from '../src/settings.ts';
import { readAgentLine, type Request } from '../src/wire.ts';
import { factorioConfig } from './fake-rcon.ts';

/** Seconds, as systemd's change times are. */
export const T0 = Math.floor(Date.now() / 1000) * 1000 - 60_000;
export const unitState = (active: string, sub: string, since: number, result = 'success'): UnitState => ({ unit: 'factorio.service', active, sub, since, result });
export const ACTIVE = unitState('active', 'running', T0);
export const STOPPED = unitState('inactive', 'dead', T0);

/** server-settings.json as deploy/setup-agent-host.sh writes it. */
export const SETUP = {
  _comment: 'Written by orrery deploy/setup-agent-host.sh, and kept on a re-run once edited.',
  name: 'orrery Factorio',
  description: '',
  game_password: 'Abcdefghij0123456789',
  visibility: { public: false, lan: false },
  require_user_verification: true,
  auto_pause: true,
  autosave_interval: 10,
  autosave_slots: 5,
  non_blocking_saving: false,
  allow_commands: 'admins-only',
};
/** SETUP's values, with Factorio's own for the keys it leaves out. */
export const FIELDS: GameSettingsFields = {
  name: 'orrery Factorio',
  description: '',
  max_players: 0,
  require_user_verification: true,
  autosave_interval: 10,
  autosave_slots: 5,
  afk_autokick_interval: 0,
  auto_pause: true,
  auto_pause_when_players_connect: false,
  only_admins_can_pause_the_game: true,
  allow_commands: 'admins-only',
};

/** A `settingsSet` as the agent's wire check passes it on (so every value here is one the hub's rules let through). */
export function request(settings: Partial<GameSettingsFields> = {}, more: { game_password?: string | null; admins?: string[] } = {}): Request<'settingsSet'> {
  const r = readAgentLine(JSON.stringify({ type: 'settingsSet', id: 's1', settings: { ...FIELDS, ...settings }, admins: [], ...more }));
  assert.ok(r.msg?.type === 'settingsSet', JSON.stringify(r));
  return r.msg;
}

/** A Host's config folder (with setup's files, unless told otherwise), the agent's state folder and Factorio's log. */
export async function host(t: TestContext, o: { settings?: object | string | null; admins?: string[] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'config');
  await mkdir(config);
  const settings = o.settings === undefined ? SETUP : o.settings;
  if (settings !== null) await writeFile(join(config, SETTINGS_FILE), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  await writeFile(join(config, ADMINS_FILE), JSON.stringify(o.admins ?? ['alice']));
  return { dir, config, state: join(dir, 'state'), log: join(dir, 'factorio-current.log') };
}
export type Host = Awaited<ReturnType<typeof host>>;

/**
 * A `GameSettings` on `h`: the unit as `unit` says (changed with `setUnit`), RCON answering like Factorio 2.1.24
 * (`factorioConfig`, or `reply`), every command and push kept, a clock that moves only when told.
 */
export function agent(h: Host, options: { unit?: UnitState; reply?: (c: string) => string | Error | undefined; ready?: () => Promise<void> } = {}) {
  const o = options;
  let unit = o.unit ?? ACTIVE;
  let now = T0 + 30_000;
  const commands: string[] = [];
  const pushes: GameSettingsReport[] = [];
  const reply = o.reply ?? ((c: string) => factorioConfig(c, join(h.config, ADMINS_FILE)));
  const s = new GameSettings({
    config: h.config,
    state: h.state,
    log: h.log,
    unit: { read: async () => unit },
    run: async (c) => {
      commands.push(c);
      const r = reply(c);
      if (r instanceof Error) throw r;
      if (r === undefined) throw new Error('no such command');
      return r;
    },
    ready: o.ready ?? (async () => {}),
    push: (r) => pushes.push(r),
    now: () => now,
    adminWaitMs: 300,
    pollMs: 10,
  });
  return {
    s,
    commands,
    pushes,
    /** The unit's new state, as `ServiceWatch` would report it. */
    setUnit: (u: UnitState) => {
      unit = u;
      s.service(u);
    },
    at: (ms: number) => (now = T0 + ms),
  };
}

export const fileOf = (h: Host) => JSON.parse(readFileSync(join(h.config, SETTINGS_FILE), 'utf8')) as Record<string, unknown>;
export const stateOf = (h: Host) => {
  try {
    return JSON.parse(readFileSync(join(h.state, 'settings.json'), 'utf8')) as Record<string, any>;
  } catch {
    return null;
  }
};
export const hubTakes = (r: GameSettingsReport) => parseAgentLine(JSON.stringify({ type: 'settings', ...r })) !== null;

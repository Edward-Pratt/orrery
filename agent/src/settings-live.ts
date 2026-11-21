// The live part of a game settings write (`settings.ts`'s `GameSettings` runs it with the unit active): the only
// commands the Agent builds for it (agent/CLAUDE.md, "Trust boundaries"). `LIVE`, the fixed table of Factorio's
// `/config set <option> [value]` options, each value one the rules let through. `applyLive`: each changed key (and
// each one a write before couldn't apply) with a live option, the password first, applied only when the reply is
// Factorio's change line for that value (or the one saying the server already has it, `User verification is already
// enabled.` (or disabled) and `The server description is already empty.`, as seen on 2.1.24; the description sent
// trimmed, as Factorio takes it, and `/config set description` with no value clears it (seen on 2.1.24), so the
// description is live both ways), the first failure or 20 s spent leaving the rest pending; then `/promote` and
// `/demote` for the admins' difference (`diffAdmins`, ignoring case), applied once the adminlist read again (2 s at
// most) shows it. The reply is `{ applied, pending }` (pending: the failed ones and the restart-only keys, `auto_pause`
// and `autosave_slots`, that differ from what the run started with); the failed ones stay in the state's `failedLive`.
import { setTimeout as sleep } from 'node:timers/promises';
import { readAdminsFile, type State } from './settings-files.ts';
import { ordered, restartPending, type Key, type Model } from './settings-rules.ts';

export type SettingsAnswer = { applied: string[]; pending: string[] };

/** What `applyLive` takes of `GameSettings`' options. */
export type LiveOptions = {
  /** The server's config folder, for the adminlist read again. */
  config: string;
  /** Runs one RCON command (the agent's `RconSession`). */
  run: (command: string) => Promise<string>;
  liveMs: number;
  adminWaitMs: number;
  pollMs: number;
};

const minutes = (n: number) => `${n} minute${n === 1 ? '' : 's'}`;
const ALLOW_WORDS = { true: 'Yes', false: 'No', 'admins-only': 'Admins only' } as const;

/**
 * A key Factorio changes live, the command for its new value and the replies that say the running server has it (seen
 * on 2.1.24): its change line, and for verification and an empty description the line saying it already had it.
 */
type Live = { key: Exclude<Key, 'auto_pause' | 'autosave_slots'> | 'game_password'; command: (m: Model) => [command: string, replies: string[]] };
/** The description as Factorio takes it from `/config set`: trimmed (seen on 2.1.24: `  a b ` is set as `a b`, spaces alone clear it). */
const liveDescription = (m: Model) => m.fields.description.trim();

/**
 * The live options, in the order they are sent: the password before verification, so turning the account check off
 * with a new password never leaves a moment with neither. Each value is one the rules let through: one line, no
 * control character, within its limit. Only these built-in commands are built (agent/CLAUDE.md, "Trust boundaries").
 */
export const LIVE: readonly Live[] = [
  {
    key: 'game_password',
    command: (m) => (m.password === '' ? ['/config set password', ['Server password removed.']] : [`/config set password ${m.password}`, ['Server password changed.']]),
  },
  {
    key: 'require_user_verification',
    command: (m) => {
      const on = m.fields.require_user_verification;
      return [`/config set require-user-verification ${on}`, [`User verification has been ${on ? 'enabled' : 'disabled'}.`, `User verification is already ${on ? 'enabled' : 'disabled'}.`]];
    },
  },
  { key: 'name', command: (m) => [`/config set name ${m.fields.name}`, [`Server name changed to: ${m.fields.name}`]] },
  {
    key: 'description',
    command: (m) =>
      liveDescription(m) === ''
        ? ['/config set description', ['Server description cleared.', 'The server description is already empty.']]
        : [`/config set description ${liveDescription(m)}`, [`Server description set to: ${liveDescription(m)}`]],
  },
  {
    key: 'max_players',
    command: (m) => [`/config set max-players ${m.fields.max_players}`, [m.fields.max_players === 0 ? 'Player limit removed.' : `Maximum number of players changed to ${m.fields.max_players}.`]],
  },
  {
    key: 'autosave_interval',
    command: (m) => [
      `/config set autosave-interval ${m.fields.autosave_interval}`,
      [m.fields.autosave_interval === 0 ? 'Autosave is now disabled.' : `Autosave interval changed to ${minutes(m.fields.autosave_interval)}.`],
    ],
  },
  {
    key: 'afk_autokick_interval',
    command: (m) => [
      `/config set afk-auto-kick ${m.fields.afk_autokick_interval}`,
      [m.fields.afk_autokick_interval === 0 ? 'AFK auto kick is now disabled.' : `AFK auto-kick changed to ${minutes(m.fields.afk_autokick_interval)}.`],
    ],
  },
  {
    key: 'auto_pause_when_players_connect',
    command: (m) => [`/config set auto-pause-when-players-connect ${m.fields.auto_pause_when_players_connect}`, [`Auto pause when players connect set to: ${m.fields.auto_pause_when_players_connect}.`]],
  },
  {
    key: 'only_admins_can_pause_the_game',
    command: (m) => [`/config set only-admins-can-pause ${m.fields.only_admins_can_pause_the_game}`, [`Only admins can pause set to: ${m.fields.only_admins_can_pause_the_game}.`]],
  },
  {
    key: 'allow_commands',
    command: (m) => [`/config set allow-commands ${m.fields.allow_commands}`, [`Allow Lua commands set to ${ALLOW_WORDS[m.fields.allow_commands]}.`]],
  },
];

/** The live part of a write to a running server: commands one at a time, the first failure leaving the rest pending. */
export async function applyLive(o: LiveOptions, state: State, after: Model, changed: string[], adminsBefore: string[], admins: string[]): Promise<SettingsAnswer> {
  const want = new Set([...changed, ...state.failedLive]);
  const applied: string[] = [];
  const failed: string[] = [];
  const deadline = performance.now() + o.liveMs;
  let answering = true;
  for (const live of LIVE) {
    if (!want.has(live.key)) continue;
    if (answering && performance.now() < deadline) {
      const [command, replies] = live.command(after);
      try {
        if (replies.includes(await o.run(command))) {
          applied.push(live.key);
          continue;
        }
      } catch {
        answering = false; // RCON is gone or slow: the rest waits for the restart
      }
    }
    failed.push(live.key);
  }
  const diff = diffAdmins(adminsBefore, admins);
  if (diff.length > 0) {
    let sent = answering && performance.now() < deadline;
    for (const [verb, name] of diff) {
      if (!sent) break;
      sent = await o.run(`/${verb} ${name}`).then(
        () => true,
        () => false,
      );
    }
    if (sent && (await adminsShow(o, admins))) applied.push('admins');
    else failed.push('admins');
  }
  state.failedLive = failed;
  return { applied: ordered(applied), pending: ordered([...failed, ...restartPending(state.startedWith?.model, after, changed)]) };
}

/** Whether the adminlist, read again until `adminWaitMs`, holds exactly `admins` (ignoring case): Factorio rewrites it at once. */
async function adminsShow(o: LiveOptions, admins: string[]): Promise<boolean> {
  const until = performance.now() + o.adminWaitMs;
  for (;;) {
    if (diffAdmins((await readAdminsFile(o.config)) ?? [], admins).length === 0) return true;
    if (performance.now() >= until) return false;
    await sleep(o.pollMs);
  }
}

/** `/promote` and `/demote` that turn `from` into `to`, ignoring case (the names from the file passed the rule when read). */
export function diffAdmins(from: string[], to: string[]): ['promote' | 'demote', string][] {
  const has = new Set(from.map((n) => n.toLowerCase()));
  const wants = new Set(to.map((n) => n.toLowerCase()));
  return [...to.filter((n) => !has.has(n.toLowerCase())).map((n) => ['promote', n] as ['promote', string]), ...from.filter((n) => !wants.has(n.toLowerCase())).map((n) => ['demote', n] as ['demote', string])];
}

// The game settings tests' fixtures and hub, shared by `game-settings.test.ts` and `game-settings-rules.test.ts`: a
// factorio server's settings as its Agent reports them (`VALUES`, `REPORT`) and as a save sends them (`FIELDS`,
// `REQUEST`), a password to look for (`PASSWORD`), and `settingsHub`, a whole hub (`test/fake-agent.ts`) with the
// Agent connected and its report taken.

import type { TestContext } from 'node:test';
import type { AuditLog, GameSettingsRequest, GameSettingsState } from '../../src/api.ts';
import type { Post } from '../../src/discord/format.ts';
import type { GameSettingsReport } from '../../src/types.ts';
import { agentUp, eventually, gameHub } from '../fake-agent.ts';

export const PASSWORD = 'Sesame-0pen!Xyzzy-7731';
export const VALUES = {
  name: 'orrery Factorio',
  description: 'Our base',
  max_players: 0,
  game_password_set: true,
  require_user_verification: true,
  autosave_interval: 10,
  autosave_slots: 5,
  afk_autokick_interval: 0,
  auto_pause: true,
  auto_pause_when_players_connect: false,
  only_admins_can_pause_the_game: true,
  allow_commands: 'admins-only' as const,
};
export const REPORT: GameSettingsReport = { settings: VALUES, admins: ['alice'], problem: null, pending: [], extra: ['tags'], rolledBack: null };
const { game_password_set: _, ...FIELDS } = VALUES;
export { FIELDS };
export const REQUEST: GameSettingsRequest = { ...FIELDS, admins: ['alice'] };

/** A Discord post's embed title. */
export const titleOf = (p: Post | null) => (p && 'embeds' in p ? p.embeds[0]?.title : undefined);

/** What gets logged, for the password check. */
export function captureConsole(t: TestContext): string[] {
  const lines: string[] = [];
  for (const m of ['log', 'error', 'warn', 'info'] as const) t.mock.method(console, m, (...args: unknown[]) => lines.push(args.map(String).join(' ')));
  return lines;
}

/** A hub with the Agent (at `version`) connected, its report pushed (unless `report` is null) and taken. */
export async function settingsHub(t: TestContext, { version = 'agent-v1.2.0', unit = 'active', report = REPORT as GameSettingsReport | null } = {}) {
  const h = await gameHub(t);
  const a = await agentUp(h.agentPort, { version, unit });
  const settings = () => h.json<GameSettingsState>(h.req('GET', '/api/servers/space/settings'));
  const push = (r: GameSettingsReport) => a.agent.send({ type: 'settings', ...r });
  if (report) {
    push(report);
    await eventually(async () => (await settings()).settings !== null);
  } else await eventually(async () => (await settings()).blocked !== "The Agent isn't connected.");
  const put = (body: object) => h.req('PUT', '/api/servers/space/settings', body);
  /** The Agent's next request, answered with `data` (or refused with `error`). */
  const reply = async (data: object | { error: string }) => {
    const r = (await a.agent.next()) as { id: string; type: string } & Record<string, unknown>;
    a.agent.send({ type: 'reply', id: r.id, ...('error' in data ? { ok: false, error: data.error } : { ok: true, data }) });
    return r;
  };
  const audit = async () =>
    (await h.json<AuditLog>(h.req('GET', '/api/audit?server=space'))).entries.filter((e) => e.action.startsWith('game settings')).map((e) => [e.actor, e.action, e.details]);
  return { ...h, ...a, settings, push, put, reply, audit };
}

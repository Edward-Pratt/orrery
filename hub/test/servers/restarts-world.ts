// The restart tests' shared setup (`test/servers/restarts*.test.ts`): UK local time (`TZ`, set on import, so every
// file imports a value from here), the notices a countdown publishes (`scheduled`, `NOW`, `cancelled`, `DOWN`,
// `failed`), `flush`, and a `RestartScheduler` on a stub hub with mocked timers (`setup`, per test).

import { EventEmitter } from 'node:events';
import type { TestContext } from 'node:test';
import { RestartScheduler } from '../../src/servers/restarts.ts';
import type { HubEvent, Notice, ServerHub, ServerState } from '../../src/servers/servers.ts';

process.env.TZ = 'Europe/London'; // daily-restart assertions are in UK local time, across a DST change

export const MIN = 60_000;
export const flush = () => new Promise((r) => setImmediate(r)); // setImmediate isn't mocked: lets rejections settle
export const scheduled = (minutes: number, by: string): Notice => ({ severity: 'info', kind: 'restartScheduled', ms: minutes * MIN, by });
export const NOW: Notice = { severity: 'info', kind: 'restartNow' };
export const cancelled = (by: string): Notice => ({ severity: 'info', kind: 'restartCancelled', by });
export const DOWN: Notice = { severity: 'info', kind: 'restartCancelledDown' };
export const failed = (error: string): Notice => ({ severity: 'problem', kind: 'restartFailed', error });

export function setup(t: TestContext, now = Date.UTC(2026, 8, 24, 12, 0)) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const events = new EventEmitter<{ event: [HubEvent] }>();
  const commands: string[] = [];
  const audit: string[] = []; // "command|by"
  const log: string[] = []; // "actor|action|target|details", from hub.audit
  const notices: Notice[] = []; // published on the hub's event stream
  const state = { online: true, downs: 0, stopError: null as Error | null, paused: null as string | null, game: 'minecraft', restartError: null as Error | null };
  const restarted: string[] = []; // "serverId|by", the `restart` a factorio server's countdown ends in
  const runCommand = async (id: string, command: string, by: string) => {
    commands.push(command);
    audit.push(`${command}|${by}`);
    log.push(`${by}|command|${id}|${command}`); // ServerHub audits every command it sends
    if (command === 'stop' && state.stopError) throw state.stopError;
    return [];
  };
  const hub = {
    on: (name: 'event', fn: (e: HubEvent) => void) => events.on(name, fn),
    get: (id: string) => (state.online ? ({ id, online: true, game: state.game } as ServerState) : undefined),
    downs: () => state.downs,
    runCommand,
    // What ServerHub.broadcast does on a Mod's server.
    broadcast: async (id: string, text: string, by: string) => void (await runCommand(id, `say ${text}`, by)),
    audit: (actor: string, action: string, target: string, details = '') => void log.push(`${actor}|${action}|${target}|${details}`),
    publish: (serverId: string, notice: Notice) => {
      notices.push(notice);
      events.emit('event', { ...notice, type: 'notice', serverId });
    },
  } as unknown as Pick<ServerHub, 'runCommand' | 'broadcast' | 'on' | 'get' | 'downs' | 'publish' | 'audit'>;
  const restart = async (id: string, by: string) => {
    restarted.push(`${id}|${by}`);
    if (state.restartError) throw state.restartError;
  };
  const restarts = new RestartScheduler(hub, { paused: () => state.paused, restart });
  t.after(() => restarts.stop());
  return { restarts, events, commands, audit, log, notices, state, restarted };
}

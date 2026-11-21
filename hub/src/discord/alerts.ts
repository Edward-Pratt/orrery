// Where an event is posted (`channelFor`): its server's channel, or the alerts channel for the host's, services' and
// checks' notices and a factorio server's `verificationOff`, `verificationOn` and `settingsRolledBack` (`ADMINS_ONLY`:
// not in the players' channel, and not posted without an alerts channel); `postTargets` posts the target events there,
// an Agent's `agentLost` and `agentBack` each at most once per 10 minutes per Agent (`agentAlerts`, `AGENT_ALERT_MS`):
// one sooner is held and posted when its 10 minutes are up if it is still that Agent's latest, and one that would
// repeat what Discord last said is not posted, so a back after a held lost is held too; the stream and the dashboard
// keep every event.

import { formatTargetEvent } from './format-target.ts';
import type { Post } from './format-text.ts';
import type { DiscordConfig } from '../config.ts';
import type { LiveEvent, ServerHub, TargetEvent } from '../servers/servers.ts';

/**
 * A server's notices for the admins alone: user verification turned off or on, and game settings put back (a
 * rollback can bring back a leaked game password). The server's channel is where its players read: saying there that
 * names aren't checked would tell anyone with the game password they can join under an admin's name.
 */
const ADMINS_ONLY = new Set<string>(['verificationOff', 'verificationOn', 'settingsRolledBack']);

/**
 * Where an event is posted: its server's channel, or the alerts channel for the host, services and checks and for a
 * server's notices for the admins alone (`ADMINS_ONLY`); without an alerts channel those are not posted.
 */
export function channelFor(e: LiveEvent, cfg: DiscordConfig): string | undefined {
  if ('target' in e || (e.type === 'notice' && ADMINS_ONLY.has(e.kind))) return cfg.alertsChannel;
  return Object.hasOwn(cfg.channels, e.serverId) ? cfg.channels[e.serverId] : undefined;
}

/** How often an Agent's `agentLost`, and its `agentBack`, may each be posted to Discord: once per 10 minutes. */
export const AGENT_ALERT_MS = 10 * 60_000;

type AgentNotice = Extract<TargetEvent, { type: 'notice'; kind: 'agentLost' | 'agentBack' }>;

/**
 * An Agent's `agentLost` and `agentBack` on Discord (`seen` takes each; `post` puts one up): each kind at most once
 * per `AGENT_ALERT_MS` per Agent. One that comes sooner is held and posted when its 10 minutes are up, if it is still
 * the Agent's latest; one that would only repeat what Discord last said is not posted, so a back after a held lost is
 * held too. A flapping Agent can't flood the alerts channel, and Discord's last word is never wrong for longer than
 * 10 minutes; the stream and the dashboard keep every event. `stop` drops what is held.
 */
export function agentAlerts(post: (e: AgentNotice) => void): { seen: (e: AgentNotice) => void; stop: () => void } {
  type Agent = { shown: AgentNotice['kind'] | null; at: Record<AgentNotice['kind'], number>; latest: AgentNotice; timer?: NodeJS.Timeout };
  const agents = new Map<string, Agent>(); // by host id: configured Agents only
  const ago = (now: number, stamp: number) => (now < stamp ? Infinity : now - stamp); // a clock stepped back: long ago
  const show = (a: Agent) => {
    clearTimeout(a.timer);
    a.timer = undefined;
    const e = a.latest;
    if (e.kind === a.shown) return; // Discord says so already
    const now = Date.now();
    const wait = AGENT_ALERT_MS - ago(now, a.at[e.kind]);
    if (wait > 0) return void (a.timer = setTimeout(() => show(a), wait).unref());
    a.shown = e.kind;
    a.at[e.kind] = now;
    post(e);
  };
  return {
    seen: (e) => {
      let a = agents.get(e.id);
      if (!a) agents.set(e.id, (a = { shown: null, at: { agentLost: -Infinity, agentBack: -Infinity }, latest: e }));
      a.latest = e;
      show(a);
    },
    stop: () => {
      for (const a of agents.values()) clearTimeout(a.timer);
    },
  };
}

const isAgentNotice = (e: TargetEvent): e is AgentNotice => e.type === 'notice' && (e.kind === 'agentLost' || e.kind === 'agentBack');

/**
 * Posts each announced event about the host, a service or a check to the alerts channel (none: not posted), an
 * Agent's lost and back through `agentAlerts`. Server events never come this way: they go to their own server's
 * channel. Returns what stops it (held alerts dropped).
 */
export function postTargets(hub: ServerHub, cfg: DiscordConfig, post: (channelId: string, message: Post) => Promise<void>): () => void {
  const send = (e: TargetEvent) => {
    const channelId = channelFor(e, cfg);
    const message = formatTargetEvent(e);
    if (!channelId || !message) return;
    post(channelId, message).catch((err) => console.error(`[discord] alert for ${e.target} ${e.id} failed:`, err));
  };
  const agents = agentAlerts(send);
  const listener = (e: TargetEvent) => (isAgentNotice(e) ? agents.seen(e) : send(e));
  hub.on('target', listener);
  return () => {
    hub.off('target', listener);
    agents.stop();
  };
}

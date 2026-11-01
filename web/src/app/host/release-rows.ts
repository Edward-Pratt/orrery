import type { DeployPart, DeployRow, DeploysAnswer, Release } from '@hub/api';

/** One deployable thing on the Host page: the hub, the dashboard, one server's Mod, or one Host's Agent. */
export type ReleaseRow = {
  key: string;
  label: string;
  part: DeployPart;
  /** The Mod's server. */
  server?: string;
  /** The Agent's id (its Host's). */
  host?: string;
  running: string | null;
  latest: string | null;
  releases: Release[];
  /** The latest release is newer than the one running (only when that is a listed release: never for dev). */
  newer: boolean;
  /** Its deploy in progress, if any. */
  deploying: DeployRow | undefined;
  /**
   * Why it can't deploy now: an update runs (a pack update on its server, for a Mod; a game update on the server it
   * runs, for an Agent; either anywhere, for the hub).
   */
  why: string | null;
};

const DAY = 24 * 60 * 60_000;

/**
 * The rows of an answer. A hub below `hub-v2.14.0` (release 1 of the Factorio Agent) sends no `agent` part: its answer
 * has no Agent rows, so its Releases can still roll the hub forward or the dashboard back (the one guard for an older
 * hub, ADR 0001).
 */
export function releaseRows(a: DeploysAnswer): ReleaseRow[] {
  const agent: DeploysAnswer['agent'] = a.agent ?? { latest: null, releases: [], hosts: [] };
  /** A Mod's or an Agent's deploy has its server or Agent as its target. */
  const running = (part: DeployPart, target?: string) => a.history.find((h) => h.outcome === 'running' && h.part === part && (!target || h.target === target));
  const row = (key: string, label: string, part: DeployPart, run: string | null, latest: string | null, releases: Release[], why: string | null, more: { server?: string; host?: string } = {}): ReleaseRow => ({
    key,
    label,
    part,
    ...more,
    running: run,
    latest,
    releases,
    newer: releases.findIndex((r) => r.tag === run) > 0,
    deploying: running(part, more.server ?? more.host),
    why,
  });
  return [
    row('hub', 'Hub', 'hub', a.hub.running, a.hub.latest, a.hub.releases, a.packing.length ? 'A pack or game update is running.' : null),
    row('web', 'Dashboard', 'web', a.web.running, a.web.latest, a.web.releases, null),
    ...a.mod.servers.map((s) =>
      row(`mod:${s.id}`, `Mod on ${s.name}`, 'mod', s.running, a.mod.latest, a.mod.releases, a.packing.includes(s.id) ? `A pack update is running on ${s.name}.` : null, { server: s.id }),
    ),
    ...agent.hosts.map((h) =>
      row(`agent:${h.id}`, `Agent on ${h.name}`, 'agent', h.running, agent.latest, agent.releases, a.packing.includes(h.server) ? `A game update is running on ${h.server}.` : null, { host: h.id }),
    ),
  ];
}

/** The oldest release newer than the running one has waited longer than `newerAfterDays`: it needs attention. */
export function overdue(r: ReleaseRow, a: DeploysAnswer, now = Date.now()): boolean {
  const at = r.releases.findIndex((rel) => rel.tag === r.running);
  return at > 0 && r.releases[at - 1]!.publishedAt < now - a.newerAfterDays * DAY;
}

/** `hub-v2.6.0` → `v2.6.0`. */
export const short = (tag: string | null) => tag?.replace(/^(hub|web|mod|agent)-/, '') ?? 'unknown';

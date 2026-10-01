import type { DeployPart, DeployRow, DeploysAnswer, Release } from '@hub/api';

/** One deployable thing on the Host page: the hub, the dashboard, or one server's Mod. */
export type ReleaseRow = {
  key: string;
  label: string;
  part: DeployPart;
  server?: string;
  running: string | null;
  latest: string | null;
  releases: Release[];
  /** The latest release is newer than the one running (only when that is a listed release: never for dev). */
  newer: boolean;
  /** Its deploy in progress, if any. */
  deploying: DeployRow | undefined;
};

const DAY = 24 * 60 * 60_000;

export function releaseRows(a: DeploysAnswer): ReleaseRow[] {
  const running = (part: DeployPart, server?: string) => a.history.find((h) => h.outcome === 'running' && h.part === part && (!server || h.target === server));
  const row = (key: string, label: string, part: DeployPart, run: string | null, latest: string | null, releases: Release[], server?: string): ReleaseRow => ({
    key,
    label,
    part,
    server,
    running: run,
    latest,
    releases,
    newer: releases.findIndex((r) => r.tag === run) > 0,
    deploying: running(part, server),
  });
  return [
    row('hub', 'Hub', 'hub', a.hub.running, a.hub.latest, a.hub.releases),
    row('web', 'Dashboard', 'web', a.web.running, a.web.latest, a.web.releases),
    ...a.mod.servers.map((s) => row(`mod:${s.id}`, `Mod on ${s.name}`, 'mod', s.running, a.mod.latest, a.mod.releases, s.id)),
  ];
}

/** The oldest release newer than the running one has waited longer than `newerAfterDays`: it needs attention. */
export function overdue(r: ReleaseRow, a: DeploysAnswer, now = Date.now()): boolean {
  const at = r.releases.findIndex((rel) => rel.tag === r.running);
  return at > 0 && r.releases[at - 1]!.publishedAt < now - a.newerAfterDays * DAY;
}

/** `hub-v2.6.0` → `v2.6.0`. */
export const short = (tag: string | null) => tag?.replace(/^(hub|web|mod)-/, '') ?? 'unknown';

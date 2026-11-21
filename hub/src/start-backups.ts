// The Backups' wiring, for `startHub`: `watchBackups` builds `Stats` before the `BackupWatcher`, armed for each server
// with a Backup source (an Agent's with `played`); `buildRestores`, called once `Services` is built, builds `Restores`,
// with systemd and a `RestoreSource` for any server (an Agent's, or a folder's with the injected `restore`).
// `Restores`' `deploying(id)`: a hub deploy, or the server's Agent's (`agentBusy`); its `updating` adds a game settings
// save to `updating`'s kinds; deploys, game settings and packs are read from `Late` when called.

import type { Agents } from './agents/agents.ts';
import { BackupWatcher } from './backups/backups.ts';
import { agentRestore, folderRestore, Restores, type RestoreSource } from './backups/restore.ts';
import type { Config } from './config.ts';
import type { Db } from './stats/db.ts';
import type { ServerHub } from './servers/servers.ts';
import type { Services } from './services/services.ts';
import { Stats } from './stats/stats.ts';
import type { Late, Updating } from './start-core.ts';
import type { HubDeps } from './start.ts';

/** Builds `Stats` (each server's Backup source) and the `BackupWatcher`, with a watchdog for each server that has one. */
export function watchBackups(config: Config, hub: ServerHub, db: Db, agents: Agents | undefined, agentOf: Map<string, string>) {
  // Before anything that reads Backups: each server's Backup source (its folder, or its Agent's saves) is Stats'.
  const stats = new Stats(hub, db, config.servers, agents);
  const backups = new BackupWatcher(
    hub,
    (serverId) => stats.backupSource(serverId)?.list() ?? Promise.resolve([]),
    (serverId) => stats.backupSource(serverId)?.free() ?? Promise.resolve(null),
  );
  for (const s of config.servers) {
    if (!stats.backupSource(s.id)) continue;
    // An Agent saves only after play, so its saves are overdue only once someone has played since the newest.
    const played = agentOf.has(s.id) ? (since: number) => db.sessionsSince(s.id, since).length > 0 : undefined;
    backups.watchdog(s.id, { maxAgeHours: s.backupMaxAgeHours, minFreeGB: s.backupMinFreeGB, played });
  }
  return { stats, backups };
}

type RestoresParts = {
  hub: ServerHub;
  services: Services | undefined;
  agents: Agents | undefined;
  agentOf: Map<string, string>;
  stats: Stats;
  updating: Updating;
  late: Late;
};

/** Builds `Restores` when systemd is on and a server has a restore source; undefined otherwise. */
export function buildRestores(config: Config, deps: HubDeps, { hub, services, agents, agentOf, stats, updating, late }: RestoresParts) {
  // A restore source per server: its Agent's restore, or its folder's script.
  const restoreSources = new Map<string, RestoreSource>();
  for (const s of config.servers) {
    const agentId = agentOf.get(s.id);
    if (agents && agentId !== undefined) restoreSources.set(s.id, agentRestore(agents, agentId, stats.backupSource(s.id)!.list));
    else if (deps.restore && s.dir && s.backupDir) restoreSources.set(s.id, folderRestore(deps.restore, s.dir, s.backupDir));
  }
  return services && restoreSources.size
    ? new Restores(hub, services, restoreSources, {
        deploying: (id) => (late.deploys?.busy() ? 'hub' : agentOf.has(id) && late.deploys?.agentBusy(agentOf.get(id)!) ? 'agent' : null),
        // A game settings save too: the Agent writes the config folder then.
        updating: (id): string | null => updating(id) ?? (late.gameSettings?.busy(id) ? 'game settings save' : null),
        restored: (id) => late.packs?.restored(id),
      })
    : undefined;
}

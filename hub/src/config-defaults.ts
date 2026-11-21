// Three of the defaults `loadConfig` applies (the rest are its own or `resolveWeb`'s): production's deploy targets (`PRODUCTION_DEPLOYS`, also the root `validateConfig`
// checks `dbPath` against when `deploys.root` is unset), a Host's warning limits (`HOST_LIMITS`, for
// `integrations.host` and each Agent's Host), and `resolve`, which turns a server entry into its `ServerSettings` (game
// `minecraft`, lag 15 TPS (50 UPS for factorio)/2 min, quests `batched`, 10 GB free, the Backup folder `backupDir`, else
// `<dir>/backups`). The only place per-server defaults live. Hub core, offline.

import { join } from 'node:path';
import type { DeployTargets, HostLimits, ServerEntry, ServerSettings } from './config-types.ts';
import type { Game } from './types.ts';

/** Production's deploy targets, what `integrations.github.deploys` leaves out. */
export const PRODUCTION_DEPLOYS: DeployTargets = {
  root: '/home/opc/orrery',
  hubUnit: 'orrery-hub.service',
  hubTemplate: 'orrery-deploy',
  webTemplate: 'orrery-deploy-web',
  webDir: '/var/www/orrery',
};

/** A Host's warning limits when its config leaves them out. */
export const HOST_LIMITS: HostLimits = { memoryMaxPercent: 90, memoryMinutes: 5, diskMinFreeGB: 10 };

/** The default `lagTps` per game. */
const LAG_TPS: Record<Game, number> = { minecraft: 15, factorio: 50 };

export function resolve(s: ServerEntry): ServerSettings {
  const { lagTps, lagMinutes, lagAlerts, ...rest } = s;
  const game = s.game ?? 'minecraft';
  return {
    ...rest,
    game,
    backupDir: s.backupDir ?? (s.dir ? join(s.dir, 'backups') : undefined),
    backupMinFreeGB: s.backupMinFreeGB ?? 10,
    lag: { tps: lagTps ?? LAG_TPS[game], minutes: lagMinutes ?? 2, enabled: lagAlerts ?? true },
    quests: s.quests ?? 'batched',
  };
}

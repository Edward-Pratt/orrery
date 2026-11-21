// The config's types: `Config` as `loadConfig` returns it, with `ServerSettings` per server and each integration's
// section and `ServerEntry` (a server as written, which `resolve` in `config-defaults.ts` turns into its settings).
// `config.ts` re-exports every one but `ServerEntry`. Hub core.
//
// Config shape: `dbPath`, `healthcheckUrl`, `servers[]` (each with a `game`: `minecraft`, the default, or `factorio`; ids at most
// 256 characters, the wire's cap; only a minecraft server needs a Mod token (16 to 256 characters), and a factorio
// server is refused one, a `dir`, a `backupDir` and `keep`, needs a `service`, and is the `server` of exactly one
// Agent; `lagTps` up to the game's full rate, 20 or 60), `integrations.agents` (`listen`: an IPv4 address and a port
// other than the Minecraft and web ones; `agents[]`: id `^[a-z][a-z0-9-]{0,31}$`, also its Host's, so not
// `integrations.host`'s id; name; a token of 32 to 256 characters, unique among every token, Mod tokens too; its IPv4
// `address`; its factorio `server`, whose `service` it then backs; `host` limits, defaulted like
// `integrations.host`'s), and `integrations.minecraft` (port, tokens) / `integrations.discord` (guild, admin role,
// channels keyed by server id, optional `alertsChannel` for the host, services and checks), `integrations.systemd`
// (id, unit name; the only units the hub touches), `integrations.checks` (id, URL, `intervalSeconds` ≥ 30, optional
// linked `service`), `integrations.host` (id, mounts, memory and disk limits; defaulted by `loadConfig`),
// `integrations.web` (port, public URL, session days, the Status page; the Discord login's keys warn, `web-config.ts`),
// `integrations.github` (`repo`, `newerAfterDays` (14), and `deploys`: the hub's root, hub
// unit, deploy unit templates and dashboard folder, defaulted to production's `PRODUCTION_DEPLOYS`; paths absolute,
// unit names checked; with GitHub on, `dbPath` must be a file directly in that root, never under `current/`, which
// each hub deploy replaces), and a server's `keep` (paths in its folder a pack update never touches: relative, no
// `..`).

import type { LagConfig } from './servers/lag.ts';
import type { QuestMode } from './servers/quests.ts';
import type { Game } from './types.ts';

/** A server entry as written in config.json. */
export type ServerEntry = {
  id: string;
  name: string;
  game?: Game;
  dir?: string;
  dailyRestart?: string;
  dailySummary?: string;
  backupDir?: string;
  backupMaxAgeHours?: number;
  backupMinFreeGB?: number;
  lagTps?: number;
  lagMinutes?: number;
  lagAlerts?: boolean;
  quests?: QuestMode;
  service?: string;
  keep?: string[];
};

/** What a server is configured to do, with every default applied. */
export type ServerSettings = {
  id: string;
  name: string;
  /** Default `minecraft`. */
  game: Game;
  dir?: string;
  /** `backupDir`, else `<dir>/backups`, else none (no Backup features). */
  backupDir?: string;
  dailyRestart?: string;
  dailySummary?: string;
  /** Unset: no missing-Backup check. */
  backupMaxAgeHours?: number;
  backupMinFreeGB: number;
  lag: LagConfig;
  quests: QuestMode;
  /** The id of the service (in `integrations.systemd`) this server runs as. */
  service?: string;
  /** Paths in `dir` a pack update never deletes or overwrites, besides the built-in ones. */
  keep?: string[];
};

/** The bot's guild, the role allowed to run admin commands, and a channel per server id. */
export type DiscordConfig = {
  guildId: string;
  adminRoleId: string;
  /** serverId -> channelId. A server with no channel gets no chat or posts in Discord. */
  channels: Record<string, string>;
  /** Where notices about the host, services and checks go; unset: they aren't posted. */
  alertsChannel?: string;
};

/** The mod port and a token per server id. */
export type MinecraftIntegration = { listenPort: number; tokens: Record<string, string> };

/** The HTTP API: localhost port, the public URL (the CSRF origin; invite links are built on it), how long a login lasts. */
export type WebIntegration = {
  listenPort: number;
  publicUrl: string;
  sessionDays: number;
  /** The Status page's servers, by id, in the order shown; without it there is no Status page. */
  status?: { servers: string[] };
};

/** A URL requested every `intervalSeconds`; up means HTTP 2xx within the request timeout. May name its service. */
export type CheckConfig = { id: string; url: string; intervalSeconds: number; service?: string };

/** A systemd unit the hub may see (and later control), by id. Only listed units exist to the hub. */
export type ServiceConfig = { id: string; unit: string };

/**
 * The machine the hub runs on, by id: the mounts whose disk is watched, and when to warn: memory use at or over
 * `memoryMaxPercent` for `memoryMinutes`, and a mount under `diskMinFreeGB` free.
 */
export type HostIntegration = { id: string; mounts: string[]; memoryMaxPercent: number; memoryMinutes: number; diskMinFreeGB: number };

/** When to warn about a Host an Agent reports (its mounts are the Agent's own config): as `HostIntegration`'s. */
export type HostLimits = Omit<HostIntegration, 'id' | 'mounts'>;

/**
 * An Agent on a remote Host, by id (also its Host's id): its name, its token (32 to 256 characters), the tailnet
 * address it must connect from, the factorio server it runs (`server`; that server's `service` is then backed by
 * this Agent), and its Host's warning limits (defaulted like `integrations.host`'s).
 */
export type AgentConfig = { id: string; name: string; token: string; address: string; server: string; host: HostLimits };

/** The Agent port (`listen`: an IPv4 address, normally the hub's tailnet one, and a port) and the Agents allowed on it. */
export type AgentsIntegration = { listen: { host: string; port: number }; agents: AgentConfig[] };

/**
 * Where the hub's deploys go: its root (`releases/`, `current`, `config.json`, `hub.db`, `deploy.lock`,
 * `deploy-status.json`), its hub's unit, the templates of its hub and dashboard deploy units (`<template>@<tag>.service`)
 * and where its dashboard is served from.
 */
export type DeployTargets = { root: string; hubUnit: string; hubTemplate: string; webTemplate: string; webDir: string };

/**
 * GitHub: the repo (`owner/name`) whose published releases the hub offers, how many days a newer one waits before
 * it needs attention, and the hub's deploy targets. The token comes from `GITHUB_TOKEN`, never config.
 */
export type GithubIntegration = { repo: string; newerAfterDays: number; deploys: DeployTargets };

export type Config = {
  dbPath: string;
  healthcheckUrl?: string;
  servers: ServerSettings[];
  /** Each integration is on when its section is present; none is required. */
  integrations: {
    minecraft?: MinecraftIntegration;
    discord?: DiscordConfig;
    web?: WebIntegration;
    checks?: CheckConfig[];
    host?: HostIntegration;
    systemd?: ServiceConfig[];
    github?: GithubIntegration;
    agents?: AgentsIntegration;
  };
};

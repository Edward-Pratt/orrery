// The config tests' shared setup (`test/config*.test.ts`): a Discord ID (`ID`), a valid config with one minecraft
// server in `dir` and the Minecraft and Discord integrations (`valid`), and the same plus a factorio server, its service
// and the Agent that runs it (`withFactorio`, with that Agent's `AGENT_TOKEN`).

export const ID = '123456789012345678';

export function valid(dir: string) {
  return {
    dbPath: 'hub.db',
    healthcheckUrl: 'https://hc-ping.com/abc',
    servers: [
      {
        id: 'gtnh',
        name: 'GTNH',
        dir,
        dailyRestart: '06:00',
        dailySummary: '09:00',
        backupMaxAgeHours: 26,
        backupMinFreeGB: 10,
        lagTps: 15,
        lagMinutes: 2,
        lagAlerts: true,
        quests: 'batched',
      } as Record<string, unknown>,
    ],
    integrations: {
      minecraft: { listenPort: 25580, tokens: { gtnh: 'a-long-enough-token' } as Record<string, string> },
      discord: { guildId: ID, adminRoleId: ID, channels: { gtnh: ID } as Record<string, string> },
    },
  };
}

export const AGENT_TOKEN = 'an-agent-token-of-at-least-32-chars';

/** `valid(dir)` plus a factorio server, its service and the Agent that runs it. */
export function withFactorio(dir: string) {
  const c = valid(dir);
  c.servers.push({ id: 'space', name: 'Space Age', game: 'factorio', service: 'factorio', lagTps: 55 });
  return {
    ...c,
    integrations: {
      ...c.integrations,
      systemd: [{ id: 'factorio', unit: 'factorio.service' }],
      agents: {
        listen: { host: '100.101.102.103', port: 25584 },
        agents: [{ id: 'factorio-vm', name: 'Factorio VM', token: AGENT_TOKEN, address: '100.90.80.70', server: 'space' } as Record<string, unknown>],
      },
    },
  };
}

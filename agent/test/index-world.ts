// The world of the tests that run `src/index.ts` as a child process (`index.test.ts`, `index-check.test.ts`): a temp
// config, the agent's folder, the server's data folder and a fake `systemctl` first on `PATH` (`world`), a
// `settingsSet` the hub's rules let through, and Factorio's `/orrery-status` answer (`status`).

import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { PASSWORD } from './fake-rcon.ts';

export const TOKEN = 'k'.repeat(40);
export const INDEX = new URL('../src/index.ts', import.meta.url).pathname;

/**
 * The agent's world in a temp folder: its config (pointing at a fake hub and a fake RCON), its own folder, the
 * server's data folder with server-settings.json, and a fake systemctl first on PATH that logs its argv (and can't
 * read orrery-agent.service, which only the check asks about).
 */
export async function world(t: TestContext, rconPort: number, hubPort: number) {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-index-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, 'agent');
  const data = join(dir, 'factorio');
  await mkdir(root);
  await mkdir(join(data, 'config'), { recursive: true });
  await mkdir(join(data, 'saves'));
  await writeFile(join(data, 'saves', 'world.zip'), 'map');
  await mkdir(join(dir, 'bin'));
  await writeFile(join(data, 'config', 'server-settings.json'), JSON.stringify({ auto_pause: true }));
  const config = {
    id: 'factorio-vm',
    hub: { host: '127.0.0.1', port: hubPort },
    server: { id: 'factorio', unit: 'factorio.service', install: join(dir, 'opt'), data, rconPort, factorioUdpPort: 34198, agentUdpPort: 34199 },
    mounts: ['/'],
  };
  await writeFile(join(dir, 'config.json'), JSON.stringify(config));
  await writeFile(
    join(dir, 'bin', 'systemctl'),
    // A deploy unit has ended (its oneshot is inactive); orrery-agent.service can't be read; every other unit runs.
    // list-units prints `<dir>/units` (none: no deploy unit known).
    `#!/bin/sh\necho "$*" >> "${dir}/systemctl.log"\ncase "$*" in list-units*) cat "${dir}/units" 2>/dev/null; exit 0;; *orrery-agent-deploy@*) echo ActiveState=inactive; exit 0;; *orrery-agent.service) exit 1;; esac\nprintf 'ActiveState=active\\nSubState=running\\nStateChangeTimestamp=@1793475924\\nResult=success\\n'\n`,
  );
  await chmod(join(dir, 'bin', 'systemctl'), 0o755);
  const env = {
    ...process.env,
    PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
    ORRERY_AGENT_CONFIG: join(dir, 'config.json'),
    ORRERY_AGENT_ROOT: root,
    ORRERY_AGENT_TOKEN: TOKEN,
    RCON_PASSWORD: PASSWORD,
  };
  return { dir, root, env };
}

/** A `settingsSet` the hub's rules let through: a new name and player limit, Bob an admin. */
export const settingsSet = (id: string) => ({
  type: 'settingsSet',
  id,
  settings: {
    name: 'Our base',
    description: '',
    max_players: 8,
    require_user_verification: true,
    autosave_interval: 10,
    autosave_slots: 5,
    afk_autokick_interval: 0,
    auto_pause: true,
    auto_pause_when_players_connect: false,
    only_admins_can_pause_the_game: true,
    allow_commands: 'admins-only',
  },
  admins: ['bob'],
});

export const status = () =>
  JSON.stringify({ ok: true, tick: Date.now(), tick_paused: false, players: {}, version: '2.1.24', mods: { base: '2.1.24', orrery: '0.1.0' }, loaded: true });

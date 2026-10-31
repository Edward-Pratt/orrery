// The orrery agent (orrery-agent.service): `index.ts` runs it, `index.ts check` runs the first-boot check.
// ORRERY_AGENT_CONFIG and ORRERY_AGENT_ROOT move the config file and the agent's folder, for tests and the local dev
// loop only; on the Host they are unset.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check } from './check.ts';
import { AGENT_ROOT, CONFIG_PATH, loadConfig, type Config } from './config.ts';
import { HostSampler } from './host.ts';
import { HubClient } from './hub.ts';
import { ServiceWatch } from './service.ts';
import { StatusPoller } from './status.ts';

/** This release as the hub and deploys name it: `agent-v` and package.json's version (0.0.0 outside a release). */
function agentVersion(): string {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('package.json has no X.Y.Z "version"');
  return `agent-v${version}`;
}

const load = (): Config =>
  loadConfig(process.env.ORRERY_AGENT_CONFIG ?? CONFIG_PATH, process.env, process.env.ORRERY_AGENT_ROOT ?? AGENT_ROOT);

/** Runs until SIGTERM or SIGINT. With no hub reachable it keeps running: RCON, the unit and host samples go on, and the hub client retries. */
function run(): void {
  const config = load();
  const version = agentVersion();
  console.log(`[agent] ${version}: agent ${config.id}, server ${config.server.id}`);
  const hub = new HubClient({ config, version });
  const service = new ServiceWatch(config.server.unit);
  const status = new StatusPoller({
    port: config.server.rconPort,
    password: config.rconPassword,
    settings: join(config.server.data, 'config', 'server-settings.json'),
  });
  const host = new HostSampler(config.mounts);
  service.on('change', (s) => hub.service(s));
  status.on('status', (r) => hub.status(r));
  status.on('stalled', () => hub.stalled());
  status.on('down', () => hub.down());
  const sample = () =>
    host.sample().then(
      (s) => s && hub.sample(s),
      (err: Error) => console.error(`[host] sample failed: ${err.message}`),
    );
  void sample(); // the first CPU reading, which the next sample measures from
  const sampling = setInterval(sample, 60_000);
  hub.start();
  service.start();
  status.start();

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[agent] ${signal}: saying bye`);
    clearInterval(sampling);
    status.stop();
    service.stop();
    void hub.stop().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const [command] = process.argv.slice(2);
try {
  if (command === 'check') process.exit((await check(load, agentVersion())) ? 0 : 1);
  else if (command === undefined) run();
  else {
    console.error('usage: index.ts [check]');
    process.exit(2);
  }
} catch (err) {
  console.error(`[agent] ${(err as Error).message}`);
  process.exit(1);
}

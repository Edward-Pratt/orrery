// The orrery agent (orrery-agent.service): `index.ts` runs it, `index.ts check` runs the first-boot check.
// ORRERY_AGENT_CONFIG and ORRERY_AGENT_ROOT move the config file and the agent's folder, for tests and the local dev
// loop only; on the Host they are unset.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { check } from './check.ts';
import { AGENT_ROOT, CONFIG_PATH, loadConfig, type Config } from './config.ts';
import { Deploys } from './deploy.ts';
import { GameEvents, toGame } from './events.ts';
import { HostSampler } from './host.ts';
import { HubClient } from './hub.ts';
import { AGENT_LOG, AgentLog, Logs, logTo } from './logs.ts';
import { RconSession } from './rcon.ts';
import { Saves } from './saves.ts';
import { ServiceWatch } from './service.ts';
import { StatusPoller } from './status.ts';
import { Updates, installedOf } from './update.ts';
import { outputLines } from './wire.ts';

/** This release as the hub and deploys name it: `agent-v` and package.json's version (0.0.0 outside a release). */
function agentVersion(): string {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('package.json has no X.Y.Z "version"');
  return `agent-v${version}`;
}

/** The config file; setup's `image.json` sits beside it. */
const configPath = (): string => process.env.ORRERY_AGENT_CONFIG ?? CONFIG_PATH;
const load = (): Config => loadConfig(configPath(), process.env, process.env.ORRERY_AGENT_ROOT ?? AGENT_ROOT);

/**
 * Runs until SIGTERM or SIGINT. With no hub reachable it keeps running: RCON, the unit, game events, saves and host
 * samples go on, and the hub client retries. Every RCON command (`/orrery-hello`, `/orrery-save`, the hub's say,
 * notice, linkResult and console commands) runs on an RCON connection of its own, apart from the status poll's.
 * Everything logged also goes to `<root>/agent.log`, URL query strings stripped. A game update that a restart cut
 * short ends first thing (`Updates.start`: failed before its swap, rolled back after). A deploy's outcome
 * (`deploy-status.json`) goes to the hub once its unit has ended (`Deploys`).
 */
function run(): void {
  const config = load();
  logTo(new AgentLog(join(config.root, AGENT_LOG)));
  const version = agentVersion();
  console.log(`[agent] ${version}: agent ${config.id}, server ${config.server.id}`);
  const data = config.server.data;
  const commands = new RconSession(config.server.rconPort, config.rconPassword);
  const run = (command: string) => commands.exec(command);
  const service = new ServiceWatch(config.server.unit);
  const logs = new Logs({ data, root: config.root, unit: config.server.unit });
  const saves = new Saves({ dir: join(data, 'saves'), log: join(data, 'factorio-current.log'), run, unit: () => service.read() });
  const hub: HubClient = new HubClient({
    config,
    version,
    toGame: (msg) => void toGame(run, msg),
    command: async (command) => outputLines(await run(command)),
    save: () => void saves.save(),
    welcomed: () => {
      updates.connected();
      deploys.connected();
    },
    handlers: {
      serviceAct: ({ action }) => service.act(action),
      logs: () => logs.list(),
      log: ({ name }) => logs.log(name),
      journal: ({ unit }) => logs.journal(unit),
      restore: ({ name }) => (updates.busy ? Promise.reject(new Error('a game update is running')) : saves.restore(name)),
      update: (req) => updates.update(req),
      updateResume: ({ id }) => updates.resume(id),
      updateCancel: ({ id }) => updates.cancel(id),
      deploy: ({ tag }) => deploys.deploy(tag),
    },
  });
  const updates: Updates = new Updates({
    install: config.server.install,
    data,
    state: config.state,
    image: join(dirname(configPath()), 'image.json'),
    unit: service,
    saves,
    send: (msg) => hub.send(msg),
    gameUp: () => hub.gameUp,
  });
  const deploys: Deploys = new Deploys({ root: config.root, state: config.state, busy: () => updates.busy, send: (msg) => hub.send(msg) });
  const status = new StatusPoller({
    port: config.server.rconPort,
    password: config.rconPassword,
    settings: join(config.server.data, 'config', 'server-settings.json'),
  });
  const events = new GameEvents({
    port: config.server.agentUdpPort,
    factorioPort: config.server.factorioUdpPort,
    log: join(config.server.data, 'factorio-current.log'),
    players: () => status.players,
    run,
  });
  const host = new HostSampler(config.mounts);
  service.on('change', (s) => {
    hub.service(s);
    events.service(s);
  });
  service.on('stopping', () => hub.stopping());
  status.on('status', (r, s) => {
    hub.status(r);
    events.rconUp();
    saves.played(r.players.length > 0);
    updates.status(s);
    hub.installed(installedOf(s));
  });
  saves.on('saves', (m) => hub.saves(m));
  saves.on('backup', (b) => hub.backup(b));
  events.on('event', (e) => hub.event(e));
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
  events.start();
  saves.start();
  void updates.start();
  deploys.start();

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[agent] ${signal}: saying bye`);
    clearInterval(sampling);
    status.stop();
    service.stop();
    events.stop();
    saves.stop();
    updates.stop();
    deploys.stop();
    commands.close();
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

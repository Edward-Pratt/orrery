import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';
import { parseAgentLine } from '../../hub/src/protocol.ts';
import { DEPLOY_STATUS, Deploys, deployArgs, deployUnit, isTag, logExcerpt, readStatus, type DeployResultMsg, type DeploysOptions } from '../src/deploy.ts';
import { HubClient } from '../src/hub.ts';
import { LIMITS, encode } from '../src/wire.ts';
import { eventually, fakeHub } from './fake-hub.ts';
import { fakeSystemctl } from './fake-systemctl.ts';

const run = promisify(execFile);
const DEPLOY = new URL('../../deploy/', import.meta.url).pathname;
const TOKEN = 'agent-token-'.padEnd(40, 'x');
const SERVER = { id: 'factorio', unit: 'factorio.service', install: '/opt/factorio', data: '/srv/factorio', rconPort: 1, factorioUdpPort: 34198, agentUdpPort: 34199 };

/** The `node -e '…'` program inside a function of deploy-agent.sh, exactly as the script runs it. */
async function scriptNode(fn: 'connected' | 'finish'): Promise<string> {
  const script = await readFile(join(DEPLOY, 'deploy-agent.sh'), 'utf8');
  const body = new RegExp(`^${fn}\\(\\) \\{[\\s\\S]*?node -e '([^']*)'`, 'm').exec(script)?.[1];
  assert.ok(body, `deploy-agent.sh's ${fn}() has its node -e program`);
  return body;
}

/** `<root>/deploy-status.json` as deploy-agent.sh's finish() writes it: its own node program, then a rename. */
async function scriptStatus(root: string, s: { tag: string; from: string; outcome: string; excerpt: string }): Promise<void> {
  const env = { ...process.env, TAG: s.tag, FROM: s.from, OUTCOME: s.outcome, EXCERPT: s.excerpt };
  const { stdout } = await run(process.execPath, ['-e', await scriptNode('finish')], { env });
  await writeFile(join(root, '.deploy-status.json.tmp'), stdout);
  await rename(join(root, '.deploy-status.json.tmp'), join(root, DEPLOY_STATUS));
}

/** A Deploys on a temp agent folder, with a fake systemctl: `show` says `active` for the deploy unit, the rest is recorded. */
async function setup(t: TestContext, options: Partial<DeploysOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orrery-deploy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  const w = {
    root,
    state,
    active: 'inactive',
    connected: true,
    calls: [] as string[][],
    sent: [] as DeployResultMsg[],
    deploys: null as unknown as Deploys,
    make: () =>
      new Deploys({
        root,
        state,
        busy: () => false,
        send: (msg) => w.connected && (w.sent.push(msg), true),
        run: async (args) => {
          w.calls.push(args);
          return args[0] === 'show' ? `ActiveState=${w.active}\n` : '';
        },
        pollMs: 10,
        ...options,
      }),
  };
  w.deploys = w.make();
  t.after(() => w.deploys.stop());
  return w;
}

test('the deploy unit and argv: start --no-block -- orrery-agent-deploy@<tag>.service, exactly what polkit allows', async () => {
  assert.equal(deployUnit('agent-v1.2.3'), 'orrery-agent-deploy@agent-v1.2.3.service');
  assert.deepEqual(deployArgs('agent-v1.2.3'), ['start', '--no-block', '--', 'orrery-agent-deploy@agent-v1.2.3.service']);

  // The rules file itself, run with a fake polkit: the verb and unit systemctl asks for are allowed for factorio only.
  let rule: ((action: object, subject: object) => unknown) | undefined;
  const polkit = { addRule: (fn: typeof rule) => (rule = fn), Result: { YES: 'yes' } };
  runInNewContext(await readFile(join(DEPLOY, '60-orrery-agent.rules'), 'utf8'), { polkit });
  const ask = (args: string[], user = 'factorio') => {
    const details: Record<string, string> = { unit: args.at(-1)!, verb: args[0]! };
    return rule!({ id: 'org.freedesktop.systemd1.manage-units', lookup: (k: string) => details[k] }, { user });
  };
  assert.equal(ask(deployArgs('agent-v1.2.3')), 'yes');
  assert.equal(ask(deployArgs('agent-v10.0.42')), 'yes');
  assert.equal(ask(deployArgs('agent-v1.2.3'), 'opc'), undefined, 'only for factorio');
  assert.equal(ask(['stop', '--no-block', '--', deployUnit('agent-v1.2.3')]), undefined, 'start only');
  assert.equal(ask(deployArgs('agent-v1.2')), undefined, 'polkit refuses what isTag refuses');
});

test('deploy: a well-formed tag only, nothing else from the request in the argv; a refusal is the error', async (t) => {
  const w = await setup(t);
  for (const tag of ['agent-v1.2', 'agent-v1.2.3.service', 'Agent-v1.2.3', 'agent-v1.2.3 ', 'agent-v1.2.3\n', 'hub-v1.2.3', '../agent-v1.2.3', 'agent-v1.2.3/../x', 'agent-v١.2.3', `agent-v1.2.${'3'.repeat(250)}`, '']) {
    assert.equal(isTag(tag), false, JSON.stringify(tag));
    await assert.rejects(w.deploys.deploy(tag), /is not an agent-vX\.Y\.Z tag/, JSON.stringify(tag));
  }
  assert.deepEqual(w.calls, [], 'systemctl never ran');
  await w.deploys.deploy('agent-v1.2.3');
  assert.deepEqual(w.calls, [['start', '--no-block', '--', 'orrery-agent-deploy@agent-v1.2.3.service']]);
});

test('deploy is refused while a game update runs, and systemctl never runs', async (t) => {
  let busy = true;
  const w = await setup(t, { busy: () => busy });
  await assert.rejects(w.deploys.deploy('agent-v1.2.3'), /a game update is running/);
  assert.deepEqual(w.calls, []);
  busy = false;
  await w.deploys.deploy('agent-v1.2.3');
  assert.equal(w.calls.length, 1);
});

test('the hub\'s deploy through HubClient: systemctl through execFile (no shell), exactly that argv; a polkit refusal answered ok: false', async (t) => {
  const systemctl = await fakeSystemctl(t);
  const hub = await fakeHub();
  const root = await mkdtemp(join(tmpdir(), 'orrery-deploy-'));
  const deploys = new Deploys({ root, state: join(root, 'state'), busy: () => false, send: () => false });
  const client = new HubClient({
    config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server: SERVER, token: TOKEN, root, state: join(root, 'state') },
    version: 'agent-v1.2.2',
    handlers: { deploy: ({ tag }) => deploys.deploy(tag) },
  });
  t.after(async () => {
    await client.stop();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  });
  client.start();
  const agent = await eventually(() => hub.of('agentHello')[0]);
  await eventually(() => client.connected);
  const reply = (id: string) => eventually(() => agent.lines.find((m) => m.type === 'reply' && m.id === id), 5000, `reply ${id}`);

  agent.send({ type: 'deploy', id: 'd1', tag: 'agent-v1.2.3', path: '/tmp/x', args: ['--now'] });
  assert.deepEqual(await reply('d1'), { type: 'reply', id: 'd1', ok: true });
  assert.deepEqual(await systemctl.calls(), [['start', '--no-block', '--', 'orrery-agent-deploy@agent-v1.2.3.service']]);

  agent.send({ type: 'deploy', id: 'd2', tag: 'agent-v1.2.3; reboot' });
  assert.deepEqual(await reply('d2'), { type: 'reply', id: 'd2', ok: false, error: '"agent-v1.2.3; reboot" is not an agent-vX.Y.Z tag' });

  await systemctl.refuse(true);
  agent.send({ type: 'deploy', id: 'd3', tag: 'agent-v1.2.4' });
  const refused = await reply('d3');
  assert.equal(refused.ok, false);
  assert.match(refused.error as string, /^systemctl start orrery-agent-deploy@agent-v1\.2\.4\.service failed: [\s\S]*Access denied/);
  assert.equal((await systemctl.calls()).length, 2, 'no call for the bad tag');
  assert.deepEqual(agent.invalid, []);
});

test('deployResult: the status deploy-agent.sh writes, once its unit has ended, once per deploy (kept across a restart)', async (t) => {
  const w = await setup(t);
  await w.deploys.check();
  assert.deepEqual([w.sent, w.calls], [[], []], 'no status file: nothing, and no systemctl');

  await scriptStatus(w.root, { tag: 'agent-v1.2.3', from: 'agent-v1.2.2', outcome: 'ok', excerpt: 'deploying agent-v1.2.3\nagent-v1.2.3 connected' });
  w.active = 'activating'; // the script still prunes after writing the file
  await w.deploys.check();
  assert.deepEqual(w.sent, []);
  assert.deepEqual(w.calls, [['show', '--property=ActiveState', '--', 'orrery-agent-deploy@agent-v1.2.3.service']]);
  w.active = 'deactivating';
  await w.deploys.check();
  assert.deepEqual(w.sent, []);

  w.active = 'inactive';
  w.connected = false; // the Agent connection is down: kept for the next connect
  await w.deploys.check();
  assert.deepEqual(w.sent, []);
  w.connected = true;
  w.deploys.connected();
  await w.deploys.check();
  await w.deploys.check();
  assert.deepEqual(w.sent, [{ type: 'deployResult', tag: 'agent-v1.2.3', outcome: 'ok', log: 'deploying agent-v1.2.3\nagent-v1.2.3 connected' }]);
  assert.match(await readFile(join(w.state, 'deploy.json'), 'utf8'), /^\{"sent":"\[\\"agent-v1\.2\.3\\",\\"\d{4}-\d\d-\d\dT[\d:.]+Z\\"\]"\}\n$/);

  // A restarted agent: the outcome it already sent isn't sent again.
  w.deploys.stop();
  w.deploys = w.make();
  const calls = w.calls.length;
  await w.deploys.check();
  assert.equal(w.sent.length, 1);
  assert.equal(w.calls.length, calls, 'not even a systemctl show');

  // The next deploy of the same tag (deploy-agent.sh removes the file when it starts, writes it when it ends).
  await rm(join(w.root, DEPLOY_STATUS));
  await w.deploys.check();
  await scriptStatus(w.root, { tag: 'agent-v1.2.3', from: 'agent-v1.2.2', outcome: 'failed', excerpt: "can't download orrery-agent-v1.2.3.tar.gz" });
  await w.deploys.check();
  assert.deepEqual(w.sent.slice(1), [{ type: 'deployResult', tag: 'agent-v1.2.3', outcome: 'failed', log: "can't download orrery-agent-v1.2.3.tar.gz" }]);
});

test('each outcome deploy-agent.sh writes maps to the same deployResult outcome, which the hub takes', async (t) => {
  const w = await setup(t);
  for (const outcome of ['ok', 'failed', 'rolled back'] as const) {
    await scriptStatus(w.root, { tag: 'agent-v2.0.0', from: 'agent-v1.9.9', outcome, excerpt: `outcome ${outcome}` });
    await w.deploys.check();
    const msg = w.sent.at(-1)!;
    assert.deepEqual(msg, { type: 'deployResult', tag: 'agent-v2.0.0', outcome, log: `outcome ${outcome}` });
    assert.deepEqual(parseAgentLine(encode(msg)!.trimEnd()), msg, 'the hub parses it as is');
  }
  assert.equal(w.sent.length, 3, 'one per deploy');
});

test('a status file that is not deploy-agent.sh\'s is never sent, nor turned into a unit name; logged once', async (t) => {
  const w = await setup(t);
  const errors: string[] = [];
  t.mock.method(console, 'error', (line: string) => errors.push(line));
  const bad = [
    '{"tag":"agent-v1.2.3","from":"agent-v1.2.2","outcome":"running","finished":"2026-11-01T00:00:00.000Z","log":""}',
    '{"tag":"../../x","from":"agent-v1.2.2","outcome":"ok","finished":"2026-11-01T00:00:00.000Z","log":""}',
    '{"tag":"agent-v1.2.3","from":"agent-v1.2.2","outcome":"ok","log":""}',
    '{"tag":"agent-v1.2.3","outcome":"ok","finished":"2026-11-01T00:00:00.000Z","log":7}',
    '["agent-v1.2.3"]',
    '{"tag":"agent-v1.2.3","outcome":"ok"',
  ];
  for (const text of bad) {
    assert.equal(readStatus(text), null, text);
    await writeFile(join(w.root, DEPLOY_STATUS), text);
    await w.deploys.check();
    await w.deploys.check();
  }
  assert.deepEqual([w.sent, w.calls], [[], []]);
  assert.deepEqual(errors, ["[deploy] deploy-status.json is not deploy-agent.sh's: not sent"], 'once while it stays bad');

  // A symlink in its place is not followed.
  const elsewhere = join(w.root, 'elsewhere.json');
  await writeFile(elsewhere, '{"tag":"agent-v1.2.3","from":"agent-v1.2.2","outcome":"ok","finished":"2026-11-01T00:00:00.000Z","log":""}');
  await rm(join(w.root, DEPLOY_STATUS));
  await symlink(elsewhere, join(w.root, DEPLOY_STATUS));
  await w.deploys.check();
  assert.deepEqual(w.sent, []);
});

test('the log: its last 40 lines, no URL query string, the end kept within 16 KiB', () => {
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
  assert.equal(logExcerpt(lines.join('\n')), lines.slice(-40).join('\n'));
  assert.equal(logExcerpt("can't download https://github.com/x/y.tar.gz?token=secret&a=b now"), "can't download https://github.com/x/y.tar.gz now");
  const long = logExcerpt(`${'a'.repeat(20_000)}\n${'b'.repeat(100)}\nthe end`);
  assert.equal(long.length, LIMITS.deployLog);
  assert.ok(long.endsWith(`${'b'.repeat(100)}\nthe end`));
  const wide = logExcerpt(`x${'😀'.repeat(10_000)}`); // 20,001 code units: the cut lands inside a pair
  assert.ok(wide.length <= LIMITS.deployLog);
  assert.doesNotMatch(wide, /^[\uDC00-\uDFFF]/, 'no lone low surrogate first');
});

test('polled: an outcome written after the agent connected goes out on its own; then not again after a reconnect', async (t) => {
  const hub = await fakeHub();
  const root = await mkdtemp(join(tmpdir(), 'orrery-deploy-'));
  let active = 'activating';
  const deploys: Deploys = new Deploys({
    root,
    state: join(root, 'state'),
    busy: () => false,
    send: (msg) => client.send(msg),
    run: async () => `ActiveState=${active}\n`,
    pollMs: 10,
  });
  const client: HubClient = new HubClient({
    config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server: SERVER, token: TOKEN, root, state: join(root, 'state') },
    version: 'agent-v1.2.3',
    backoffMs: 10,
    random: () => 1,
    welcomed: () => deploys.connected(),
  });
  t.after(async () => {
    deploys.stop();
    await client.stop();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  });
  deploys.start();
  client.start();
  const first = await eventually(() => hub.of('agentHello')[0]);
  await eventually(() => client.connected);
  // deploy-agent.sh saw the connected file: it writes the outcome, then its unit ends.
  await mkdir(join(root, 'state'), { recursive: true });
  await scriptStatus(root, { tag: 'agent-v1.2.3', from: 'agent-v1.2.2', outcome: 'ok', excerpt: 'agent-v1.2.3 connected' });
  await sleep(50);
  assert.deepEqual(first.lines.filter((m) => m.type === 'deployResult'), [], 'not while its unit runs');
  active = 'inactive';
  await eventually(() => first.lines.some((m) => m.type === 'deployResult'), 2000, 'the deployResult');
  first.socket.destroy(); // the hub restarts: the agent reconnects
  const second = await eventually(() => hub.of('agentHello')[1], 2000, 'a reconnect');
  await eventually(() => client.connected);
  await sleep(50);
  assert.deepEqual(
    [...first.lines, ...second.lines].filter((m) => m.type === 'deployResult'),
    [{ type: 'deployResult', tag: 'agent-v1.2.3', outcome: 'ok', log: 'agent-v1.2.3 connected' }],
    'once',
  );
  assert.deepEqual([...first.invalid, ...second.invalid], []);
});

test('the connected file HubClient writes after a welcome passes deploy-agent.sh\'s own gate for its version', async (t) => {
  const hub = await fakeHub();
  const root = await mkdtemp(join(tmpdir(), 'orrery-deploy-'));
  const client = new HubClient({
    config: { id: 'factorio-vm', hub: { host: '127.0.0.1', port: hub.port }, server: SERVER, token: TOKEN, root, state: join(root, 'state') },
    version: 'agent-v1.2.3',
  });
  t.after(async () => {
    await client.stop();
    await hub.close();
    await rm(root, { recursive: true, force: true });
  });
  const gate = await scriptNode('connected');
  const file = join(root, 'connected');
  /** deploy-agent.sh's check: exit 0 when `file` names `version` with a time from `since` (epoch ms) on. */
  const passes = (version: string, since: number) =>
    run(process.execPath, ['-e', gate, file, version, String(since)]).then(
      () => true,
      () => false,
    );
  const since = Date.now(); // `date +%s%3N` just before the restart
  assert.equal(await passes('agent-v1.2.3', since), false, 'no file yet');
  client.start();
  await eventually(() => client.connected);
  await eventually(() => existsSync(file), 2000, 'the connected file'); // renamed into place: whole once there
  assert.equal(await passes('agent-v1.2.3', since), true);
  assert.equal(await passes('agent-v1.2.2', since), false, 'another version');
  assert.equal(await passes('agent-v1.2.3', Date.now() + 60_000), false, 'a time from before the restart');
});

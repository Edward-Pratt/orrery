// `deployArgs` against `deploy/60-orrery-agent.rules` itself (run with a fake polkit: allowed for factorio, start
// only); hostile tags refused with no systemctl call; refused while a game update runs (also one that began while the
// units were listed), for the release running, while a deploy unit of any tag is activating, active, reloading or
// deactivating (from `list-units`; a failed one doesn't stop the next), and when they can't be listed; `idle` the
// same; through `HubClient` and `fakeSystemctl`, the argv exactly `['start', '--no-block', '--',
// 'orrery-agent-deploy@agent-v1.2.3.service']` whatever else the request carries, a bad tag and a polkit refusal
// answered `ok: false`. The outcome is `deploy-result.test.ts`, the setup `deploy-setup.ts`.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Deploys, deployArgs, deployUnit, isTag } from '../src/deploy.ts';
import { HubClient } from '../src/hub.ts';
import { DEPLOY, SERVER, TOKEN, setup } from './deploy-setup.ts';
import { eventually, fakeHub } from './fake-hub.ts';
import { fakeSystemctl } from './fake-systemctl.ts';

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
  const w = await setup(t, { busy: () => (busy ? 'a game update is running' : null) });
  await assert.rejects(w.deploys.deploy('agent-v1.2.3'), /a game update is running/);
  assert.deepEqual(w.calls, []);
  busy = false;
  await w.deploys.deploy('agent-v1.2.3');
  assert.equal(w.calls.length, 1);

  // A game update that began while the deploy units were being listed (it set busy, then waits on idle itself).
  const racing = await setup(t, {
    busy: () => (busy ? 'a game update is running' : null),
    run: async (args) => {
      if (args[0] === 'list-units') busy = true;
      else racing.calls.push(args);
      return '';
    },
  });
  busy = false;
  await assert.rejects(racing.deploys.deploy('agent-v1.2.3'), /a game update is running/);
  assert.deepEqual(racing.calls, []);
});

test('idle, which a game update and a restore wait for: rejects while a deploy unit of any tag has not ended, and when they cannot be listed', async (t) => {
  const w = await setup(t);
  await w.deploys.idle();
  w.units = 'orrery-agent-deploy@agent-v1.2.3.service loaded deactivating stop Deploy orrery agent agent-v1.2.3\n';
  await assert.rejects(w.deploys.idle(), /^Error: a deploy is running \(orrery-agent-deploy@agent-v1\.2\.3\.service is deactivating\)$/);
  w.units = 'orrery-agent-deploy@agent-v1.2.3.service loaded failed failed Deploy orrery agent agent-v1.2.3\n';
  await w.deploys.idle();
  const failing = await setup(t, { run: async () => Promise.reject(new Error('Failed to connect to bus\n')) });
  await assert.rejects(failing.deploys.idle(), /^Error: can't tell whether a deploy is running: Failed to connect to bus$/);
});

test('deploy is refused for the release running, and while a deploy unit of any tag has not ended; systemctl start never runs', async (t) => {
  const w = await setup(t);
  await assert.rejects(w.deploys.deploy('agent-v1.2.2'), /^Error: agent-v1\.2\.2 is already running$/);
  assert.deepEqual([w.calls, w.lists], [[], []]);

  // deploy-agent.sh holds its lock (or is gating, or pruning): another deploy would exit before writing its status.
  w.units = '● orrery-agent-deploy@agent-v1.2.3.service loaded active start Deploy orrery agent agent-v1.2.3\n';
  await assert.rejects(w.deploys.deploy('agent-v1.2.4'), /a deploy is running \(orrery-agent-deploy@agent-v1\.2\.3\.service is active\)/, 'with a bullet');
  for (const active of ['activating', 'active', 'reloading', 'deactivating']) {
    w.units = `orrery-agent-deploy@agent-v1.0.0.service loaded inactive dead Deploy orrery agent agent-v1.0.0\norrery-agent-deploy@agent-v1.2.3.service loaded ${active} start Deploy orrery agent agent-v1.2.3\n`;
    await assert.rejects(w.deploys.deploy('agent-v1.2.4'), new RegExp(`^Error: a deploy is running \\(orrery-agent-deploy@agent-v1\\.2\\.3\\.service is ${active}\\)$`));
  }
  assert.deepEqual(w.calls, [], 'never started');
  assert.deepEqual(w.lists.at(-1), ['list-units', '--all', '--plain', '--no-legend', '--full', '--', 'orrery-agent-deploy@*.service']);

  // Ended ones (failed: deploy-agent.sh exits 1 for failed and rolled back) don't stop the next.
  w.units = 'orrery-agent-deploy@agent-v1.2.3.service loaded failed failed Deploy orrery agent agent-v1.2.3\nunrelated.service loaded active running x\n';
  await w.deploys.deploy('agent-v1.2.4');
  assert.deepEqual(w.calls, [['start', '--no-block', '--', 'orrery-agent-deploy@agent-v1.2.4.service']]);

  // systemctl can't list them: refused, not guessed.
  const failing = await setup(t, { run: async (args) => (args[0] === 'list-units' ? Promise.reject(new Error('Failed to connect to bus\n')) : '') });
  await assert.rejects(failing.deploys.deploy('agent-v1.2.4'), /^Error: can't tell whether a deploy is running: Failed to connect to bus$/);
});

test('the hub\'s deploy through HubClient: systemctl through execFile (no shell), exactly that argv; a polkit refusal answered ok: false', async (t) => {
  const systemctl = await fakeSystemctl(t);
  const hub = await fakeHub();
  const root = await mkdtemp(join(tmpdir(), 'orrery-deploy-'));
  const deploys = new Deploys({ root, state: join(root, 'state'), version: 'agent-v1.2.2', busy: () => null, send: async () => false });
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

  // The one just started still runs (the fake systemctl lists it): the next is refused, and so is the running release.
  await systemctl.units(['orrery-agent-deploy@agent-v1.2.3.service loaded activating start Deploy orrery agent agent-v1.2.3']);
  agent.send({ type: 'deploy', id: 'd4', tag: 'agent-v1.2.4' });
  agent.send({ type: 'deploy', id: 'd5', tag: 'agent-v1.2.2' });
  assert.deepEqual(await reply('d4'), { type: 'reply', id: 'd4', ok: false, error: 'a deploy is running (orrery-agent-deploy@agent-v1.2.3.service is activating)' });
  assert.deepEqual(await reply('d5'), { type: 'reply', id: 'd5', ok: false, error: 'agent-v1.2.2 is already running' });
  await systemctl.units([]);

  await systemctl.refuse(true);
  agent.send({ type: 'deploy', id: 'd3', tag: 'agent-v1.2.4' });
  const refused = await reply('d3');
  assert.equal(refused.ok, false);
  assert.match(refused.error as string, /^systemctl start orrery-agent-deploy@agent-v1\.2\.4\.service failed: [\s\S]*Access denied/);
  assert.equal((await systemctl.calls()).length, 2, 'no call for the bad tag');
  assert.deepEqual(agent.invalid, []);
});

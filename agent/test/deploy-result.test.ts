// A deploy's outcome: a deploy that failed before any restart (its download) reported by the agent that started it
// once its unit is `failed`; `deployResult` from status files written by `deploy-agent.sh`'s own `finish()` program
// (extracted from the script): nothing while its unit is activating or deactivating or the hub isn't connected, not
// recorded when its write fails (sent again), then once, not again after a restart, again for the next deploy of the
// same tag; `ok`, `failed` and `rolled back` each as is and taken by the hub's `parseAgentLine`; other shapes and a
// symlink never sent, logged once; the log's 40 lines, query strings and 16 KiB end; polled after a connect, once
// across a reconnect; the `connected` file `HubClient` writes passing the script's own `connected()` program (and
// failing it for another version or an earlier time). Starting one is `deploy.test.ts`, the setup `deploy-setup.ts`.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseAgentLine } from '../../hub/src/protocol.ts';
import { DEPLOY_STATUS, Deploys, logExcerpt, readStatus } from '../src/deploy.ts';
import { HubClient } from '../src/hub.ts';
import { LIMITS, encode } from '../src/wire.ts';
import { SERVER, TOKEN, run, scriptNode, scriptStatus, setup } from './deploy-setup.ts';
import { eventually, fakeHub } from './fake-hub.ts';

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
  // Its write fails (the connection dropped as it went out): not recorded, so it goes again, then once only.
  const result = { type: 'deployResult', tag: 'agent-v1.2.3', outcome: 'ok', log: 'deploying agent-v1.2.3\nagent-v1.2.3 connected' };
  w.written = false;
  await w.deploys.check();
  assert.deepEqual(w.sent, [result]);
  assert.equal(existsSync(join(w.state, 'deploy.json')), false, 'not recorded as sent');
  w.written = true;
  w.sent = [];
  w.deploys.connected();
  await w.deploys.check();
  await w.deploys.check();
  assert.deepEqual(w.sent, [result]);
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

test('a deploy that failed before any restart (its download) is reported by the agent that started it, once its unit has failed', async (t) => {
  const w = await setup(t);
  w.deploys.start();
  await w.deploys.deploy('agent-v1.2.3');
  w.active = 'activating';
  // deploy-agent.sh's fetch failed: finish failed writes the status, then the script exits 1 and its unit is failed.
  await scriptStatus(w.root, { tag: 'agent-v1.2.3', from: 'agent-v1.2.2', outcome: 'failed', excerpt: "can't download orrery-agent-v1.2.3.tar.gz" });
  await sleep(50);
  assert.deepEqual(w.sent, [], 'not while its unit runs');
  w.active = 'failed';
  await eventually(() => w.sent.length > 0, 2000, 'the deployResult');
  await sleep(50);
  assert.deepEqual(w.sent, [{ type: 'deployResult', tag: 'agent-v1.2.3', outcome: 'failed', log: "can't download orrery-agent-v1.2.3.tar.gz" }]);
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
    version: 'agent-v1.2.3',
    busy: () => null,
    send: (msg) => client.deliver(msg),
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
  /**
   * deploy-agent.sh's check: exit 0 when `file` names `version`. The script removes the file right before each restart,
   * so no time is compared (a stale file is test-deploy-agent.sh's case).
   */
  const passes = (version: string) =>
    run(process.execPath, ['-e', gate, file, version]).then(
      () => true,
      () => false,
    );
  assert.equal(await passes('agent-v1.2.3'), false, 'no file yet');
  client.start();
  await eventually(() => client.connected);
  await eventually(() => existsSync(file), 2000, 'the connected file'); // renamed into place: whole once there
  assert.equal(await passes('agent-v1.2.3'), true);
  assert.equal(await passes('agent-v1.2.2'), false, 'another version');
});

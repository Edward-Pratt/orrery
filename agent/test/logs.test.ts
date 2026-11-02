// the three names listed only as regular files (a symlink or a FIFO in their place is neither listed nor read); names
// outside the list refused; the last 1000 and 200 lines, long lines cut and the oldest dropped to fit the hub's reply
// limits (checked with its `parseReplyData`); `agent.log` with times, query strings stripped (in the journal too),
// rotated.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { parseReplyData } from '../../hub/src/protocol.ts';
import { AGENT_UNIT, AgentLog, JOURNAL_LINES, Logs, logTo, redact } from '../src/logs.ts';
import { LIMITS } from '../src/wire.ts';

const numbered = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${from + i}`).join('\n') + '\n';

/** A server data folder and an agent folder: Factorio's two logs, `agent.log`, and a secret beside them. */
async function world(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-logs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, 'factorio');
  const root = join(dir, 'agent');
  await mkdir(join(data, 'config'), { recursive: true });
  await mkdir(root);
  await writeFile(join(data, 'factorio-current.log'), numbered(1500));
  await writeFile(join(data, 'factorio-previous.log'), 'previous run\n');
  await writeFile(join(root, 'agent.log'), 'agent line\n');
  await writeFile(join(data, 'config', 'server-settings.json'), '{"secret": true}');
  await writeFile(join(root, 'connected'), '{}');
  return { dir, data, root, logs: new Logs({ data, root, unit: 'factorio.service' }) };
}

test('logs lists factorio-current.log, factorio-previous.log and agent.log, each only if it is a regular file', async (t) => {
  const w = await world(t);
  const { files } = await w.logs.list();
  assert.deepEqual(
    files.map((f) => f.name),
    ['factorio-current.log', 'factorio-previous.log', 'agent.log'],
  );
  assert.equal(files[1]!.size, 'previous run\n'.length);
  assert.ok(files.every((f) => Number.isInteger(f.modified) && f.modified > 0));
  assert.ok(parseReplyData('logs', { files }), 'a reply the hub takes');

  // The container swaps one for a symlink to a secret, and another for a FIFO: neither is listed, nothing blocks.
  await rm(join(w.data, 'factorio-previous.log'));
  await symlink(join(w.data, 'config', 'server-settings.json'), join(w.data, 'factorio-previous.log'));
  await rm(join(w.data, 'factorio-current.log'));
  execFileSync('mkfifo', [join(w.data, 'factorio-current.log')]);
  assert.deepEqual(
    (await w.logs.list()).files.map((f) => f.name),
    ['agent.log'],
  );
  await assert.rejects(w.logs.log('factorio-previous.log'), /factorio-previous\.log is not there/, 'a symlink is not followed');
  await assert.rejects(w.logs.log('factorio-current.log'), /is not there/, 'a FIFO is not read');
});

test('log names outside the list are refused, never joined into a path', async (t) => {
  const w = await world(t);
  for (const name of ['../config/server-settings.json', 'config/server-settings.json', '/etc/passwd', 'connected', 'agent.log.1', 'factorio-current.log/', '', '__proto__', 'constructor']) {
    await assert.rejects(w.logs.log(name), /^Error: not a log this agent serves$/, JSON.stringify(name));
  }
  await assert.rejects(w.logs.journal('sshd.service'), /sshd\.service is not a unit of this agent/);
  await assert.rejects(w.logs.journal('../factorio.service'), /not a unit of this agent/);
});

test('log is the last 1000 lines, journal the last 200 of the unit’s own log file; within the hub’s limits for a reply', async (t) => {
  const w = await world(t);
  const log = await w.logs.log('factorio-current.log');
  assert.equal(log.lines.length, LIMITS.logLines);
  assert.equal(log.lines[0], 'line 501');
  assert.equal(log.lines.at(-1), 'line 1500');
  const journal = await w.logs.journal('factorio.service');
  assert.equal(journal.lines.length, JOURNAL_LINES);
  assert.equal(journal.lines[0], 'line 1301');
  assert.deepEqual((await w.logs.journal(AGENT_UNIT)).lines, ['agent line'], "the agent's own unit: agent.log");

  // Long lines: each cut to 1 KiB, and the oldest dropped until the reply's data fits 256 KiB.
  await writeFile(join(w.data, 'factorio-current.log'), Array.from({ length: 1000 }, (_, i) => `${i} ${'é'.repeat(3000)}`).join('\r\n') + '\r\n');
  const wide = await w.logs.log('factorio-current.log');
  assert.ok(wide.lines.length > 200 && wide.lines.length < 1000, String(wide.lines.length));
  assert.ok(wide.lines.every((l) => l.length === LIMITS.line && !l.endsWith('\r')));
  assert.ok(wide.lines.at(-1)!.startsWith('999 '), 'the newest kept');
  assert.ok(JSON.stringify(wide).length <= LIMITS.replyData);
  assert.deepEqual(parseReplyData('log', wide), wide, 'the hub takes it as is');
});

test('agent.log: each line with its time, URL query strings stripped (to the journal too), bounded by a rotation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-agentlog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'agent.log');
  assert.equal(
    redact('GET https://dl.factorio.com/releases/x.tar.xz?username=bob&token=abc failed; "https://cdn.example/m.zip?secure=s#f" and http://a/b'),
    'GET https://dl.factorio.com/releases/x.tar.xz failed; "https://cdn.example/m.zip" and http://a/b',
  );

  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const out: string[] = [];
  t.after(() => Object.assign(console, original));
  for (const level of ['log', 'error'] as const) console[level] = (...args: unknown[]) => out.push(args.join(' '));
  logTo(new AgentLog(file));
  console.log('[update] downloading %s', 'https://dl.factorio.com/x?token=abc');
  console.error('[update] failed: https://mods.example/y.zip?secure=zz&expires=1 (100%s)');
  Object.assign(console, original);
  const written = await readFile(file, 'utf8');
  assert.match(written, /^\d{4}-\d\d-\d\dT[\d:.]+Z \[update\] downloading https:\/\/dl\.factorio\.com\/x\n/);
  assert.ok(!/token|secure|expires/.test(written + out.join('\n')), `${written}\n${out.join('\n')}`);
  assert.deepEqual(out, ['%s [update] downloading https://dl.factorio.com/x', '%s [update] failed: https://mods.example/y.zip (100%s)']);

  const small = new AgentLog(file, 200);
  for (let i = 0; i < 10; i++) small.write(`entry ${i} ${'x'.repeat(40)}`);
  assert.ok((await readFile(file, 'utf8')).length <= 200, 'past the cap it starts again');
  assert.match(await readFile(`${file}.1`, 'utf8'), /entry/, 'the previous one kept as agent.log.1');
});

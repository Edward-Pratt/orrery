// Console commands through a game connection (`commands.ts`): the round trip, the audit, timeouts and late output.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type AuditEntry } from '../../src/servers/servers.ts';
import { online, sleep, until } from '../fake-mod.ts';
import { setup } from './server-hub.ts';

test('runCommand round-trips through the mod', async (t) => {
  const { hub, port } = await setup(t);
  const mod = await online(port);
  const result = hub.runCommand('gtnh', '/list', 'test');
  const cmd = (await mod.next()) as { type: string; id: string; command: string };
  assert.equal(cmd.type, 'cmd');
  assert.equal(cmd.command, 'list');
  mod.send({ type: 'cmdResult', id: cmd.id, output: ['There are 0/20 players online:'] });
  assert.deepEqual(await result, ['There are 0/20 players online:']);
});

test('commands sent, and only those, go to the audit log', async (t) => {
  const audit: AuditEntry[] = [];
  const { hub, port } = await setup(t, { audit: (e) => audit.push(e) });
  await assert.rejects(hub.runCommand('gtnh', 'list', 'test'), /offline/);
  const mod = await online(port);
  await assert.rejects(hub.runCommand('gtnh', ' / ', 'test'), /empty command/);
  void hub.runCommand('gtnh', '/backup start', 'discord:alice (123)').catch(() => {});
  await mod.next();
  assert.deepEqual(audit, [{ actor: 'discord:alice (123)', action: 'command', target: 'gtnh', details: 'backup start' }]);
});

test("a Mod's command has no length cap of the Agent's (256 characters)", async (t) => {
  const { hub, port } = await setup(t);
  const mod = await online(port);
  const long = 'x'.repeat(1000);
  void hub.runCommand('gtnh', long, 'test').catch(() => {});
  assert.equal(((await mod.next()) as { command: string }).command, long);
});

test('runCommand fails fast offline, times out, ignores late results, and fails on disconnect', async (t) => {
  const { hub, port } = await setup(t, { cmdTimeoutMs: 100 });
  await assert.rejects(hub.runCommand('gtnh', 'list', 'test'), /GTNH is offline/);
  const mod = await online(port);
  await assert.rejects(hub.runCommand('gtnh', ' / ', 'test'), /empty command/);
  const timedOut = hub.runCommand('gtnh', 'list', 'test');
  const cmd = (await mod.next()) as { id: string };
  await assert.rejects(timedOut, /timed out — it may still run when the server responds/);
  mod.send({ type: 'cmdResult', id: cmd.id, output: ['late'] }); // must be ignored
  const dropped = hub.runCommand('gtnh', 'list', 'test');
  await mod.next();
  mod.socket.destroy();
  await assert.rejects(dropped, /disconnected/);
});

test('late command output reaches onLate until it expires, every batch of it', async (t) => {
  const { hub, port, events } = await setup(t, { lateMs: 150 });
  const mod = await online(port);
  const late: string[][] = [];
  const result = hub.runCommand('gtnh', 'spark profiler', 'test', (lines) => late.push(lines));
  const cmd = (await mod.next()) as { id: string };
  mod.send({ type: 'cmdResult', id: cmd.id, output: ['Profiler started'] });
  assert.deepEqual(await result, ['Profiler started']);
  mod.send({ type: 'cmdLate', id: cmd.id, output: ['https://spark.lucko.me/abc'] });
  mod.send({ type: 'cmdLate', id: 'unknown', output: ['ignored'] });
  mod.send({ type: 'cmdLate', id: cmd.id, output: ['a second batch'] }); // a Mod sends up to 10 for one command
  await until(() => late.length === 2);
  await sleep(250);
  mod.send({ type: 'cmdLate', id: cmd.id, output: ['too late'] });
  await sleep(50);
  assert.deepEqual(late, [['https://spark.lucko.me/abc'], ['a second batch']]);
  assert.equal(events.filter((e) => e.type === 'console' && e.late).length, 2);
});

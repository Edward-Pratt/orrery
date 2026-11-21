// `LIMITS` on both ports: every field and list at its limit parses and over it is refused, a reply's data by its size;
// a command's output and a backup's detail are cut instead.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS, parseAgentLine, parseModLine } from '../src/protocol.ts';
import { AGENT_MSGS } from './protocol-messages.ts';

const hello = { type: 'hello', protocol: 1, serverId: 'gtnh', token: 'test-token-0123456', modVersion: '2.6.0' };

/** Sets one field (by its path) of a copy of `msg`. */
function withField(msg: object, path: (string | number)[], value: unknown): string {
  const copy = structuredClone(msg) as Record<string | number, unknown>;
  let at = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  at[path.at(-1)!] = value;
  return JSON.stringify(copy);
}

test('every field has a limit, on both ports: at it parses, over it the message is invalid', () => {
  const x = (n: number) => 'x'.repeat(n);
  // A command's `output` and a `backup`'s `detail` are cut instead (the next test).
  const game: [object, (string | number)[], number][] = [
    [hello, ['serverId'], LIMITS.text],
    [hello, ['token'], LIMITS.text],
    [hello, ['modVersion'], LIMITS.text],
    [{ type: 'chat', player: 'a', message: 'b' }, ['player'], LIMITS.player],
    [{ type: 'chat', player: 'a', message: 'b' }, ['message'], LIMITS.message],
    [{ type: 'join', player: 'a' }, ['player'], LIMITS.player],
    [{ type: 'leave', player: 'a' }, ['player'], LIMITS.player],
    [{ type: 'death', player: 'a', message: 'b' }, ['message'], LIMITS.message],
    [{ type: 'achievement', player: 'a', achievement: 'b' }, ['achievement'], LIMITS.text],
    [{ type: 'heartbeat', tps: 20, players: ['a'] }, ['players', 0], LIMITS.player],
    [{ type: 'heartbeat', tps: 20, players: [], dims: [{ id: 0, name: 'a', ms: 1 }] }, ['dims', 0, 'name'], LIMITS.text],
    [{ type: 'cmdResult', id: '1', output: ['a'] }, ['id'], LIMITS.text],
    [{ type: 'quest', player: 'a', quests: [{ name: 'q', main: true }] }, ['quests', 0, 'name'], LIMITS.text],
    [{ type: 'link', player: 'a', uuid: '', code: 'ABC234' }, ['uuid'], LIMITS.text],
    [{ type: 'link', player: 'a', uuid: '', code: 'ABC234' }, ['code'], LIMITS.text],
    [{ type: 'unlink', player: 'a' }, ['player'], LIMITS.player],
    [{ type: 'milestone', kind: 'research', text: 't', player: 'p', force: 'f' }, ['text'], LIMITS.message],
    [{ type: 'milestone', kind: 'research', text: 't', player: 'p', force: 'f' }, ['player'], LIMITS.player],
    [{ type: 'milestone', kind: 'research', text: 't', player: 'p', force: 'f' }, ['force'], LIMITS.player],
  ];
  const agent: [object, (string | number)[], number][] = [
    [AGENT_MSGS.agentHello, ['agentId'], LIMITS.text],
    [AGENT_MSGS.agentHello, ['token'], LIMITS.text],
    [AGENT_MSGS.agentHello, ['agentVersion'], LIMITS.text],
    [AGENT_MSGS.hello, ['token'], LIMITS.text],
    [AGENT_MSGS.hostSample, ['sample', 'disks', 0, 'mount'], LIMITS.text],
    ...(['unit', 'active', 'sub', 'result'] as const).map((f) => [AGENT_MSGS.serviceState, [f], LIMITS.text] as [object, string[], number]),
    [AGENT_MSGS.saves, ['saves', 0, 'name'], LIMITS.text],
    [AGENT_MSGS.installed, ['factorio'], LIMITS.text],
    [AGENT_MSGS.installed, ['mods', 0, 'name'], LIMITS.text],
    [AGENT_MSGS.installed, ['mods', 0, 'version'], LIMITS.text],
    [AGENT_MSGS.updateStep, ['id'], LIMITS.text],
    [AGENT_MSGS.updateStep, ['detail'], LIMITS.detail],
    ...(['id', 'from', 'to', 'backup'] as const).map((f) => [AGENT_MSGS.updateDone, [f], LIMITS.text] as [object, string[], number]),
    [AGENT_MSGS.deployResult, ['tag'], LIMITS.text],
    [AGENT_MSGS.deployResult, ['log'], LIMITS.deployLog],
    [AGENT_MSGS.events, ['reason'], LIMITS.detail],
    [AGENT_MSGS.reply, ['id'], LIMITS.text],
    [{ type: 'reply', id: '1', ok: false, error: 'e' }, ['error'], LIMITS.detail],
    [AGENT_MSGS.settings, ['settings', 'name'], LIMITS.serverName],
    [AGENT_MSGS.settings, ['settings', 'description'], LIMITS.text],
    [AGENT_MSGS.settings, ['admins', 0], 60],
    [AGENT_MSGS.settings, ['problem'], LIMITS.detail],
    [AGENT_MSGS.settings, ['rolledBack'], LIMITS.detail],
    [AGENT_MSGS.settings, ['pending', 0], 64],
    [AGENT_MSGS.settings, ['extra', 0], 64],
  ];
  for (const [parse, cases] of [[parseModLine, game], [parseAgentLine, agent]] as const) {
    for (const [msg, path, max] of cases) {
      const what = `${(msg as { type: string }).type}.${path.join('.')}`;
      // A settings key is lower case and `_` only.
      const fill = (n: number) => ((msg as { type: string }).type === 'settings' && ['pending', 'extra'].includes(String(path[0])) ? '_' : 'x').repeat(n);
      assert.ok(parse(withField(msg, path, fill(max))), `${what} at ${max}`);
      assert.equal(parse(withField(msg, path, fill(max + 1))), null, `${what} over ${max}`);
    }
  }
  // Lists, by their entries.
  const lists: [typeof parseModLine | typeof parseAgentLine, object, (string | number)[], unknown, number][] = [
    [parseModLine, { type: 'heartbeat', tps: 20, players: [] }, ['players'], 'p', LIMITS.players],
    [parseModLine, { type: 'heartbeat', tps: 20, players: [] }, ['dims'], { id: 0, name: 'd', ms: 1 }, 5],
    [parseModLine, { type: 'quest', player: 'a', quests: [] }, ['quests'], { name: 'q', main: false }, 50],
    [parseAgentLine, AGENT_MSGS.hostSample, ['sample', 'load'], 1, 3],
    [parseAgentLine, AGENT_MSGS.hostSample, ['sample', 'disks'], { mount: '/', free: 1, total: 2 }, LIMITS.disks],
    [parseAgentLine, AGENT_MSGS.saves, ['saves'], AGENT_MSGS.saves.saves[0], LIMITS.saves],
    [parseAgentLine, AGENT_MSGS.installed, ['mods'], { name: 'm', version: '1.0.0' }, LIMITS.mods],
    [parseAgentLine, AGENT_MSGS.settings, ['admins'], 'alice', LIMITS.admins],
    [parseAgentLine, AGENT_MSGS.settings, ['pending'], 'auto_pause', LIMITS.pending],
    [parseAgentLine, AGENT_MSGS.settings, ['extra'], 'tags', LIMITS.extra],
  ];
  for (const [parse, msg, path, item, max] of lists) {
    const what = `${(msg as { type: string }).type}.${path.join('.')}`;
    assert.ok(parse(withField(msg, path, Array(max).fill(item))), `${what} at ${max}`);
    assert.equal(parse(withField(msg, path, Array(max + 1).fill(item))), null, `${what} over ${max}`);
  }
  // A reply's data, by its size as JSON.
  const data = (n: number) => JSON.stringify({ type: 'reply', id: '1', ok: true, data: x(n - 2) }); // the quotes count
  assert.ok(parseAgentLine(data(LIMITS.replyData)));
  assert.equal(parseAgentLine(data(LIMITS.replyData + 1)), null);
});

test("a command's output and a backup's detail are cut to their limits, not refused: Mods already deployed send more", () => {
  const long = 'y'.repeat(5000);
  const lines = Array.from({ length: 2000 }, (_, i) => (i === 3 ? long : `line ${i}`));
  // A game connection's lines, a Mod's or an Agent's, all go through parseModLine.
  for (const type of ['cmdResult', 'cmdLate']) {
    const msg = parseModLine(JSON.stringify({ type, id: '1', output: lines })) as { output: string[] } | null;
    assert.ok(msg, type);
    assert.equal(msg.output.length, LIMITS.output);
    assert.equal(msg.output[3], long.slice(0, LIMITS.line));
    assert.equal(msg.output[LIMITS.output - 1], `line ${LIMITS.output - 1}`);
  }
  assert.deepEqual(parseModLine(JSON.stringify({ type: 'backup', ok: false, detail: 'z'.repeat(3000) })), {
    type: 'backup',
    ok: false,
    detail: 'z'.repeat(LIMITS.detail),
  });
  // Still typed: a non-string line, or a detail that isn't a string, refuses the message.
  assert.equal(parseModLine(JSON.stringify({ type: 'cmdResult', id: '1', output: ['a', 1] })), null);
  assert.equal(parseModLine(JSON.stringify({ type: 'backup', ok: true, detail: 1 })), null);
});

// Node on an Agent's Host: `agentHello.node` through `parseAgentLine` (kept, left out, or the hello refused); kept per
// Agent and carried by `/api/hosts` (a whole hub); `NodeCheck` against a fake nodejs.org index (behind: one notice per
// newest; current: none; malformed, over its cap or failing: none, logged once, the last answer kept); its Discord post.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { APIEmbed } from 'discord.js';
import type { HostNow } from '../../src/api.ts';
import type { AgentStatus } from '../../src/agents/agents.ts';
import { INDEX_BYTES, NODE_INDEX, NodeCheck, type NodeFetch } from '../../src/agents/node-check.ts';
import { formatTargetEvent, NODE_STEPS } from '../../src/discord/format-target.ts';
import { COLORS } from '../../src/discord/format.ts';
import { parseAgentLine } from '../../src/protocol.ts';
import type { TargetEvent } from '../../src/servers/servers.ts';
import { AGENT_TOKEN, eventually, gameHub } from '../fake-agent.ts';
import { fakeMod } from '../fake-mod.ts';

const HELLO = { type: 'agentHello', protocol: 1, agentId: 'vm', token: AGENT_TOKEN, agentVersion: 'agent-v1.5.0' };

test("an agentHello's node is a release's process.version, at most 32 characters, or the hello is refused; an older Agent sends none", () => {
  assert.deepEqual(parseAgentLine(JSON.stringify(HELLO)), HELLO, 'without node: no node key');
  assert.deepEqual(parseAgentLine(JSON.stringify({ ...HELLO, node: 'v24.22.2' })), { ...HELLO, node: 'v24.22.2' });
  const longest = `v1.2.${'3'.repeat(27)}`; // 32 characters
  assert.deepEqual(parseAgentLine(JSON.stringify({ ...HELLO, node: longest })), { ...HELLO, node: longest });
  for (const node of [`${longest}3`, 'v24.22.2-nightly20261101', '24.22.2', 'v24.22', ' v24.22.2', 'v24.22.2\n', '', 24, null]) {
    assert.equal(parseAgentLine(JSON.stringify({ ...HELLO, node })), null, JSON.stringify(node));
  }
});

test("the Agent's Host carries the Node its latest hello named in /api/hosts: null before one and after a hello without one", async (t) => {
  const h = await gameHub(t);
  const hosts = () => h.json<HostNow[]>(h.req('GET', '/api/hosts'));
  assert.deepEqual(await hosts(), [{ id: 'vm', sample: null, node: null }], 'before any hello');
  const hello = async (extra: object) => {
    const agent = fakeMod(h.agentPort);
    agent.send({ ...HELLO, ...extra });
    assert.deepEqual(await agent.next(), { type: 'welcome' });
    return agent;
  };
  const first = await hello({ node: 'v24.22.2' });
  assert.deepEqual(await hosts(), [{ id: 'vm', sample: null, node: 'v24.22.2' }]);
  await hello({}); // an older Agent: replaces the first, naming no Node
  await first.closed;
  await eventually(async () => (await hosts())[0]!.node === null);
});

/** A fake nodejs.org: answers the index URL with `body` (JSON unless a string), or as `answer` says. */
function nodejs(t: TestContext, body: unknown, answer: (url: string) => Promise<Response | undefined> | undefined = () => undefined) {
  const asked: string[] = [];
  const fetch: NodeFetch = async (url, init) => {
    asked.push(url);
    assert.equal(init.redirect, 'manual');
    return (await answer(url)) ?? new Response(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const errors = t.mock.method(console, 'error', () => {});
  return { fetch, asked, errors };
}

const agent = (node: string | null, id = 'vm'): AgentStatus => ({ id, name: 'Factorio VM', server: 'space', connected: true, version: 'agent-v1.5.0', node });
const INDEX = [
  { version: 'v26.1.0', date: '2026-11-01', lts: false, security: false, files: ['linux-arm64'] },
  { version: 'v24.23.1', lts: 'Krypton', security: true },
  { version: 'v24.22.2', lts: 'Krypton' },
  { version: 'v24.23.0', lts: 'Krypton' }, // out of order: versions compare as numbers
  { version: 'v24.99.0-rc.1' }, // not a release
  { version: 24 },
  null,
  'v24.100.0',
];

function check(fetch: NodeFetch, agents: AgentStatus[]) {
  const notices: TargetEvent[] = [];
  const c = new NodeCheck({ agents: { list: () => agents }, hub: { publishTarget: (e) => notices.push(e) }, fetch });
  return { c, notices, agents };
}

test("an Agent's Node behind the newest of its major raises one nodeUpdate host notice, once per newest", async (t) => {
  const { fetch, asked, errors } = nodejs(t, INDEX);
  const { c, notices, agents } = check(fetch, [agent('v24.22.2'), agent(null, 'old')]);
  await c.run();
  assert.deepEqual(asked, [NODE_INDEX]);
  assert.deepEqual(notices, [{ target: 'host', id: 'vm', type: 'notice', severity: 'info', kind: 'nodeUpdate', name: 'Factorio VM', node: 'v24.22.2', newest: 'v24.23.1' }]);
  await c.run();
  assert.equal(notices.length, 1, 'the same newest is not told again');
  agents[0] = agent('v24.23.1'); // updated: current, forgotten
  await c.run();
  agents[0] = agent('v24.22.2');
  await c.run();
  assert.equal(notices.length, 2, 'behind again after being current: told again');
  assert.equal(errors.mock.callCount(), 0);
});

test("an Agent on the newest of its major, ahead of the index or on a major it doesn't list raises nothing", async (t) => {
  const { fetch } = nodejs(t, INDEX);
  const { c, notices } = check(fetch, [agent('v24.23.1'), agent('v26.2.0', 'ahead'), agent('v22.1.0', 'gone')]);
  await c.run();
  assert.deepEqual(notices, []);
});

test('a malformed, oversized or failing index raises nothing and is logged once until a read succeeds; the last answer is kept', async (t) => {
  for (const bad of ['not json', '{"version":"v24.23.1"}', [{ version: 'v24.23.1-rc.1' }], Array.from({ length: 10_001 }, () => ({ version: 'v24.23.1' }))]) {
    const { fetch, errors } = nodejs(t, bad);
    const { c, notices } = check(fetch, [agent('v24.22.2')]);
    await c.run();
    await c.run();
    assert.deepEqual(notices, [], JSON.stringify(bad).slice(0, 40));
    assert.equal(errors.mock.callCount(), 1, 'logged once');
    assert.match(String(errors.mock.calls[0]!.arguments[0]), /^\[node-check\] nodejs\.org's release index can't be read: .+; keeping the last answer$/);
    errors.mock.restore();
  }

  let failing = false;
  const big = JSON.stringify([...INDEX, { version: 'v1.0.0', pad: 'x'.repeat(INDEX_BYTES) }]);
  const { fetch, errors } = nodejs(t, INDEX, async () => (failing ? new Response(big) : undefined));
  const { c, notices, agents } = check(fetch, [agent('v24.23.1')]);
  await c.run(); // a good answer: current
  failing = true;
  agents[0] = agent('v24.22.2');
  await c.run(); // over the cap: the last answer still checks the Agent, now behind
  assert.deepEqual(notices.map((n) => 'newest' in n && n.newest), ['v24.23.1']);
  assert.match(String(errors.mock.calls[0]!.arguments[0]), /over 4194304 bytes/);
  for (const status of [301, 404, 500]) {
    const r = nodejs(t, INDEX, async () => new Response(null, { status, headers: status === 301 ? { location: 'https://evil.example/' } : {} }));
    const fails = check(r.fetch, [agent('v24.22.2')]);
    await fails.c.run();
    assert.deepEqual(fails.notices, [], `HTTP ${status}`);
    assert.match(String(r.errors.mock.calls[0]!.arguments[0]), new RegExp(`HTTP ${status}`));
    r.errors.mock.restore();
  }
});

test("a nodeUpdate notice reaches Discord naming the Host, its Node and the newest, with what to do", () => {
  const post = formatTargetEvent({ target: 'host', id: 'vm', type: 'notice', severity: 'info', kind: 'nodeUpdate', name: 'Factorio VM', node: 'v24.22.2', newest: 'v24.23.1' });
  assert.deepEqual(post, { embeds: [{ title: '⬆️ Host vm: Node v24.22.2 on agent Factorio VM is behind v24.23.1', description: NODE_STEPS, color: COLORS.blue }] satisfies APIEmbed[] });
  assert.match(NODE_STEPS, /NODE_VERSION.*NODE_SHA256.*setup-agent-host\.sh.*Agent patch.*re-run setup/);
});

// Node on an Agent's Host: `agentHello.node` through `parseAgentLine` (kept, left out, or the hello refused).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAgentLine } from '../../src/protocol.ts';

const HELLO = { type: 'agentHello', protocol: 1, agentId: 'vm', token: 'agent-token-0123456789abcdef-0123456789', agentVersion: 'agent-v1.5.0' };

test("an agentHello's node is a release's process.version, at most 32 characters, or the hello is refused; an older Agent sends none", () => {
  assert.deepEqual(parseAgentLine(JSON.stringify(HELLO)), HELLO, 'without node: no node key');
  assert.deepEqual(parseAgentLine(JSON.stringify({ ...HELLO, node: 'v24.22.2' })), { ...HELLO, node: 'v24.22.2' });
  const longest = `v1.2.${'3'.repeat(27)}`; // 32 characters
  assert.deepEqual(parseAgentLine(JSON.stringify({ ...HELLO, node: longest })), { ...HELLO, node: longest });
  for (const node of [`${longest}3`, 'v24.22.2-nightly20261101', '24.22.2', 'v24.22', ' v24.22.2', 'v24.22.2\n', '', 24, null]) {
    assert.equal(parseAgentLine(JSON.stringify({ ...HELLO, node })), null, JSON.stringify(node));
  }
});

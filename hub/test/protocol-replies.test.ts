// A reply's data: checked against its request and copied (`parseReplyData`), and refused, not thrown, when too deeply
// nested to serialise.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS, parseAgentLine, parseReplyData } from '../src/protocol.ts';

test("a reply's data is checked against its request, and copied", () => {
  assert.deepEqual(parseReplyData('journal', { lines: ['a', 'b'] }), { lines: ['a', 'b'] });
  assert.deepEqual(parseReplyData('log', { lines: ['a'], path: '/etc/shadow' }), { lines: ['a'] });
  const file = { name: 'factorio-current.log', size: 10, modified: 1700000000000 };
  assert.deepEqual(parseReplyData('logs', { files: [{ ...file, path: '/x' }] }), { files: [file] });
  for (const request of ['journal', 'log'] as const) {
    assert.ok(parseReplyData(request, { lines: Array(LIMITS.logLines).fill('x'.repeat(LIMITS.line)) }), request);
    assert.equal(parseReplyData(request, { lines: Array(LIMITS.logLines + 1).fill('x') }), null, request);
    assert.equal(parseReplyData(request, { lines: ['x'.repeat(LIMITS.line + 1)] }), null, request);
    assert.equal(parseReplyData(request, { lines: [1] }), null, request);
    assert.equal(parseReplyData(request, undefined), null, request);
  }
  assert.equal(parseReplyData('logs', { files: Array(LIMITS.logFiles + 1).fill(file) }), null);
  assert.equal(parseReplyData('logs', { files: [{ ...file, size: '10' }] }), null);
  assert.equal(parseReplyData('logs', ['factorio-current.log']), null);

  assert.deepEqual(parseReplyData('settingsSet', { applied: ['name', 'max_players'], pending: ['auto_pause'], password: 'x' }), {
    applied: ['name', 'max_players'],
    pending: ['auto_pause'],
  });
  assert.ok(parseReplyData('settingsSet', { applied: Array(LIMITS.pending).fill('name'), pending: Array(LIMITS.pending).fill('auto_pause') }));
  for (const bad of [
    { applied: Array(LIMITS.pending + 1).fill('name'), pending: [] },
    { applied: [], pending: Array(LIMITS.pending + 1).fill('auto_pause') },
    { applied: ['max-players'], pending: [] },
    { applied: [] },
    { applied: [1], pending: [] },
  ]) {
    assert.equal(parseReplyData('settingsSet', bad), null, JSON.stringify(bad).slice(0, 80));
  }
});

test("a reply's data too deeply nested to serialise is refused, not thrown", (t) => {
  t.mock.method(JSON, 'stringify', () => {
    throw new RangeError('Maximum call stack size exceeded'); // what an older V8 does on deep nesting
  });
  assert.equal(parseAgentLine('{"type":"reply","id":"x","ok":true,"data":[[[1]]]}'), null);
});

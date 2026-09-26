import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPinger } from '../src/health.ts';

const flush = () => new Promise((r) => setImmediate(r));

test('pings every interval and survives failures', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls: string[] = [];
  let result: Promise<{ ok: boolean; status: number }> = Promise.resolve({ ok: true, status: 200 });
  const stop = startPinger('https://hc/x', 60_000, async (url) => {
    calls.push(url);
    return result;
  });
  assert.deepEqual(calls, []);
  t.mock.timers.tick(60_000);
  assert.deepEqual(calls, ['https://hc/x']);
  result = Promise.reject(new Error('network down'));
  result.catch(() => {});
  t.mock.timers.tick(60_000);
  result = Promise.resolve({ ok: false, status: 404 });
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(calls.length, 3);
  stop();
  t.mock.timers.tick(60_000);
  assert.equal(calls.length, 3);
});

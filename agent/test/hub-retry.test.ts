// `HubClient` against the fake hub, the reconnect waits: reconnect with backoff (and its reset); a reject retried with
// backoff and logged once; a `reconnecting too fast` refusal retried once the hub's gap passed, not logged as a
// rejection (`HUB_WELCOME_GAP_MS` checked against the hub's `HANDSHAKE_MS`). The setup is `hub-setup.ts`.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HANDSHAKE_MS } from '../../hub/src/agents/agents.ts';
import { HUB_WELCOME_GAP_MS, backoff, tooFastWait } from '../src/hub.ts';
import { eventually } from './fake-hub.ts';
import { setup } from './hub-setup.ts';

test('backoff doubles from the base up to the cap, jittered into its upper half', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 60].map((n) => backoff(n, 100, 1000, () => 1)), [100, 200, 400, 800, 1000, 1000, 1000]);
  assert.equal(backoff(2, 100, 1000, () => 0), 200);
  assert.equal(backoff(2, 100, 1000, () => 0.5), 300);
});

test('reconnects with capped exponential backoff while the hub resets every connection', async (t) => {
  let n = 0;
  const { hub, client } = await setup(t, () => (++n <= 4 ? 'destroy' : 'welcome'), { backoffMs: 40, maxBackoffMs: 160 });
  client.start();
  await eventually(() => hub.conns[4], 3000, 'a 5th connection');
  await eventually(() => client.connected);
  const at = hub.conns.map((c) => c.at);
  const gaps = at.slice(1).map((a, i) => a - at[i]!);
  // Lower bounds only (a timer is never early, a busy machine makes it late): they show the doubling, since a flat
  // retry would wait 40 ms each time. The cap is `backoff`'s own test above: an upper bound here would race the machine.
  for (const [i, want] of [40, 80, 160, 160].entries()) assert.ok(gaps[i]! >= want - 5, `wait ${i} was ${gaps[i]} ms, want ${want}`);
  assert.equal(hub.of('agentHello').length, 5, 'every attempt opens with agentHello');
});

test('after a welcomed connection drops, the first retry waits only the base', async (t) => {
  const { hub, client } = await setup(t, () => 'welcome', { backoffMs: 40, maxBackoffMs: 1000 });
  client.start();
  const first = await eventually(() => hub.conns[0]);
  await eventually(() => client.connected);
  const dropped = performance.now();
  first.socket.destroy();
  const second = await eventually(() => hub.conns[1], 2000);
  assert.ok(second.at - dropped >= 35 && second.at - dropped < 1000, `retried after ${second.at - dropped} ms, not a capped wait`);
});

test('a reject is retried with backoff and logged once', async (t) => {
  const { hub, client } = await setup(t, () => ({ reject: 'bad token' }), { backoffMs: 10, maxBackoffMs: 20 });
  const logged: string[] = [];
  t.mock.method(console, 'log', (line: string) => logged.push(line));
  client.start();
  await eventually(() => hub.conns.length >= 4, 2000);
  assert.equal(client.connected, false);
  assert.equal(logged.filter((l) => l.includes('rejected: bad token')).length, 1, logged.join('\n'));
});

test("the hub's welcome gap is its HANDSHAKE_MS; a too-fast retry waits what is left of it, and a twentieth more", () => {
  assert.equal(HUB_WELCOME_GAP_MS, HANDSHAKE_MS);
  assert.equal(tooFastWait(1000, 5000), 4250);
  assert.equal(tooFastWait(9000, 5000), 250);
  assert.equal(tooFastWait(null, 5000), 5250);
});

test('a hello refused as reconnecting too fast is no failure: logged once per refusal, not as a rejection, and retried once the gap has passed', async (t) => {
  const GAP = 300;
  const welcomes: number[] = [];
  let refused = 0;
  const { hub, client } = await setup(
    t,
    () => {
      // The first hello is refused before any welcome (an agent that just restarted: it waits the whole gap), then
      // every one under GAP after the last welcome, as the hub does.
      const last = welcomes.at(-1);
      if (refused === 0 || (last !== undefined && performance.now() - last < GAP)) {
        refused++;
        return { reject: 'reconnecting too fast' };
      }
      welcomes.push(performance.now());
      return 'welcome';
    },
    { backoffMs: 10, maxBackoffMs: 10, welcomeGapMs: GAP },
  );
  const logged: string[] = [];
  t.mock.method(console, 'log', (line: string) => logged.push(line));
  client.start();
  await eventually(() => client.connected, 3000, 'a welcome after the first refusal');
  assert.ok(hub.conns[1]!.at - hub.conns[0]!.at >= GAP, `the first retry came ${hub.conns[1]!.at - hub.conns[0]!.at} ms after the refusal`);
  hub.conns[1]!.socket.destroy(); // a drop: the next hello, after the 10 ms backoff, is too soon after this welcome
  await eventually(() => welcomes.length === 2 && client.connected, 3000, 'connected again');
  assert.equal(refused, 2);
  assert.equal(hub.conns.length, 4, 'one retry per refusal, no hello in between');
  assert.ok(hub.conns[3]!.at - welcomes[0]! >= GAP, `retried ${hub.conns[3]!.at - welcomes[0]!} ms after the welcome`);
  assert.deepEqual(logged.filter((l) => l.includes('(rejected: ')), [], 'not a rejection, which the first-boot check stops at');
  assert.equal(logged.filter((l) => l.includes('welcomed this agent under')).length, 2, logged.join('\n')); // once per change of state
});

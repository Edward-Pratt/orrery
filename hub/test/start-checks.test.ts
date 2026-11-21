// The checks integration (`checksHub`, one check `site` with scripted answers): down and back up publish one notice
// each, a failed try whose retry answers stays up, timeouts and refused connections are down, and nothing is requested
// without checks; Discord posts a check's notices only in the alerts channel; each result is streamed, and a replay
// holds only a check's latest.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { CheckStatus, Integrations, LiveEvent, TargetEvent } from '../src/api.ts';
import { postTargets } from '../src/discord/discord.ts';
import type { Post } from '../src/discord/format.ts';
import { formatTargetEvent } from '../src/discord/format-target.ts';
import { startHub } from '../src/start.ts';
import { until } from './fake-mod.ts';
import { config, loginCookie, WEB } from './web/web-hub.ts';
import { MINECRAFT, DISCORD, unstamped, openStream, SITE, UP } from './start-hub.ts';

type Answer = { ok: boolean; status: number } | Error;
const failed = (a: Answer) => a instanceof Error || !a.ok;
const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
const refused = () => new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });

/**
 * A web hub with one check (no health ping); `answers` are the check's runs in order, the first at startup. A failure
 * answers its run's retry too; `[first, retry]` answers the two apart.
 */
async function checksHub(t: TestContext, runs: (Answer | [Answer, Answer])[]) {
  const tries = runs.map((r) => (Array.isArray(r) ? r : failed(r) ? [r, r] : [r]));
  const answers = tries.flat();
  /** Requests made once run `n` (1-based) is done. */
  const madeBy = (n: number) => tries.slice(0, n).reduce((sum, r) => sum + r.length, 0);
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cfg = config(t, { web: WEB, checks: [SITE] });
  delete cfg.healthcheckUrl;
  const requests: string[] = [];
  const handle = await startHub(cfg, {
    startFrontend: () => assert.fail('Discord is off'),
    get: async (url) => {
      requests.push(url);
      const answer = answers[requests.length - 1] ?? assert.fail('no more answers');
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  t.after(() => handle.close());
  const notices: TargetNotice[] = [];
  const add = (fed: LiveEvent) => {
    const e = unstamped(fed);
    if ('target' in e && e.type === 'notice') notices.push(e);
  };
  handle.live.since().forEach(([, e]) => add(e)); // from the startup request
  handle.live.on('event', (_, e) => add(e));
  const app = handle.web!.app;
  const cookie = await loginCookie(handle.web!);
  let runsDone = 1;
  /** Waits for the check's `n`th run to be answered. */
  const answered = async (n: number) => (await until(() => requests.length === madeBy(n)), await new Promise((r) => setImmediate(r)));
  const next = async () => {
    t.mock.timers.tick(60_000);
    await answered(++runsDone);
  };
  const checks = async () => (await app.request('/api/checks', { headers: { cookie } })).json() as Promise<CheckStatus[]>;
  await answered(1);
  return { requests, notices, next, checks, app, cookie };
}

type TargetNotice = Extract<TargetEvent, { type: 'notice' }>;
const kinds = (notices: TargetNotice[]) => notices.map((n) => [n.id, n.kind, n.kind === 'checkDown' ? n.error : null]);

test('a check that goes down publishes one notice, and one when it is back up', async (t) => {
  const { requests, notices, next, checks } = await checksHub(t, [UP, UP, { ok: false, status: 503 }, { ok: false, status: 500 }, refused(), { ok: true, status: 204 }, UP]);
  const [first] = await checks();
  assert.deepEqual({ ...first, ms: typeof first!.ms, checkedAt: typeof first!.checkedAt }, {
    id: 'site',
    url: 'https://site.example',
    up: true,
    ms: 'number',
    error: null,
    checkedAt: 'number',
    service: null,
  });
  await next();
  assert.equal(notices.length, 0); // up at startup and still up: nothing to say
  await next();
  assert.deepEqual(kinds(notices), [['site', 'checkDown', 'HTTP 503']]);
  assert.deepEqual(notices[0], { target: 'check', id: 'site', type: 'notice', severity: 'problem', kind: 'checkDown', url: SITE.url, error: 'HTTP 503' });
  assert.equal((await checks())[0]!.up, false);
  await next();
  await next();
  assert.equal(notices.length, 1); // still down, however it fails
  assert.equal((await checks())[0]!.error, 'ECONNREFUSED');
  await next();
  assert.deepEqual(kinds(notices), [['site', 'checkDown', 'HTTP 503'], ['site', 'checkUp', null]]);
  assert.equal(notices[1]!.severity, 'good');
  await next();
  assert.equal(notices.length, 2);
  assert.deepEqual((await checks()).map((c) => [c.up, c.error]), [[true, null]]);
  assert.deepEqual(new Set(requests), new Set([SITE.url]));
});

test('a check that fails once but answers its retry stays up, with nothing to say', async (t) => {
  const { requests, notices, next, checks } = await checksHub(t, [UP, [refused(), UP], [timeout(), { ok: false, status: 503 }]]);
  await next();
  assert.equal(notices.length, 0);
  assert.deepEqual((await checks()).map((c) => [c.up, c.error]), [[true, null]]);
  await next();
  assert.deepEqual(kinds(notices), [['site', 'checkDown', 'HTTP 503']]); // the retry's failure is the one told
  assert.equal(requests.length, 5);
});

test('a check that times out or cannot connect is down', async (t) => {
  const { notices, next } = await checksHub(t, [timeout(), UP, refused()]);
  await next();
  await next();
  assert.deepEqual(kinds(notices), [['site', 'checkDown', 'timed out'], ['site', 'checkUp', null], ['site', 'checkDown', 'ECONNREFUSED']]);
});

test('without checks nothing is requested and there is no checks API', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cfg = config(t, { web: WEB });
  delete cfg.healthcheckUrl;
  const handle = await startHub(cfg, {
    startFrontend: () => assert.fail('Discord is off'),
    get: () => assert.fail('nothing to request'),
  });
  t.after(() => handle.close());
  t.mock.timers.tick(60 * 60_000);
  const cookie = await loginCookie(handle.web!);
  assert.equal((await handle.web!.app.request('/api/checks', { headers: { cookie } })).status, 404);
  const on = (await (await handle.web!.app.request('/api/integrations', { headers: { cookie } })).json()) as Integrations;
  assert.equal(on.checks, false);
});

test("Discord posts a check's notices only in the alerts channel, and without one posts nothing", async (t) => {
  for (const alertsChannel of ['4'.repeat(18), undefined]) {
    const cfg = config(t, { minecraft: MINECRAFT, discord: { ...DISCORD, alertsChannel }, checks: [{ ...SITE, id: 'gtnh' }] });
    delete cfg.healthcheckUrl;
    const posted: [string, Post][] = [];
    const handle = await startHub(cfg, {
      startFrontend: async (hub, _s, _r, _l, discord) => {
        postTargets(hub, discord, async (channelId, message) => void posted.push([channelId, message]));
        return { stop: () => {} };
      },
      get: async () => ({ ok: false, status: 503 }),
    });
    await until(() => handle.live.since().some(([, e]) => 'target' in e && e.type === 'notice'));
    await handle.close();
    // Named like the server, still only in the alerts channel (the server's channel is 3…).
    assert.deepEqual(posted, alertsChannel ? [[alertsChannel, formatTargetEvent({ target: 'check', id: 'gtnh', type: 'notice', severity: 'problem', kind: 'checkDown', url: SITE.url, error: 'HTTP 503' })]] : []);
  }
});

test("each check result is streamed, and a replay holds only a check's latest", async (t) => {
  const { next, app, cookie } = await checksHub(t, [UP, { ok: false, status: 503 }, UP]);
  await next();
  await next();
  const replay = await openStream(app, cookie);
  t.after(() => replay.close());
  await until(() => replay.events.length === 3);
  const checked = replay.events.filter((e) => e.data.type === 'checked');
  assert.equal(checked.length, 1);
  assert.deepEqual((checked[0]!.data as { status: CheckStatus }).status.up, true);
  assert.deepEqual(
    replay.events.map((e) => ('kind' in e.data ? e.data.kind : e.data.type)),
    ['checkDown', 'checked', 'checkUp'], // a result, then what it changed
  );
});

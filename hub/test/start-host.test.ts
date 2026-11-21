// The host integration (`hostHub`, host `oracle` with fake readers): samples stored, served as the latest and in the
// history (averaged into at most `HISTORY_POINTS` buckets) and streamed; memory and disk warnings and recoveries;
// another Host (`vm`) by its own limits; nothing sampled without the integration.

import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { HostNow, HostSample, Integrations, TargetEvent } from '../src/api.ts';
import { Db } from '../src/stats/db.ts';
import { HISTORY_POINTS } from '../src/agents/host.ts';
import { startHub } from '../src/start.ts';
import { until } from './fake-mod.ts';
import { config, loginCookie, WEB } from './web/web-hub.ts';
import { unstamped, openStream, GB, VM, vmSample } from './start-hub.ts';

/**
 * A web hub measuring host `oracle` (mount `/`, memory warning at 90% for 2 minutes, disk at 10 GB) with fake readers;
 * `use` sets what they read next. `next` takes one sample.
 */
async function hostHub(t: TestContext) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cfg = config(t, {
    web: WEB,
    host: { id: 'oracle', mounts: ['/'], memoryMaxPercent: 90, memoryMinutes: 2, diskMinFreeGB: 10 },
  });
  delete cfg.healthcheckUrl;
  const now = { busy: 0, idle: 0, memUsed: 1 * GB, free: 50 * GB };
  const use = (next: Partial<typeof now>) => Object.assign(now, next);
  const handle = await startHub(cfg, {
    startFrontend: () => assert.fail('Discord is off'),
    get: () => assert.fail('nothing to request'),
    host: {
      cpu: () => ({ idle: now.idle, total: now.idle + now.busy }),
      load: () => [0.5, 0.25, 0.125],
      memory: async () => ({ total: 16 * GB, available: 16 * GB - now.memUsed }),
      disk: async (mount) => ({ free: mount === '/' ? now.free : assert.fail(mount), total: 100 * GB }),
    },
  });
  t.after(() => handle.close());
  const events: TargetEvent[] = [];
  handle.live.on('event', (_, fed) => {
    const e = unstamped(fed);
    if ('target' in e) events.push(e);
  });
  const samples = () => events.filter((e) => e.type === 'sample').length;
  const next = async () => {
    const n = samples() + 1;
    t.mock.timers.tick(60_000);
    await until(() => samples() === n);
  };
  const notices = () => events.flatMap((e) => (e.type === 'notice' ? [e.kind] : []));
  const app = handle.web!.app;
  const cookie = await loginCookie(handle.web!);
  const get = async <T>(path: string) => {
    const res = await app.request(path, { headers: { cookie } });
    assert.equal(res.status, 200, path);
    return res.json() as Promise<T>;
  };
  return { use, next, notices, events, get, app, cookie, dbPath: cfg.dbPath, hosts: handle.hosts };
}

test('a host sample is stored, served as the latest and in the history, and streamed', async (t) => {
  const { use, next, events, get } = await hostHub(t);
  assert.deepEqual(await get<HostNow>('/api/host'), { id: 'oracle', sample: null, node: null });
  use({ busy: 30, idle: 70, memUsed: 4 * GB });
  await next();
  const { sample } = await get<HostNow>('/api/host');
  assert.deepEqual({ ...sample!, ts: typeof sample!.ts }, {
    ts: 'number',
    cpu: 0.3,
    load: [0.5, 0.25, 0.125],
    memory: { used: 4 * GB, total: 16 * GB },
    disks: [{ mount: '/', free: 50 * GB, total: 100 * GB }],
  });
  assert.deepEqual(events, [{ target: 'host', id: 'oracle', type: 'sample', sample }]);
  use({ busy: 40, idle: 160 }); // 10 busy of 100 since the last sample
  await next();
  const history = await get<HostSample[]>('/api/host/samples?hours=1');
  assert.deepEqual(history.map((s) => s.cpu), [0.3, 0.1]);
  assert.deepEqual(await get<HostSample[]>('/api/host/samples'), history); // 24 hours by default
  assert.deepEqual((await get<Integrations>('/api/integrations')).host, true);
});

test('a long history period is averaged into at most HISTORY_POINTS buckets; short ones stay raw', async (t) => {
  const { get, dbPath } = await hostHub(t);
  // A week of minutes, busy and idle in turn, disk free 0 and 2 GB in turn.
  const db = new Db(dbPath);
  const now = Date.now();
  for (let k = 7 * 24 * 60 - 1; k >= 0; k--) {
    const on = k % 2;
    db.recordHostSample('oracle', {
      ts: now - k * 60_000 - 30_000,
      cpu: on,
      load: [on, 2 * on, 3 * on],
      memory: { used: on * GB, total: 16 * GB },
      disks: [{ mount: '/', free: 2 * on * GB, total: 100 * GB }],
    });
  }
  db.close();
  assert.equal((await get<HostSample[]>('/api/host/samples?hours=1')).length, 60);
  const day = await get<HostSample[]>('/api/host/samples?hours=24');
  assert.equal(day.length, 24 * 60);
  assert.deepEqual(new Set(day.map((s) => s.cpu)), new Set([0, 1]));

  const week = await get<HostSample[]>('/api/host/samples?hours=168');
  const width = Math.ceil((168 * 60) / HISTORY_POINTS); // minutes in a bucket: 7, so 3 or 4 of them busy
  assert.ok(week.length <= HISTORY_POINTS);
  assert.ok(Math.abs(week.length - (168 * 60) / width) <= 1, String(week.length)); // 1440, or one more split at the ends
  for (const b of week.slice(1, -1)) {
    const busy = Math.round(b.cpu * width);
    assert.ok(busy === 3 || busy === 4, String(b.cpu));
    const share = busy / width;
    assert.deepEqual(b.load.map((l) => +(l / share).toFixed(9)), [1, 2, 3]);
    assert.equal(+(b.memory.used / GB / share).toFixed(9), 1);
    assert.equal(b.memory.total, 16 * GB);
    assert.deepEqual(b.disks.map((d) => [d.mount, +(d.free / GB / share).toFixed(9), d.total]), [['/', 2, 100 * GB]]);
  }
  assert.ok(week.every((b, i) => i === 0 || b.ts > week[i - 1].ts));
});

test('a bad history period is refused', async (t) => {
  const { app, cookie } = await hostHub(t);
  for (const hours of ['0', '2161', 'x', '1.5']) {
    assert.equal((await app.request(`/api/host/samples?hours=${hours}`, { headers: { cookie } })).status, 400, hours);
  }
});

test('sustained high memory warns once and recovers once', async (t) => {
  const { use, next, notices } = await hostHub(t);
  use({ memUsed: 15 * GB }); // 94%
  await next();
  assert.deepEqual(notices(), []); // one minute is not sustained
  await next();
  await next();
  assert.deepEqual(notices(), ['memoryHigh']);
  use({ memUsed: 8 * GB });
  await next();
  await next();
  assert.deepEqual(notices(), ['memoryHigh', 'memoryOk']);
});

test('low disk on a mount warns once and recovers once', async (t) => {
  const { use, next, notices, events } = await hostHub(t);
  use({ free: 5 * GB });
  await next();
  await next();
  assert.deepEqual(notices(), ['diskLow']);
  assert.deepEqual(events.find((e) => e.type === 'notice'), {
    target: 'host',
    id: 'oracle',
    type: 'notice',
    severity: 'warning',
    kind: 'diskLow',
    mount: '/',
    free: 5 * GB,
    minFreeGB: 10,
  });
  use({ free: 20 * GB });
  await next();
  await next();
  assert.deepEqual(notices(), ['diskLow', 'diskOk']);
});

test("a stream's replay holds only the host's latest sample", async (t) => {
  const { use, next, app, cookie } = await hostHub(t);
  use({ free: 5 * GB });
  for (let i = 0; i < 3; i++) await next();
  const replay = await openStream(app, cookie);
  t.after(() => replay.close());
  await until(() => replay.events.length === 2);
  assert.deepEqual(replay.events.map((e) => ('kind' in e.data ? e.data.kind : e.data.type)), ['diskLow', 'sample']);
});

test("every host is listed, the hub's own first, and serves its own samples; /api/host stays the hub's own", async (t) => {
  const { use, next, get, app, cookie, hosts } = await hostHub(t);
  assert.deepEqual(await get<HostNow[]>('/api/hosts'), [{ id: 'oracle', sample: null, node: null }]);
  const vm = hosts.add(VM);
  assert.throws(() => hosts.add({ ...VM, id: 'oracle' }), /already known/);
  const reported = vmSample(4 * GB);
  vm.record(reported);
  use({ busy: 30, idle: 70 });
  await next();
  const own = (await get<HostNow>('/api/host')).sample!;
  assert.equal(own.cpu, 0.3);
  assert.deepEqual(await get<HostNow[]>('/api/hosts'), [{ id: 'oracle', sample: own, node: null }, { id: 'vm', sample: reported, node: null }]);
  assert.deepEqual(await get<HostSample[]>('/api/hosts/vm/samples?hours=1'), [reported]);
  assert.deepEqual(await get<HostSample[]>('/api/hosts/oracle/samples?hours=1'), [own]);
  assert.deepEqual(await get<HostSample[]>('/api/host/samples?hours=1'), [own]);
  assert.deepEqual(await get<HostSample[]>('/api/hosts/vm/samples'), [reported]); // 24 hours by default
  assert.equal((await app.request('/api/hosts/nope/samples', { headers: { cookie } })).status, 404);
  assert.equal((await app.request('/api/hosts/vm/samples?hours=0', { headers: { cookie } })).status, 400);
});

test("another host's samples warn and recover by its own limits, apart from the hub's own, and replay its latest", async (t) => {
  const { use, next, events, app, cookie, hosts } = await hostHub(t);
  const vm = hosts.add(VM);
  const notices = () => events.flatMap((e) => (e.type === 'notice' ? [`${e.id}:${e.kind}`] : []));
  use({ memUsed: 12 * GB }); // 75%: high for vm's limit, not for oracle's
  vm.record(vmSample(12 * GB, 5 * GB));
  await next();
  await next();
  assert.deepEqual(notices(), ['vm:memoryHigh', 'vm:diskLow']);
  vm.record(vmSample(4 * GB));
  assert.deepEqual(notices(), ['vm:memoryHigh', 'vm:diskLow', 'vm:memoryOk', 'vm:diskOk']);
  assert.deepEqual(
    events.filter((e) => e.type === 'sample').map((e) => e.id),
    ['vm', 'oracle', 'oracle', 'vm'],
  );

  const replay = await openStream(app, cookie);
  t.after(() => replay.close());
  await until(() => replay.events.filter((e) => e.data.type === 'sample').length === 2);
  assert.deepEqual(
    replay.events.flatMap((e) => (e.data.type === 'sample' && 'target' in e.data ? [e.data.id] : [])).sort(),
    ['oracle', 'vm'],
  );
});

test('without the host integration nothing is sampled and there is no host API', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const cfg = config(t, { web: WEB });
  const handle = await startHub(cfg, {
    startFrontend: () => assert.fail('Discord is off'),
    get: async () => ({ ok: true, status: 200 }),
    host: { cpu: () => assert.fail(), load: () => assert.fail(), memory: () => assert.fail(), disk: () => assert.fail() },
  });
  t.after(() => handle.close());
  t.mock.timers.tick(60 * 60_000);
  const cookie = await loginCookie(handle.web!);
  assert.equal((await handle.web!.app.request('/api/host', { headers: { cookie } })).status, 404);
  assert.equal((await handle.web!.app.request('/api/hosts', { headers: { cookie } })).status, 404);
});

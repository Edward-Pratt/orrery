import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { ModUpdatesState } from '../../src/api.ts';
import { Db } from '../../src/stats/db.ts';
import { FactorioCatalog, type PortalFetch } from '../../src/updates/factorio.ts';
import { formatEvent } from '../../src/discord/format.ts';
import type { GameUpdates } from '../../src/updates/game-updates.ts';
import { findUpdates, ModUpdates } from '../../src/updates/mod-updates.ts';
import type { ServerHub } from '../../src/servers/servers.ts';
import type { FactorioMod, Notice } from '../../src/types.ts';
import { ready, rel } from '../fake-agent.ts';

const GAME: FactorioMod[] = [
  { name: 'base', version: '2.1.24' },
  { name: 'space-age', version: '2.1.24' },
];
const listed = (name: string, version: string) => ({ name, title: `${name} title`, latest_release: { version, info_json: { factorio_version: '2.1' } } });

/** A portal with `list` as the 2.1 list and `pages` as each mod's releases; every URL asked is kept in `asked`. */
function fakePortal(list: object[], pages: Record<string, unknown[]>) {
  const asked: string[] = [];
  let down = false;
  const fetch: PortalFetch = async (url) => {
    asked.push(url);
    if (down) return new Response('', { status: 503 });
    if (url.startsWith('https://mods.factorio.com/api/mods?')) return Response.json({ pagination: null, results: list });
    const m = /^https:\/\/mods\.factorio\.com\/api\/mods\/([^/]+)\/full$/.exec(url);
    const name = m && decodeURIComponent(m[1]!);
    if (name && pages[name]) return Response.json({ name, title: `${name}\nTitle`, releases: pages[name] });
    return new Response('', { status: 404 });
  };
  return { fetch, asked, setDown: (d: boolean) => (down = d) };
}

test('findUpdates: an update, one needing a newer Factorio, a dev build, gone mods and names never asked', async () => {
  const p = fakePortal([listed('flib', '0.16.3'), listed('Krastorio2', '2.1.0'), listed('dev', '1.0.0'), listed('same', '1.0.0')], {
    flib: [rel('flib', '0.16.2'), rel('flib', '0.16.3')],
    Krastorio2: [rel('Krastorio2', '2.0.1'), rel('Krastorio2', '2.0.2'), rel('Krastorio2', '2.1.0', ['base >= 2.1.30'])],
    old: [{ ...rel('old', '1.0.0'), info_json: { factorio_version: '2.0', dependencies: [] } }],
  });
  const mods = [
    ...GAME,
    { name: 'flib', version: '0.16.2' },
    { name: 'Krastorio2', version: '2.0.2' },
    { name: 'dev', version: '1.0.1' },
    { name: 'same', version: '1.0.0' },
    { name: 'old', version: '1.0.0' },
    { name: 'gone-for-good', version: '1.0.0' },
    { name: '../x', version: '1.0.0' },
  ];
  const found = await findUpdates(new FactorioCatalog(p.fetch), { factorio: '2.1.24', mods });
  assert.deepEqual(found, {
    updates: [{ name: 'flib', title: 'flib Title', from: '0.16.2', to: '0.16.3' }],
    later: [{ name: 'Krastorio2', title: 'Krastorio2 Title', latest: '2.1.0' }],
    gone: ['gone-for-good', 'old'],
    unchecked: ['../x'],
  });
  assert.ok(!p.asked.some((u) => /\/(base|space-age|dev|same)\/full$|\.\.%2Fx|\.\.\/x/.test(u)), 'game mods, mods with no newer release and bad names are never read');
});

test('findUpdates: past 20 candidates the rest are unchecked; a second call within the caches reads nothing more', async () => {
  const names = Array.from({ length: 25 }, (_, i) => `m${String(i).padStart(2, '0')}`);
  const p = fakePortal(
    names.map((n) => listed(n, '1.0.1')),
    Object.fromEntries(names.map((n) => [n, [rel(n, '1.0.0'), rel(n, '1.0.1')]])),
  );
  const catalog = new FactorioCatalog(p.fetch);
  const installed = { factorio: '2.1.24', mods: [...GAME, ...names.map((name) => ({ name, version: '1.0.0' }))] };
  const found = await findUpdates(catalog, installed);
  assert.equal(found.updates.length, 20);
  assert.deepEqual(found.unchecked, names.slice(20));
  const reads = p.asked.length;
  assert.equal(reads, 21, 'one list read and 20 mod reads');
  await findUpdates(catalog, installed);
  assert.equal(p.asked.length, reads);
});

/** ModUpdates over fakes: a server `space` that runs `mods`, a mocked `Date`, and the notices it publishes. */
function setup(t: TestContext, mods: FactorioMod[], list: object[], pages: Record<string, unknown[]>) {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const p = fakePortal(list, pages);
  const db = new Db(':memory:');
  const notices: Notice[] = [];
  let installed: { factorio: string; mods: FactorioMod[] } | null = { factorio: '2.1.24', mods };
  let busy = false;
  const gameUpdates = { has: (id: string) => id === 'space', busy: () => busy, state: () => ({ installed }) } as unknown as GameUpdates;
  const hub = { publish: (_id: string, n: Notice) => notices.push(n) } as unknown as ServerHub;
  const make = () => new ModUpdates({ hub, db, catalog: new FactorioCatalog(p.fetch), gameUpdates, servers: ['gtnh', 'space'] });
  return {
    p,
    db,
    notices,
    make,
    tick: (ms: number) => t.mock.timers.tick(ms),
    run: (m: FactorioMod[] | null) => (installed = m && { factorio: '2.1.24', mods: m }),
    setBusy: (b: boolean) => (busy = b),
  };
}
const HOUR = 60 * 60_000;

test('the notice: the first check posts; the same set never again; a new one waits out the day', async (t) => {
  const pages = { flib: [rel('flib', '0.16.2'), rel('flib', '0.16.3')], helmod: [rel('helmod', '2.0.0'), rel('helmod', '2.0.1')] };
  const s = setup(t, [...GAME, { name: 'flib', version: '0.16.2' }], [listed('flib', '0.16.3'), listed('helmod', '2.0.1')], pages);
  const m = s.make();
  await m.checkAll();
  assert.deepEqual(s.notices, [{ severity: 'info', kind: 'modUpdates', factorio: '2.1.24', mods: [{ name: 'flib', from: '0.16.2', to: '0.16.3' }], count: 1 }]);
  s.tick(7 * HOUR);
  await m.checkAll();
  assert.equal(s.notices.length, 1, 'the same set');
  // A new mod with an update, within the day: waits.
  s.run([...GAME, { name: 'flib', version: '0.16.2' }, { name: 'helmod', version: '2.0.0' }]);
  await m.checkAll();
  assert.equal(s.notices.length, 1);
  s.tick(18 * HOUR);
  await m.checkAll();
  assert.equal(s.notices.length, 2);
  assert.equal((s.notices[1] as { count: number }).count, 2);
  // A restarted hub on the same database doesn't post it again.
  s.tick(25 * HOUR);
  await s.make().checkAll();
  assert.equal(s.notices.length, 2);
});

test('the notice: a set that shrank posts nothing; none clears it, so a later release posts again', async (t) => {
  const pages: Record<string, unknown[]> = { flib: [rel('flib', '0.16.2'), rel('flib', '0.16.3')], helmod: [rel('helmod', '2.0.0'), rel('helmod', '2.0.1')] };
  const list = [listed('flib', '0.16.3'), listed('helmod', '2.0.1')];
  const s = setup(t, [...GAME, { name: 'flib', version: '0.16.2' }, { name: 'helmod', version: '2.0.0' }], list, pages);
  const m = s.make();
  await m.checkAll();
  assert.equal(s.notices.length, 1);
  s.tick(30 * HOUR);
  s.run([...GAME, { name: 'flib', version: '0.16.3' }, { name: 'helmod', version: '2.0.0' }]);
  await m.checkAll();
  assert.equal(s.notices.length, 1, 'shrank');
  s.run([...GAME, { name: 'flib', version: '0.16.3' }, { name: 'helmod', version: '2.0.1' }]);
  await m.checkAll();
  assert.deepEqual(s.db.modUpdateNotice('space')?.mods, []);
  pages.flib!.push(rel('flib', '0.16.4'));
  list[0] = listed('flib', '0.16.4');
  s.tick(30 * HOUR);
  await m.checkAll();
  assert.equal(s.notices.length, 2);
});

test('state: kept until what the server runs changes or 15 minutes pass; a failed read keeps the last lists with the error', async (t) => {
  const s = setup(t, [...GAME, { name: 'flib', version: '0.16.2' }], [listed('flib', '0.16.3')], { flib: [rel('flib', '0.16.2'), rel('flib', '0.16.3')] });
  const m = s.make();
  const [a, b] = await Promise.all([m.state('space'), m.state('space')]);
  assert.equal(a, b, 'one computation at a time');
  assert.equal(a.updates.length, 1);
  const reads = s.p.asked.length;
  s.tick(10 * 60_000);
  await m.state('space');
  assert.equal(s.p.asked.length, reads);
  s.tick(30 * 60_000);
  s.p.setDown(true);
  const failed: ModUpdatesState = await m.state('space');
  assert.match(failed.error ?? '', /mod portal/i);
  assert.equal(failed.updates.length, 1, 'the last good lists');
  assert.equal(failed.checked, a.checked);
  s.run(null);
  assert.deepEqual(await m.state('space'), { factorio: null, checked: null, updates: [], later: [], gone: [], unchecked: [], error: null });
});

test('no check while a game update runs, and no notice from a failed read', async (t) => {
  const s = setup(t, [...GAME, { name: 'flib', version: '0.16.2' }], [listed('flib', '0.16.3')], { flib: [rel('flib', '0.16.2'), rel('flib', '0.16.3')] });
  const m = s.make();
  s.setBusy(true);
  await m.checkAll();
  assert.equal(s.p.asked.length, 0);
  s.setBusy(false);
  s.p.setDown(true);
  await m.checkAll();
  assert.equal(s.notices.length, 0);
});

test('a notice names at most 10 updates, then how many more, its names escaped', () => {
  const mods = Array.from({ length: 10 }, (_, i) => ({ name: i ? `mod_${i}` : 'a*b', from: '1.0.0', to: '1.0.1' }));
  const post = formatEvent({ type: 'notice', serverId: 'space', severity: 'info', kind: 'modUpdates', factorio: '2.1.24', mods, count: 14 }, 'factorio');
  const e = post && 'embeds' in post ? post.embeds[0]! : assert.fail('an embed');
  assert.equal(e.title, '🧩 Portal mod updates');
  assert.match(e.description!, /^14 portal mod updates fit Factorio 2\.1\.24: \*\*a\\\*b\*\* 1\.0\.0 → 1\.0\.1, \*\*mod\\_1\*\*/);
  assert.match(e.description!, / and 4 more\. Update them from the dashboard's Game tab\.$/);
  const one = formatEvent({ type: 'notice', serverId: 'space', severity: 'info', kind: 'modUpdates', factorio: '2.1.24', mods: mods.slice(1, 2), count: 1 }, 'factorio');
  assert.match((one as { embeds: { description: string }[] }).embeds[0]!.description, /^1 portal mod update fits Factorio 2\.1\.24: \*\*mod\\_1\*\* 1\.0\.0 → 1\.0\.1\. Update/);
});

test('GET …/game/updates: for a server an Agent runs, after its report; 404 otherwise', async (t) => {
  const h = await ready(t);
  const s = await h.json<ModUpdatesState>(h.req('GET', '/api/servers/space/game/updates'));
  assert.equal(s.factorio, '2.1.24');
  assert.ok(s.checked !== null && s.error === null);
  assert.deepEqual(s.updates, []);
  assert.equal((await h.req('GET', '/api/servers/gtnh/game/updates')).status, 404);
  assert.equal((await h.req('GET', '/api/servers/nope/game/updates')).status, 404);
});

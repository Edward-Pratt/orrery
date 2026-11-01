import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { StatusPoller, parseStatus, readAutoPause, reading, type Reading, type Status } from '../src/status.ts';
import { eventually } from './fake-hub.ts';
import { PASSWORD, fakeRcon } from './fake-rcon.ts';

/** A reply as the orrery mod's `/orrery-status` prints it (factorio/CLAUDE.md). */
const reply = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ ok: true, tick: 1000, tick_paused: false, players: ['alice'], version: '2.1.24', mods: { base: '2.1.24', 'space-age': '2.1.24', orrery: '0.1.0' }, loaded: true, ...o });
const status = (o: Partial<Status> = {}): Status => ({ tick: 1000, tickPaused: false, players: ['alice'], version: '2.1.24', mods: {}, modVersion: '0.1.0', ...o });

test('parseStatus reads the mod reply; players {} is nobody', () => {
  assert.deepEqual(parseStatus(reply()), {
    tick: 1000,
    tickPaused: false,
    players: ['alice'],
    version: '2.1.24',
    mods: { base: '2.1.24', 'space-age': '2.1.24', orrery: '0.1.0' },
    modVersion: '0.1.0',
  });
  assert.deepEqual(parseStatus(reply({ players: {} }))?.players, []);
  assert.equal(parseStatus(reply({ tick_paused: true }))?.tickPaused, true);
  assert.equal(parseStatus(reply({ tick_paused: 'yes' }))?.tickPaused, false, 'only true is true');
});

test('parseStatus treats RCON output as untrusted: anything off is no status; names that the wire refuses are dropped', () => {
  for (const bad of [
    'Unknown command "orrery-status".',
    '',
    '[]',
    reply({ ok: false }),
    reply({ tick: -1 }),
    reply({ tick: 1.5 }),
    reply({ tick: '7' }),
    reply({ version: '2.1' }),
    reply({ players: 'alice' }),
    reply({ players: { 1: 'alice' } }),
    reply({ mods: { base: '2.1.24' } }), // no orrery mod: no version for the hello
    reply({ mods: { orrery: '../../x' } }),
    reply({ mods: [] }),
  ]) {
    assert.equal(parseStatus(bad), null, bad);
  }
  const many = Array.from({ length: 250 }, (_, i) => `p${i}`);
  const s = parseStatus(reply({ players: ['ok', 7, '', 'x'.repeat(65), 'y'.repeat(64), ...many] }))!;
  assert.deepEqual(s.players.slice(0, 2), ['ok', 'y'.repeat(64)]);
  assert.deepEqual(parseStatus(reply({ players: ['ok', 'two\nlines', 'esc\u001b[2J', 'c1\u009b'] }))!.players, ['ok'], 'no name with a control character');
  assert.equal(s.players.length, 200);
  const odd = parseStatus('{"ok":true,"tick":1,"players":[],"version":"2.1.24","mods":{"__proto__":"1.0.0","orrery":"0.1.0","bad":7}}')!;
  assert.deepEqual(Object.keys(odd.mods), ['__proto__', 'orrery']);
  assert.equal(Object.getPrototypeOf(odd.mods), Object.prototype);
});

test('UPS is delta tick over delta wall time between two answers', () => {
  assert.equal(reading(status({ tick: 1300 }), 6000, false, { tick: 1000, at: 1000 }).ups, 60);
  assert.equal(reading(status({ tick: 1301 }), 6000, false, { tick: 1000, at: 1000 }).ups, 60.2);
  assert.equal(reading(status({ tick: 1150 }), 6000, false, { tick: 1000, at: 1000 }).ups, 30);
  assert.equal(reading(status(), 6000, false, null).ups, null, 'the first answer has nothing to compare with');
  assert.equal(reading(status({ tick: 10 }), 6000, false, { tick: 1000, at: 1000 }).ups, null, 'the tick went back: a new map');
  assert.equal(reading(status({ tick: 1300 }), 1000, false, { tick: 1000, at: 1000 }).ups, null, 'no time passed');
});

test('paused from the player count: nobody on with auto_pause, else not', () => {
  const prev = { tick: 1000, at: 1000 };
  const nobody = status({ tick: 1001, players: [] });
  assert.deepEqual(reading(nobody, 6000, true, prev), { ups: 0.2, players: [], paused: true, modVersion: '0.1.0' } satisfies Reading);
  assert.equal(reading(nobody, 6000, false, prev).paused, false, 'auto_pause off: nobody on is not paused');
  assert.equal(reading(status({ tick: 1300, players: ['alice'] }), 6000, true, prev).paused, false, 'someone on: running');
  assert.equal(reading(status({ players: [] }), 6000, true, null).paused, true, 'even on the first answer');
});

test('paused from tick_paused, and from a tick that moved at most 1 with players on', () => {
  const prev = { tick: 1000, at: 1000 };
  assert.equal(reading(status({ tick: 1300, tickPaused: true }), 6000, false, prev).paused, true);
  assert.equal(reading(status({ tickPaused: true }), 6000, false, null).paused, true);
  assert.equal(reading(status({ tick: 1001 }), 6000, false, prev).paused, true, 'one tick: only the RCON command ran');
  assert.equal(reading(status({ tick: 1000 }), 6000, false, prev).paused, true, 'no tick at all');
  assert.equal(reading(status({ tick: 1002 }), 6000, false, prev).paused, false);
  assert.equal(reading(status({ tick: 1000 }), 6000, false, null).paused, false, 'no previous answer: no delta to judge');
});

test('auto_pause is read as a plain boolean, and only from a small regular file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = (name: string, text: string) => writeFile(join(dir, name), text).then(() => join(dir, name));
  assert.equal(await readAutoPause(await file('on.json', JSON.stringify({ name: 'x', auto_pause: true }))), true);
  assert.equal(await readAutoPause(await file('off.json', JSON.stringify({ auto_pause: false }))), false);
  assert.equal(await readAutoPause(await file('string.json', JSON.stringify({ auto_pause: 'true' }))), false);
  assert.equal(await readAutoPause(await file('broken.json', '{"auto_pause": tru')), false);
  assert.equal(await readAutoPause(join(dir, 'missing.json')), false);
  await symlink(join(dir, 'on.json'), join(dir, 'link.json'));
  assert.equal(await readAutoPause(join(dir, 'link.json')), false, 'a symlink is not followed');
  await mkdir(join(dir, 'folder.json'));
  assert.equal(await readAutoPause(join(dir, 'folder.json')), false);
  execFileSync('mkfifo', [join(dir, 'fifo.json')]);
  assert.equal(await readAutoPause(join(dir, 'fifo.json')), false, 'a FIFO is not read (and does not block)');
  assert.equal(await readAutoPause(await file('huge.json', `{"auto_pause":true,"pad":"${'x'.repeat(1024 * 1024)}"}`)), false);
});

test('the poller emits a status after each RCON round trip, stalled once on no status, down once when RCON goes, and comes back', async (t) => {
  let tick = 0;
  let answering = true;
  const dir = await mkdtemp(join(tmpdir(), 'orrery-settings-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = join(dir, 'server-settings.json');
  await writeFile(settings, JSON.stringify({ auto_pause: true }));
  const handle = () => {
    tick += 1;
    return answering ? reply({ tick, players: {} }) : 'Unknown command';
  };
  let rcon = await fakeRcon(handle);
  t.after(() => rcon.close());
  const poller = new StatusPoller({ port: rcon.port, password: PASSWORD, settings, intervalMs: 20, timeoutMs: 500 });
  t.after(() => poller.stop());
  const seen: (Reading | string)[] = [];
  poller.on('status', (r) => seen.push(r));
  poller.on('stalled', (why) => seen.push(`stalled: ${why}`));
  poller.on('down', (why) => seen.push(`down: ${why}`));
  poller.start();
  await eventually(() => seen.length >= 3);
  const [first, second] = seen as Reading[];
  assert.deepEqual(first, { ups: null, players: [], paused: true, modVersion: '0.1.0' });
  assert.ok(typeof second!.ups === 'number' && second!.ups > 0 && second!.paused);
  assert.deepEqual(poller.players, []);
  assert.deepEqual(rcon.commands().slice(0, 3), ['/orrery-status', '/orrery-status', '/orrery-status']);

  answering = false;
  await eventually(() => seen.some((s) => typeof s === 'string'));
  const from = tick;
  await eventually(() => tick >= from + 10, 2000);
  const notes = () => seen.filter((s) => typeof s === 'string') as string[];
  assert.deepEqual(notes(), ['stalled: /orrery-status gave no status (is the orrery mod loaded?)'], 'once, not once per poll');

  await rcon.close();
  await eventually(() => notes().length === 2, 2000, 'down');
  assert.match(notes()[1]!, /^down: RCON connection (closed|failed)/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(notes().length, 2, 'down once while RCON stays gone');

  answering = true;
  rcon = await fakeRcon(handle, Infinity, rcon.port);
  await eventually(() => typeof seen.at(-1) === 'object', 2000, 'a status again');
  assert.equal((seen.at(-1) as Reading).ups, null, 'a fresh baseline on the new RCON connection');
});

test('a poll that times out is a stall, not RCON gone; the next one reconnects', async (t) => {
  let hang = false;
  const rcon = await fakeRcon(() => (hang ? undefined : reply({ tick: Date.now() })));
  t.after(() => rcon.close());
  const poller = new StatusPoller({ port: rcon.port, password: PASSWORD, settings: '/nonexistent', intervalMs: 20, timeoutMs: 50 });
  t.after(() => poller.stop());
  const stalls: string[] = [];
  let statuses = 0;
  let downs = 0;
  poller.on('status', () => statuses++);
  poller.on('stalled', (why) => stalls.push(why));
  poller.on('down', () => downs++);
  poller.start();
  await eventually(() => statuses >= 2);
  hang = true;
  await eventually(() => stalls.length === 1, 2000);
  assert.match(stalls[0]!, /timed out/);
  await new Promise((r) => setTimeout(r, 150)); // reconnects to a server that takes the connection but never answers
  assert.equal(downs, 0);
  assert.equal(stalls.length, 1);
  hang = false;
  const before = statuses;
  await eventually(() => statuses > before, 2000, 'answers again on a new connection');
});

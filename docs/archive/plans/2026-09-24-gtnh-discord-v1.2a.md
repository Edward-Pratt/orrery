# GTNH Discord v1.2a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** embeds for everything except chat; playtime and last-seen stats with `/playtime`, `/top`, daily peaks and a daily summary; `/backup start|status|list` with count, total size, a finish notice and a missing-backup watchdog; `/cmd` capturing asynchronous replies (spark); and the deferred v1/v1.1 minors.

**Architecture:** New hub-core modules for the dashboard to reuse later:
- `daily.ts` (shared DST-safe daily timer)
- `units.ts`
- `playtime.ts`
- `summary.ts`
- `backups.ts`

`db.ts` gains sessions and peaks. The Discord frontend turns hub-core plain-text notices into embeds. The mod collects `/cmd` replies until they go quiet. No protocol change.

**Tech Stack:** Node 24+ (runs `.ts` directly), TypeScript 7 (typecheck only), discord.js 14, `node:sqlite`, `node:test` with mock timers; Forge 1.7.10 mod (JDK 25 build, Java 8 bytecode, JUnit 5).

**Spec:** `docs/superpowers/specs/2026-09-24-gtnh-discord-v1.2a-design.md` (the v1 and v1.1 specs still apply)

## Global Constraints

- Hub work runs in `hub/` (npm) and mod work in `mod/` (Gradle). The protocol stays v1.
- Hub runs with `node src/index.ts` (Node type stripping). Use erasable TypeScript only: no `enum`, `namespace` or parameter properties. Relative imports end in `.ts`.
- Hub dependencies stay exactly `discord.js` (runtime), plus `typescript` and `@types/node` (dev).
- Hub-core modules (`servers`, `db`, `restarts`, `daily`, `units`, `playtime`, `summary`, `backups`, `crashlogs`) must not import `discord.js` or `format.ts`. They send plain-text notices; `discord.ts` makes the embeds.
- Local calendar days come from local date parts, never `toISOString()`. Daily work uses `everyDay`, which passes the scheduled target to its callback.
- Every Discord call and filesystem scan is best-effort and logged. Database writes never throw.
- Mod code must run on Java 8: no Java 9+ APIs, and use the Gson 2.2.4 API. Always run `./gradlew spotlessApply` before `build`. Building needs a full JDK 25.
- The hub must pass on Node 24 (production is 24.19 on ARM64) and on 26.
- Every commit message ends with these trailer lines:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_019KzyhKnrr3Gj8zCrcVtthm
  ```

## Review Focus

These are real-world conditions the unit tests can't reach. They're pinned by the Task 6 manual checklist:

1. **The GTNH spark port may not reply asynchronously like upstream spark.** Check: `/cmd spark tps` shows spark's output. If it doesn't, the mod's quiet-window capture is sound but the diagnosis was wrong.
2. **Upgrading the existing v1.1 `hub.db` in place.** The new tables are created (`IF NOT EXISTS`), old uptime history is kept, and the first `/playtime` works.
3. **A real ServerUtilities backup takes minutes and lands in the configured folder.** `/backup start` posts "Backup finished" once, with the right size. If the folder is elsewhere, `backupDir` fixes it.
4. **Embeds render.** Titles aren't markdown-escaped, player names in fields and descriptions are escaped, and nothing exceeds Discord's limits: a long `/list` or `/backup list` still posts.
5. **`/cmd stop` during the 1.5 s collection window.** The output still arrives, flushed at `FMLServerStoppingEvent`, instead of "server disconnected".

---

### Task 1: Shared daily timer, units, and restart minors

**Files:**
- Create: `hub/src/units.ts`, `hub/src/daily.ts`
- Modify: `hub/src/restarts.ts` (`parseDaily`/`nextDaily` move to `daily.ts`; `daily()` replaces instead of stacking; `schedule(…, by, byName)`)
- Test: `hub/test/units.test.ts`, `hub/test/daily.test.ts` (new; the daily/DST tests move here), `hub/test/restarts.test.ts`

**Interfaces:**
- Produces:
  - `formatDuration(ms)`, `formatBytes(bytes)`, `localDay(ts)` from `units.ts`
  - `parseDaily`, `nextDaily`, `everyDay(time, leadMs, fn: (target: number) => void): () => void` from `daily.ts`
  - `RestartScheduler.schedule(serverId, minutes, by, byName = by)`

- [ ] **Step 1: Write the failing tests**

`hub/test/units.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatBytes, formatDuration, localDay } from '../src/units.ts';

test('formatDuration shows the two largest units', () => {
  assert.equal(formatDuration(0), '0 s');
  assert.equal(formatDuration(45_000), '45 s');
  assert.equal(formatDuration(192_000), '3 m 12 s');
  assert.equal(formatDuration(5 * 3600_000 + 12 * 60_000 + 30_000), '5 h 12 m');
  assert.equal(formatDuration(2 * 3600_000), '2 h');
  assert.equal(formatDuration(3 * 86_400_000 + 4 * 3600_000), '3 d 4 h');
});

test('formatBytes uses 1024-based units', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(3.2 * 1024 ** 3), '3.2 GB');
});

test('localDay uses the local calendar, not UTC', () => {
  process.env.TZ = 'Europe/London';
  assert.equal(localDay(Date.UTC(2026, 8, 24, 23, 30)), '2026-09-25'); // 00:30 BST
});
```

`hub/test/daily.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { everyDay, nextDaily, parseDaily } from '../src/daily.ts';

process.env.TZ = 'Europe/London'; // local-time assertions are in UK time, across DST changes

const MIN = 60_000;

test('parseDaily accepts only 24-hour HH:MM', () => {
  assert.deepEqual(parseDaily('06:00'), { h: 6, m: 0 });
  assert.deepEqual(parseDaily('23:59'), { h: 23, m: 59 });
  for (const bad of ['6:00', '24:00', '06:60', '6am', '']) assert.equal(parseDaily(bad), null, bad);
});

test('nextDaily follows the local clock across the October DST change', () => {
  // 24 Oct 2026 06:00 BST (05:00 UTC). Clocks go back at 02:00 on 25 Oct.
  const now = Date.UTC(2026, 9, 24, 5, 0);
  const next = nextDaily({ h: 6, m: 0 }, 10 * MIN, now);
  assert.equal(new Date(next).toISOString(), '2026-10-25T05:50:00.000Z'); // 05:50 GMT, 25 h later
});

test('nextDaily re-applies the time after a spring-forward gap', () => {
  // 28 Mar 2027: UK clocks skip 01:00–02:00, so 01:30 that day becomes 02:30 BST. The next day must be 01:30 again.
  const after = Date.UTC(2027, 2, 28, 1, 21); // 02:21 BST, just after that day's 02:20 countdown
  assert.equal(new Date(nextDaily({ h: 1, m: 30 }, 10 * MIN, after)).toISOString(), '2027-03-29T00:20:00.000Z'); // 01:20 BST
});

test('everyDay passes the scheduled target, fires daily, and can be cancelled', (t) => {
  // 24 Sep 2026 08:00 BST (07:00 UTC).
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 8, 24, 7, 0) });
  const fired: string[] = [];
  const cancel = everyDay('09:00', 0, (target) => fired.push(new Date(target).toISOString()));
  t.mock.timers.tick(60 * MIN);
  assert.deepEqual(fired, ['2026-09-24T08:00:00.000Z']);
  t.mock.timers.tick(24 * 60 * MIN);
  assert.deepEqual(fired, ['2026-09-24T08:00:00.000Z', '2026-09-25T08:00:00.000Z']);
  cancel();
  t.mock.timers.tick(48 * 60 * MIN);
  assert.equal(fired.length, 2);
});

test('everyDay does not fire twice when a timer fires a millisecond early', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 8, 24, 7, 0) });
  const clock = Date.now.bind(Date);
  let skew = 0;
  t.mock.method(Date, 'now', () => clock() + skew);
  let fired = 0;
  const cancel = everyDay('09:00', 0, () => fired++);
  skew = -1; // real Node timers can fire ~1 ms before the Date.now() target
  t.mock.timers.tick(60 * MIN);
  t.mock.timers.tick(10); // an immediate re-arm would fire here
  assert.equal(fired, 1);
  cancel();
});

test('everyDay rejects a bad time, and a throwing task does not stop the next day', (t) => {
  assert.throws(() => everyDay('9am', 0, () => {}), /HH:MM/);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.UTC(2026, 8, 24, 7, 0) });
  t.mock.method(console, 'error', () => {});
  let calls = 0;
  const cancel = everyDay('09:00', 0, () => {
    calls++;
    throw new Error('boom');
  });
  t.mock.timers.tick(60 * MIN);
  t.mock.timers.tick(24 * 60 * MIN); // separate ticks: a timer armed during a tick waits for the next one
  assert.equal(calls, 2);
  cancel();
});
```

`hub/test/restarts.test.ts`, the full file (the `parseDaily`/`nextDaily` tests moved to `daily.test.ts`; audit and replace tests added at the end):

```ts
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test, type TestContext } from 'node:test';
import { RestartScheduler } from '../src/restarts.ts';
import type { HubEvent, ServerHub, ServerState } from '../src/servers.ts';

process.env.TZ = 'Europe/London'; // daily-restart assertions are in UK local time, across a DST change

const MIN = 60_000;
const flush = () => new Promise((r) => setImmediate(r)); // setImmediate isn't mocked: lets rejections settle

function setup(t: TestContext, now = Date.UTC(2026, 8, 24, 12, 0)) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const events = new EventEmitter<{ event: [HubEvent] }>();
  const commands: string[] = [];
  const audit: string[] = []; // "command|by"
  const notices: string[] = [];
  const state = { online: true, stopError: null as Error | null };
  const hub = {
    on: (name: 'event', fn: (e: HubEvent) => void) => events.on(name, fn),
    get: (id: string) => (state.online ? ({ id, online: true } as ServerState) : undefined),
    runCommand: async (_id: string, command: string, by: string) => {
      commands.push(command);
      audit.push(`${command}|${by}`);
      if (command === 'stop' && state.stopError) throw state.stopError;
      return [];
    },
  } as unknown as Pick<ServerHub, 'runCommand' | 'on' | 'get'>;
  const restarts = new RestartScheduler(hub, (_id, text) => notices.push(text));
  t.after(() => restarts.stop());
  return { restarts, events, commands, audit, notices, state };
}

test('a 10 minute restart warns at 10m, 5m, 1m, 30s and 10s, then stops', (t) => {
  const { restarts, commands, notices } = setup(t);
  restarts.schedule('gtnh', 10, 'alice');
  t.mock.timers.tick(0);
  assert.deepEqual(commands, ['say Server restarting in 10 minutes']);
  assert.equal(restarts.pending('gtnh')?.by, 'alice');
  t.mock.timers.tick(10 * MIN);
  assert.deepEqual(commands, [
    'say Server restarting in 10 minutes',
    'say Server restarting in 5 minutes',
    'say Server restarting in 1 minute',
    'say Server restarting in 30 seconds',
    'say Server restarting in 10 seconds',
    'stop',
  ]);
  assert.deepEqual(notices, ['🔄 Restart in 10 minutes (by alice)', '🔄 Restarting now']);
  assert.equal(restarts.pending('gtnh'), undefined);
});

test('shorter countdowns only use the warnings that fit; 0 stops straight away', (t) => {
  const { restarts, commands, notices } = setup(t);
  restarts.schedule('gtnh', 2, 'alice');
  t.mock.timers.tick(2 * MIN);
  assert.deepEqual(commands, [
    'say Server restarting in 1 minute',
    'say Server restarting in 30 seconds',
    'say Server restarting in 10 seconds',
    'stop',
  ]);
  commands.length = notices.length = 0;
  restarts.schedule('gtnh', 0, 'bob');
  t.mock.timers.tick(0);
  assert.deepEqual(commands, ['stop']);
  assert.deepEqual(notices, ['🔄 Restarting now']);
});

test('rejects bad minutes, an offline server, and a second pending restart', (t) => {
  const { restarts, state } = setup(t);
  assert.throws(() => restarts.schedule('gtnh', 61, 'a'), /0 to 60/);
  assert.throws(() => restarts.schedule('gtnh', 1.5, 'a'), /whole number/);
  restarts.schedule('gtnh', 5, 'a');
  assert.throws(() => restarts.schedule('gtnh', 5, 'a'), /already scheduled/);
  state.online = false;
  assert.throws(() => restarts.schedule('other', 5, 'a'), /offline/);
});

test('cancel stops the countdown and tells players', (t) => {
  const { restarts, commands, notices } = setup(t);
  restarts.schedule('gtnh', 5, 'alice');
  assert.equal(restarts.cancel('gtnh', 'bob'), true);
  assert.equal(restarts.cancel('gtnh', 'bob'), false);
  t.mock.timers.tick(10 * MIN);
  assert.deepEqual(commands, ['say Restart cancelled']);
  assert.deepEqual(notices, ['🔄 Restart in 5 minutes (by alice)', '❎ Restart cancelled (by bob)']);
});

test('the server going down first cancels; its own stop does not', (t) => {
  const { restarts, events, commands, notices } = setup(t);
  restarts.schedule('gtnh', 5, 'alice');
  events.emit('event', { serverId: 'gtnh', type: 'crashed' });
  t.mock.timers.tick(10 * MIN);
  assert.ok(!commands.includes('stop'));
  assert.equal(notices.at(-1), '❎ Restart cancelled (server went down)');
  notices.length = 0;
  restarts.schedule('gtnh', 0, 'alice');
  t.mock.timers.tick(0);
  events.emit('event', { serverId: 'gtnh', type: 'stopped' }); // caused by our own stop
  assert.deepEqual(notices, ['🔄 Restarting now']);
});

test('stop failing with a disconnect is success; a timeout is reported', async (t) => {
  const { restarts, notices, state } = setup(t);
  state.stopError = new Error('server disconnected');
  restarts.schedule('gtnh', 0, 'alice');
  t.mock.timers.tick(0);
  await flush();
  assert.deepEqual(notices, ['🔄 Restarting now']);
  state.stopError = new Error('command timed out — it may still run when the server responds');
  restarts.schedule('gtnh', 0, 'alice');
  t.mock.timers.tick(0);
  await flush();
  assert.equal(notices.at(-1), '❌ Restart failed: command timed out — it may still run when the server responds');
});

test('daily() rejects a bad time', (t) => {
  const { restarts } = setup(t);
  assert.throws(() => restarts.daily('gtnh', '6am'), /dailyRestart must be HH:MM/);
});

test('daily restart counts down from 10 minutes before the time, every day', (t) => {
  // 24 Oct 2026 05:00 BST.
  const { restarts, commands, notices } = setup(t, Date.UTC(2026, 9, 24, 4, 0));
  restarts.daily('gtnh', '06:00');
  t.mock.timers.tick(49 * MIN);
  assert.deepEqual(notices, []);
  t.mock.timers.tick(1 * MIN); // 05:50 BST
  assert.deepEqual(notices, ['🔄 Restart in 10 minutes (by daily)']);
  t.mock.timers.tick(10 * MIN); // 06:00 BST
  assert.equal(commands.at(-1), 'stop');
  notices.length = 0;
  t.mock.timers.tick(24 * 60 * MIN - 10 * MIN); // 05:50 GMT would be 25 h later, not 24 h
  assert.deepEqual(notices, []);
  t.mock.timers.tick(60 * MIN);
  assert.deepEqual(notices, ['🔄 Restart in 10 minutes (by daily)']);
});

test('a skipped daily restart (server offline) still arms the next day', (t) => {
  // 24 Sep 2026 05:00 BST: no DST change in the next two days.
  const { restarts, notices, state } = setup(t, Date.UTC(2026, 8, 24, 4, 0));
  restarts.daily('gtnh', '06:00');
  state.online = false;
  t.mock.timers.tick(50 * MIN); // 05:50: skipped, logged
  assert.deepEqual(notices, []);
  state.online = true;
  t.mock.timers.tick(24 * 60 * MIN); // next day 05:50
  assert.deepEqual(notices, ['🔄 Restart in 10 minutes (by daily)']);
});

test('a daily timer firing a millisecond early does not double-schedule', (t) => {
  // Real Node timers can fire ~1 ms before the Date.now() target.
  const { restarts, notices } = setup(t, Date.UTC(2026, 8, 24, 4, 0));
  const clock = Date.now.bind(Date);
  let skew = 0;
  t.mock.method(Date, 'now', () => clock() + skew);
  const errors = t.mock.method(console, 'error', () => {});
  restarts.daily('gtnh', '06:00');
  skew = -1;
  t.mock.timers.tick(50 * MIN);
  t.mock.timers.tick(10); // an immediate re-arm would fire here
  assert.deepEqual(notices, ['🔄 Restart in 10 minutes (by daily)']);
  assert.equal(errors.mock.callCount(), 0);
});

test('the audit name goes to stop; people see the display name', (t) => {
  const { restarts, audit, notices } = setup(t);
  restarts.schedule('gtnh', 1, 'discord:alice (123)', 'alice');
  assert.equal(restarts.pending('gtnh')?.by, 'alice');
  t.mock.timers.tick(MIN);
  assert.equal(notices[0], '🔄 Restart in 1 minute (by alice)');
  assert.equal(audit.at(-1), 'stop|discord:alice (123)');
});

test('calling daily() again replaces the earlier daily restart instead of stacking it', (t) => {
  const { restarts, notices } = setup(t, Date.UTC(2026, 8, 24, 4, 0)); // 05:00 BST
  const errors = t.mock.method(console, 'error', () => {});
  restarts.daily('gtnh', '06:00');
  restarts.daily('gtnh', '06:00');
  t.mock.timers.tick(50 * MIN); // 05:50: exactly one countdown, and no "already scheduled" skip logged
  assert.deepEqual(notices, ['🔄 Restart in 10 minutes (by daily)']);
  assert.equal(errors.mock.callCount(), 0);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd hub && npm test`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/units.ts` and `src/daily.ts`. `restarts.test.ts` fails `the audit name goes to stop` (the notice shows the audit name) and `calling daily() again replaces…` (the error count is 1, from the stacked timer).

- [ ] **Step 3: Implement**

`hub/src/units.ts`:

```ts
/** "3 d 4 h", "5 h 12 m", "3 m 12 s", "45 s": the two largest non-zero units. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const parts: [number, string][] = [
    [Math.floor(s / 86_400), 'd'],
    [Math.floor(s / 3600) % 24, 'h'],
    [Math.floor(s / 60) % 60, 'm'],
    [s % 60, 's'],
  ];
  const first = parts.findIndex(([n]) => n > 0);
  if (first === -1) return '0 s';
  return parts
    .slice(first, first + 2)
    .filter(([n]) => n > 0)
    .map(([n, unit]) => `${n} ${unit}`)
    .join(' ');
}

/** "512 B", "1.5 KB", "3.2 GB" (1024-based). */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${n.toFixed(1)} ${units[i]}`;
}

/** Local calendar day "YYYY-MM-DD" (not UTC: toISOString would give yesterday at 00:30 BST). */
export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
```

`hub/src/daily.ts`:

```ts
/** Parses a 24-hour "HH:MM"; null if invalid. */
export function parseDaily(time: string): { h: number; m: number } | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return match ? { h: Number(match[1]), m: Number(match[2]) } : null;
}

/**
 * The next moment, strictly after `now`, that is `leadMs` before local time h:m. Recomputed from the local
 * clock every time (never "+24 h"), so a DST change doesn't shift it by an hour.
 */
export function nextDaily(time: { h: number; m: number }, leadMs: number, now: number): number {
  const d = new Date(now);
  d.setHours(time.h, time.m, 0, 0);
  while (d.getTime() - leadMs <= now) {
    d.setDate(d.getDate() + 1);
    d.setHours(time.h, time.m, 0, 0); // again: a time inside a spring-forward gap was rolled on an hour
  }
  return d.getTime() - leadMs;
}

/**
 * Calls fn(target) every day at local "HH:MM" minus `leadMs`; `target` is the scheduled time, so a timer that
 * fires a little early still knows which day it's for. Returns a cancel function. Throws on a bad time.
 */
export function everyDay(time: string, leadMs: number, fn: (target: number) => void): () => void {
  const hm = parseDaily(time);
  if (!hm) throw new Error(`must be HH:MM (24-hour), got "${time}"`);
  let timer: NodeJS.Timeout | undefined;
  // `after` is the target that just fired: timers can fire a millisecond early, and computing the next target
  // from Date.now() alone would then pick the same one again.
  const arm = (after: number) => {
    const target = nextDaily(hm, leadMs, Math.max(Date.now(), after));
    timer = setTimeout(() => {
      try {
        fn(target);
      } catch (err) {
        console.error(`[daily] ${time} task failed:`, err);
      }
      arm(target);
    }, target - Date.now());
  };
  arm(0);
  return () => clearTimeout(timer);
}
```

`hub/src/restarts.ts`:

```ts
import { everyDay, parseDaily } from './daily.ts';
import type { ServerHub } from './servers.ts';

type Hub = Pick<ServerHub, 'runCommand' | 'on' | 'get'>;
type Pending = { at: number; by: string; byName: string; timers: NodeJS.Timeout[] };

/** In-game warnings, as time left before the restart. */
const WARNINGS_MS = [600_000, 300_000, 60_000, 30_000, 10_000];
/** A daily restart starts its countdown this long before the configured time. */
const DAILY_LEAD_MS = 10 * 60_000;

export function countdownText(ms: number): string {
  if (ms >= 60_000) return `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}`;
  return `${ms / 1000} seconds`;
}

/**
 * Countdown restarts: in-game warnings, then `stop` (systemd's Restart=always brings the server back).
 * Lives in the hub core so the web dashboard can use it too. Pending restarts are in memory only.
 */
export class RestartScheduler {
  #hub: Hub;
  #notify: (serverId: string, text: string) => void;
  #pending = new Map<string, Pending>();
  #daily = new Map<string, () => void>(); // serverId -> cancel

  constructor(hub: Hub, notify: (serverId: string, text: string) => void) {
    this.#hub = hub;
    this.#notify = notify;
    hub.on('event', (e) => {
      if ((e.type === 'stopped' || e.type === 'crashed') && this.#clear(e.serverId)) {
        this.#notify(e.serverId, '❎ Restart cancelled (server went down)');
      }
    });
  }

  /**
   * `by` goes to the audit log with the `stop` command (e.g. "discord:alice (123)"); `byName` is shown to
   * people. Throws if minutes isn't a whole number 0–60, the server is offline, or a restart is already pending.
   */
  schedule(serverId: string, minutes: number, by: string, byName = by): void {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 60) {
      throw new Error('minutes must be a whole number from 0 to 60');
    }
    if (!this.#hub.get(serverId)?.online) throw new Error(`${serverId} is offline`);
    if (this.#pending.has(serverId)) throw new Error('a restart is already scheduled (use /restart cancel first)');
    const delay = minutes * 60_000;
    const timers = WARNINGS_MS.filter((w) => w <= delay).map((w) => setTimeout(() => this.#warn(serverId, w), delay - w));
    timers.push(setTimeout(() => this.#fire(serverId), delay));
    this.#pending.set(serverId, { at: Date.now() + delay, by, byName, timers });
    if (delay) this.#notify(serverId, `🔄 Restart in ${countdownText(delay)} (by ${byName})`);
  }

  /** False if nothing was pending. */
  cancel(serverId: string, by: string): boolean {
    if (!this.#clear(serverId)) return false;
    this.#notify(serverId, `❎ Restart cancelled (by ${by})`);
    this.#say(serverId, 'say Restart cancelled');
    return true;
  }

  pending(serverId: string): { at: number; by: string } | undefined {
    const p = this.#pending.get(serverId);
    return p && { at: p.at, by: p.byName };
  }

  /** Arms (or re-arms) a daily restart at local "HH:MM"; the countdown starts 10 minutes before. Throws on a bad time. */
  daily(serverId: string, time: string): void {
    if (!parseDaily(time)) throw new Error(`server "${serverId}": dailyRestart must be HH:MM (24-hour), got "${time}"`);
    this.#daily.get(serverId)?.(); // replace, don't stack, an earlier daily restart
    this.#daily.set(
      serverId,
      everyDay(time, DAILY_LEAD_MS, () => {
        try {
          this.schedule(serverId, DAILY_LEAD_MS / 60_000, 'daily');
        } catch (err) {
          console.error(`[restart] daily restart of ${serverId} skipped: ${(err as Error).message}`);
        }
      }),
    );
  }

  /** Clears every timer (hub shutdown). */
  stop(): void {
    for (const id of [...this.#pending.keys()]) this.#clear(id);
    for (const cancel of this.#daily.values()) cancel();
    this.#daily.clear();
  }

  #clear(serverId: string): boolean {
    const p = this.#pending.get(serverId);
    if (!p) return false;
    for (const timer of p.timers) clearTimeout(timer);
    this.#pending.delete(serverId);
    return true;
  }

  #say(serverId: string, command: string): void {
    this.#hub
      .runCommand(serverId, command, 'restart')
      .catch((err: Error) => console.error(`[restart] "${command}" on ${serverId} failed: ${err.message}`));
  }

  #warn(serverId: string, msLeft: number): void {
    this.#say(serverId, `say Server restarting in ${countdownText(msLeft)}`);
  }

  #fire(serverId: string): void {
    const p = this.#pending.get(serverId);
    if (!p) return;
    this.#clear(serverId); // first, so the `stopped` event this causes isn't reported as a cancellation
    this.#notify(serverId, '🔄 Restarting now');
    this.#hub.runCommand(serverId, 'stop', p.by).catch((err: Error) => {
      if (err.message === 'server disconnected') return; // it shut down before replying: that's success
      console.error(`[restart] stop on ${serverId} failed: ${err.message}`);
      this.#notify(serverId, `❌ Restart failed: ${err.message}`);
    });
  }
}
```

- [ ] **Step 4: Verify**

Run: `cd hub && npm test && npm run typecheck`
Expected: `ℹ pass 63`, `ℹ fail 0`, and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add hub/src/units.ts hub/src/daily.ts hub/src/restarts.ts hub/test/units.test.ts hub/test/daily.test.ts hub/test/restarts.test.ts
git commit -m "refactor(hub): shared DST-safe daily timer; daily() replaces, restart audit keeps the user id"
```

---

### Task 2: Player stats (sessions, peaks, summary)

**Files:**
- Modify: `hub/src/db.ts` (sessions and peaks tables, stats queries, writes through one never-throwing helper, `markHubRestart` closes dangling sessions first)
- Create: `hub/src/playtime.ts`, `hub/src/summary.ts`
- Test: `hub/test/db.test.ts`, `hub/test/playtime.test.ts`, `hub/test/summary.test.ts`

**Interfaces:**
- Consumes: `localDay` (Task 1).
- Produces:
  - `Db`:
    - `openSession(serverId, player, ts)`, `closeSession(…)`
    - `playtime(serverId, player, from, to, now?) → ms`
    - `lastSeen(serverId, player) → { online: true } | number | null`
    - `top(serverId, from, to, limit, now?) → { player, ms }[]`
    - `recordPeak(serverId, day, count)`, `peak(serverId, day) → number | null`
    - `countEvents(serverId, reason, from, to) → number`
  - `PlaytimeTracker(hub: Pick<ServerHub, 'list'>, db)` with `.poll(now)`, `.start(intervalMs = 10_000)` and `.stop()`
  - `yesterday(at)`, `buildSummary(db, serverId, at): Summary`

- [ ] **Step 1: Write the failing tests**

`hub/test/db.test.ts`, the full file (new tests at the end):

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeUptime, Db } from '../src/db.ts';

test('computeUptime splits time between states', () => {
  const rows = [
    { ts: 0, state: 'up' as const },
    { ts: 50, state: 'down' as const },
  ];
  assert.equal(computeUptime(rows, 0, 100), 0.5);
});

test('computeUptime excludes unknown time and clips to the window', () => {
  const rows = [
    { ts: 0, state: 'up' as const },
    { ts: 50, state: 'unknown' as const },
    { ts: 75, state: 'up' as const },
  ];
  assert.equal(computeUptime(rows, 0, 100), 1);
  assert.equal(computeUptime([{ ts: 0, state: 'down' as const }], 10, 20), 0);
});

test('computeUptime is null with no known time', () => {
  assert.equal(computeUptime([], 0, 100), null);
  assert.equal(computeUptime([{ ts: 0, state: 'unknown' as const }], 0, 100), null);
});

test('uptime carries the state from before the window', () => {
  const db = new Db(':memory:');
  db.record('s', 'up', 'connected', 1000);
  db.record('s', 'down', 'crashed', 2000);
  assert.equal(db.uptime('s', 0, 3000), 0.5);
  assert.equal(db.uptime('s', 1500, 3000), 1 / 3);
  assert.equal(db.uptime('other', 0, 3000), null);
  db.close();
});

test('markHubRestart makes hub downtime unknown', () => {
  const db = new Db(':memory:');
  db.record('s', 'up', 'connected', 500);
  db.touch(1000);
  db.markHubRestart(['s'], 5000);
  assert.equal(db.uptime('s', 0, 6000), 1);
  db.close();
});

test('an event after the last touch still counts as hub-alive time', () => {
  const db = new Db(':memory:');
  db.record('s', 'up', 'connected', 500);
  db.touch(1000);
  db.record('s', 'down', 'stopped', 1030); // e.g. machine reboot: hub dies before its next touch
  db.markHubRestart(['s'], 5000);
  assert.equal(db.uptime('s', 1030, 5000), null); // the outage is unknown, not downtime
  db.close();
});

test('record and touch never throw, even when the database is unusable', () => {
  const db = new Db(':memory:');
  db.close();
  assert.doesNotThrow(() => db.record('s', 'up', 'connected', 1000));
  assert.doesNotThrow(() => db.touch(1000));
});

test('playtime counts only the overlap with the window, open sessions until now, names case-insensitively', () => {
  const db = new Db(':memory:');
  db.openSession('s', 'Steve', 1000);
  db.closeSession('s', 'Steve', 5000);
  db.openSession('s', 'Steve', 8000); // still online
  assert.equal(db.playtime('s', 'steve', 0, 10_000, 10_000), 4000 + 2000);
  assert.equal(db.playtime('s', 'Steve', 2000, 4000, 10_000), 2000);
  assert.equal(db.playtime('s', 'Steve', 6000, 7000, 10_000), 0);
  assert.equal(db.playtime('other', 'Steve', 0, 10_000, 10_000), 0);
  db.close();
});

test('lastSeen: online, last session end, or never', () => {
  const db = new Db(':memory:');
  assert.equal(db.lastSeen('s', 'Alex'), null);
  db.openSession('s', 'Alex', 1000);
  assert.deepEqual(db.lastSeen('s', 'alex'), { online: true });
  db.closeSession('s', 'Alex', 3000);
  assert.equal(db.lastSeen('s', 'Alex'), 3000);
  db.close();
});

test('top ranks players by playtime in the window', () => {
  const db = new Db(':memory:');
  db.openSession('s', 'A', 0);
  db.closeSession('s', 'A', 1000);
  db.openSession('s', 'B', 0);
  db.closeSession('s', 'B', 3000);
  db.openSession('s', 'C', 5000);
  db.closeSession('s', 'C', 6000);
  assert.deepEqual(db.top('s', 0, 4000, 10), [
    { player: 'B', ms: 3000 },
    { player: 'A', ms: 1000 },
  ]);
  assert.equal(db.top('s', 0, 10_000, 1).length, 1);
  db.close();
});

test('peaks keep the daily maximum; countEvents counts reasons in a window', () => {
  const db = new Db(':memory:');
  db.recordPeak('s', '2026-09-24', 3);
  db.recordPeak('s', '2026-09-24', 5);
  db.recordPeak('s', '2026-09-24', 2);
  assert.equal(db.peak('s', '2026-09-24'), 5);
  assert.equal(db.peak('s', '2026-09-25'), null);
  db.record('s', 'up', 'started', 100);
  db.record('s', 'down', 'crashed', 200);
  db.record('s', 'up', 'started', 300);
  assert.equal(db.countEvents('s', 'started', 0, 1000), 2);
  assert.equal(db.countEvents('s', 'crashed', 250, 1000), 0);
  db.close();
});

test('markHubRestart ends open sessions at the last stamp, not across the outage', () => {
  const db = new Db(':memory:');
  db.openSession('s', 'Steve', 1000);
  db.touch(2000); // hub last alive
  db.markHubRestart(['s'], 100_000); // hub back much later
  assert.equal(db.lastSeen('s', 'Steve'), 2000);
  assert.equal(db.playtime('s', 'Steve', 0, 100_000, 100_000), 1000);
  db.close();
});

test('session and peak writes never throw either', () => {
  const db = new Db(':memory:');
  db.close();
  assert.doesNotThrow(() => db.openSession('s', 'a', 1));
  assert.doesNotThrow(() => db.closeSession('s', 'a', 2));
  assert.doesNotThrow(() => db.recordPeak('s', '2026-09-24', 1));
});
```

`hub/test/playtime.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Db } from '../src/db.ts';
import { PlaytimeTracker } from '../src/playtime.ts';
import type { ServerHub, ServerState } from '../src/servers.ts';

process.env.TZ = 'Europe/London';

function setup() {
  let states: ServerState[] = [];
  const hub = { list: () => states } as unknown as Pick<ServerHub, 'list'>;
  const db = new Db(':memory:');
  const tracker = new PlaytimeTracker(hub, db);
  const server = (players: string[], online = true): ServerState[] => [
    { id: 's', name: 'S', online, hung: false, tps: 20, players },
  ];
  return { db, tracker, set: (s: ServerState[]) => (states = s), server };
}

test('polls open and close sessions as players come and go', () => {
  const { db, tracker, set, server } = setup();
  const t0 = Date.UTC(2026, 8, 24, 12, 0);
  set(server(['Steve']));
  tracker.poll(t0);
  set(server(['Steve', 'Alex']));
  tracker.poll(t0 + 10_000);
  set(server(['Alex']));
  tracker.poll(t0 + 30_000);
  assert.equal(db.playtime('s', 'Steve', 0, t0 + 60_000, t0 + 60_000), 30_000);
  assert.deepEqual(db.lastSeen('s', 'Alex'), { online: true });
  assert.equal(db.peak('s', '2026-09-24'), 2);
});

test('a server going offline closes every session', () => {
  const { db, tracker, set, server } = setup();
  const t0 = Date.UTC(2026, 8, 24, 12, 0);
  set(server(['Steve', 'Alex']));
  tracker.poll(t0);
  set(server([], false));
  tracker.poll(t0 + 5000);
  assert.equal(db.lastSeen('s', 'Steve'), t0 + 5000);
  assert.equal(db.lastSeen('s', 'Alex'), t0 + 5000);
});

test('peaks are keyed by the local day, not UTC', () => {
  const { db, tracker, set, server } = setup();
  set(server(['Steve']));
  tracker.poll(Date.UTC(2026, 8, 24, 23, 30)); // 00:30 BST on 25 Sep
  assert.equal(db.peak('s', '2026-09-25'), 1);
  assert.equal(db.peak('s', '2026-09-24'), null);
});
```

`hub/test/summary.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Db } from '../src/db.ts';
import { buildSummary, yesterday } from '../src/summary.ts';

process.env.TZ = 'Europe/London';

const H = 60 * 60_000;

test('yesterday is the previous local day, including a 25-hour DST day', () => {
  const y = yesterday(Date.UTC(2026, 8, 24, 8, 0)); // 09:00 BST on 24 Sep
  assert.equal(y.day, '2026-09-23');
  assert.equal(new Date(y.from).toISOString(), '2026-09-22T23:00:00.000Z');
  assert.equal(y.to - y.from, 24 * H);
  const dst = yesterday(Date.UTC(2026, 9, 26, 9, 0)); // 26 Oct; 25 Oct had the clocks go back
  assert.equal(dst.day, '2026-10-25');
  assert.equal(dst.to - dst.from, 25 * H);
});

test('a summary scheduled for midnight reports the day that just ended', () => {
  const y = yesterday(Date.UTC(2026, 8, 24, 23, 0)); // exactly 00:00 BST on 25 Sep
  assert.equal(y.day, '2026-09-24');
});

test('buildSummary gathers uptime, peak, unique players, playtime, top 3, starts and crashes', () => {
  const db = new Db(':memory:');
  const { from } = yesterday(Date.UTC(2026, 8, 24, 8, 0)); // yesterday = 23 Sep (local)
  db.record('s', 'up', 'started', from);
  db.record('s', 'down', 'crashed', from + 12 * H);
  db.record('s', 'up', 'started', from + 18 * H);
  for (const [p, start, hours] of [['A', 1, 3], ['B', 2, 1], ['C', 3, 2], ['D', 4, 0.5]] as const) {
    db.openSession('s', p, from + start * H);
    db.closeSession('s', p, from + (start + hours) * H);
  }
  db.recordPeak('s', '2026-09-23', 3);
  const s = buildSummary(db, 's', Date.UTC(2026, 8, 24, 8, 0));
  assert.equal(s.day, '2026-09-23');
  assert.equal(s.uptime, 18 / 24);
  assert.equal(s.peak, 3);
  assert.equal(s.unique, 4);
  assert.equal(s.totalMs, 6.5 * H);
  assert.deepEqual(s.top.map((p) => p.player), ['A', 'C', 'B']);
  assert.equal(s.starts, 2);
  assert.equal(s.crashes, 1);
  db.close();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd hub && npm test`
Expected: FAIL. `db.test.ts` fails with `db.openSession is not a function`, and `playtime.test.ts` / `summary.test.ts` with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement**

`hub/src/db.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';

export type State = 'up' | 'down' | 'unknown';
export type Row = { ts: number; state: State };

/** Fraction of known (up + down) time in [from, to] that the server was up; null if none was known. */
export function computeUptime(rows: Row[], from: number, to: number): number | null {
  let up = 0;
  let known = 0;
  for (let i = 0; i < rows.length; i++) {
    const start = Math.max(rows[i].ts, from);
    const end = Math.min(rows[i + 1]?.ts ?? to, to);
    if (end <= start || rows[i].state === 'unknown') continue;
    known += end - start;
    if (rows[i].state === 'up') up += end - start;
  }
  return known === 0 ? null : up / known;
}

/** SQLite store: server up/down transitions (uptime) and player sessions (playtime). */
export class Db {
  #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS events (server_id TEXT NOT NULL, ts INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_server_ts ON events (server_id, ts);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (server_id TEXT NOT NULL, player TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER);
      CREATE INDEX IF NOT EXISTS sessions_server_player ON sessions (server_id, player);
      CREATE TABLE IF NOT EXISTS peaks (server_id TEXT NOT NULL, day TEXT NOT NULL, peak INTEGER NOT NULL, PRIMARY KEY (server_id, day));
    `);
  }

  /** Writes never throw: a database error (disk full, locked) is logged instead of taking the hub down. */
  #write(label: string, sql: string, ...params: (string | number | null)[]): void {
    try {
      this.#db.prepare(sql).run(...params);
    } catch (err) {
      console.error(`[db] ${label} failed:`, (err as Error).message);
    }
  }

  record(serverId: string, state: State, reason: string, ts = Date.now()): void {
    this.#write('record', 'INSERT INTO events (server_id, ts, state, reason) VALUES (?, ?, ?, ?)', serverId, ts, state, reason);
    this.touch(ts); // the hub was alive at least until this event
  }

  /** Stamps the hub as alive. Call every minute. */
  touch(ts = Date.now()): void {
    this.#write(
      'touch',
      "INSERT INTO meta (key, value) VALUES ('last_alive', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ts,
    );
  }

  /**
   * Call once at hub startup: the time since the last touch is unknown for every server, and sessions still
   * open end at that last touch. Both use the old stamp, read before touch(now) replaces it.
   */
  markHubRestart(serverIds: string[], now = Date.now()): void {
    const last = this.#db.prepare("SELECT value FROM meta WHERE key = 'last_alive'").get() as
      | { value: number }
      | undefined;
    this.#write('close sessions', 'UPDATE sessions SET end = ? WHERE end IS NULL', last?.value ?? now);
    for (const id of serverIds) {
      if (last) this.record(id, 'unknown', 'hub down', last.value);
      this.record(id, 'unknown', 'hub start', now);
    }
    this.touch(now);
  }

  uptime(serverId: string, from: number, to = Date.now()): number | null {
    const before = this.#db
      .prepare('SELECT state FROM events WHERE server_id = ? AND ts <= ? ORDER BY ts DESC, rowid DESC LIMIT 1')
      .get(serverId, from) as { state: State } | undefined;
    const rows = this.#db
      .prepare('SELECT ts, state FROM events WHERE server_id = ? AND ts > ? AND ts <= ? ORDER BY ts, rowid')
      .all(serverId, from, to) as Row[];
    return computeUptime(before ? [{ ts: from, state: before.state }, ...rows] : rows, from, to);
  }

  countEvents(serverId: string, reason: string, from: number, to: number): number {
    const row = this.#db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE server_id = ? AND reason = ? AND ts >= ? AND ts < ?')
      .get(serverId, reason, from, to) as { n: number };
    return row.n;
  }

  openSession(serverId: string, player: string, ts: number): void {
    this.#write('open session', 'INSERT INTO sessions (server_id, player, start, end) VALUES (?, ?, ?, NULL)', serverId, player, ts);
  }

  closeSession(serverId: string, player: string, ts: number): void {
    this.#write('close session', 'UPDATE sessions SET end = ? WHERE server_id = ? AND player = ? AND end IS NULL', ts, serverId, player);
  }

  /** Playtime in [from, to]; an open session counts until `now`. Names match case-insensitively. */
  playtime(serverId: string, player: string, from: number, to: number, now = Date.now()): number {
    const row = this.#db
      .prepare(
        `SELECT COALESCE(SUM(MIN(COALESCE(end, ?1), ?2) - MAX(start, ?3)), 0) AS ms FROM sessions
         WHERE server_id = ?4 AND player = ?5 COLLATE NOCASE AND start < ?2 AND COALESCE(end, ?1) > ?3`,
      )
      .get(now, to, from, serverId, player) as { ms: number };
    return row.ms;
  }

  /** `{ online: true }` while a session is open, else the last session's end, or null if never seen. */
  lastSeen(serverId: string, player: string): { online: true } | number | null {
    const row = this.#db
      .prepare('SELECT MAX(end) AS last, SUM(end IS NULL) AS open FROM sessions WHERE server_id = ? AND player = ? COLLATE NOCASE')
      .get(serverId, player) as { last: number | null; open: number | null };
    if (row.open) return { online: true };
    return row.last;
  }

  /** Players by playtime in [from, to], most first. */
  top(serverId: string, from: number, to: number, limit: number, now = Date.now()): { player: string; ms: number }[] {
    return this.#db
      .prepare(
        `SELECT player, SUM(MIN(COALESCE(end, ?1), ?2) - MAX(start, ?3)) AS ms FROM sessions
         WHERE server_id = ?4 AND start < ?2 AND COALESCE(end, ?1) > ?3
         GROUP BY player COLLATE NOCASE ORDER BY ms DESC LIMIT ?5`,
      )
      .all(now, to, from, serverId, limit)
      .map((r) => ({ player: r.player as string, ms: r.ms as number })); // plain objects, not sqlite's null-prototype rows
  }

  /** Keeps the highest player count seen on a local day ("YYYY-MM-DD"). */
  recordPeak(serverId: string, day: string, count: number): void {
    this.#write(
      'peak',
      'INSERT INTO peaks (server_id, day, peak) VALUES (?, ?, ?) ON CONFLICT (server_id, day) DO UPDATE SET peak = MAX(peak, excluded.peak)',
      serverId,
      day,
      count,
    );
  }

  peak(serverId: string, day: string): number | null {
    const row = this.#db.prepare('SELECT peak FROM peaks WHERE server_id = ? AND day = ?').get(serverId, day) as
      | { peak: number }
      | undefined;
    return row?.peak ?? null;
  }

  close(): void {
    this.#db.close();
  }
}
```

`hub/src/playtime.ts`:

```ts
import type { Db } from './db.ts';
import type { ServerHub } from './servers.ts';
import { localDay } from './units.ts';

/**
 * Keeps the sessions table in step with each server's live player list (from heartbeats), so playtime
 * survives missed join/leave events, crashes and hub restarts. Accuracy is the poll interval.
 */
export class PlaytimeTracker {
  #hub: Pick<ServerHub, 'list'>;
  #db: Db;
  #open = new Map<string, Set<string>>(); // serverId -> players with an open session
  #timer: NodeJS.Timeout | undefined;

  constructor(hub: Pick<ServerHub, 'list'>, db: Db) {
    this.#hub = hub;
    this.#db = db;
  }

  start(intervalMs = 10_000): void {
    this.#timer = setInterval(() => this.poll(Date.now()), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  poll(now: number): void {
    for (const s of this.#hub.list()) {
      const open = this.#open.get(s.id) ?? new Set<string>();
      const online = new Set(s.online ? s.players : []);
      for (const player of online) {
        if (!open.has(player)) {
          this.#db.openSession(s.id, player, now);
          open.add(player);
        }
      }
      for (const player of open) {
        if (!online.has(player)) {
          this.#db.closeSession(s.id, player, now);
          open.delete(player);
        }
      }
      this.#open.set(s.id, open);
      if (s.online) this.#db.recordPeak(s.id, localDay(now), online.size);
    }
  }
}
```

`hub/src/summary.ts`:

```ts
import type { Db } from './db.ts';
import { localDay } from './units.ts';

export type Summary = {
  day: string;
  uptime: number | null;
  peak: number | null;
  unique: number;
  totalMs: number;
  top: { player: string; ms: number }[];
  starts: number;
  crashes: number;
};

/** The local calendar day before `at`, midnight to midnight (23 or 25 h long on DST days). */
export function yesterday(at: number): { from: number; to: number; day: string } {
  const to = new Date(at);
  to.setHours(0, 0, 0, 0);
  const from = new Date(to);
  from.setDate(from.getDate() - 1);
  return { from: from.getTime(), to: to.getTime(), day: localDay(from.getTime()) };
}

/** Stats for the day before `at` (the summary's scheduled time, not Date.now()). */
export function buildSummary(db: Db, serverId: string, at: number): Summary {
  const { from, to, day } = yesterday(at);
  const players = db.top(serverId, from, to, 1_000_000);
  return {
    day,
    uptime: db.uptime(serverId, from, to),
    peak: db.peak(serverId, day),
    unique: players.length,
    totalMs: players.reduce((sum, p) => sum + p.ms, 0),
    top: players.slice(0, 3),
    starts: db.countEvents(serverId, 'started', from, to),
    crashes: db.countEvents(serverId, 'crashed', from, to),
  };
}
```

- [ ] **Step 4: Verify**

Run: `cd hub && npm test && npm run typecheck`
Expected: `ℹ pass 75`, `ℹ fail 0`, and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add hub/src/db.ts hub/src/playtime.ts hub/src/summary.ts hub/test/db.test.ts hub/test/playtime.test.ts hub/test/summary.test.ts
git commit -m "feat(hub): playtime sessions, daily peaks and daily summary stats"
```

---

### Task 3: Backups, and crash logs skip symlinks

**Files:**
- Create: `hub/src/backups.ts`
- Modify: `hub/src/crashlogs.ts` (`lstat`)
- Test: `hub/test/backups.test.ts`, `hub/test/crashlogs.test.ts`

**Interfaces:**
- Consumes: `formatBytes`, `formatDuration` (Task 1).
- Produces:
  - `type Backup = { name, size, mtimeMs }`
  - `listBackups(dir): Promise<Backup[]>`, newest first
  - `new BackupWatcher(list: (serverId) => Promise<Backup[]>, notify)` with `.watch(serverId, since): boolean`, `.watchdog(serverId, maxAgeHours)` and `.stop()`

- [ ] **Step 1: Write the failing tests**

`hub/test/backups.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { BackupWatcher, listBackups, type Backup } from '../src/backups.ts';

const MIN = 60_000;
const flush = () => new Promise((r) => setImmediate(r)); // lets the injected list() promise settle

test('listBackups finds finished zips newest first and skips everything else', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'backups-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = async (name: string, mtimeSec: number, bytes = 10) => {
    await writeFile(join(dir, name), 'x'.repeat(bytes));
    await utimes(join(dir, name), mtimeSec, mtimeSec);
  };
  await file('2026-09-23-06-00-00.zip', 1000, 100);
  await file('2026-09-24-06-00-00.zip', 2000, 200);
  await file('.su-save-123.tmp', 3000); // staging
  await file('notes.txt', 3000);
  await mkdir(join(dir, '2026-09-25-06-00-00.zip')); // a folder, not a backup
  await symlink(join(dir, 'notes.txt'), join(dir, '2026-09-26-06-00-00.zip'));
  assert.deepEqual(
    (await listBackups(dir)).map((b) => [b.name, b.size]),
    [
      ['2026-09-24-06-00-00.zip', 200],
      ['2026-09-23-06-00-00.zip', 100],
    ],
  );
  assert.deepEqual(await listBackups(join(dir, 'missing')), []);
});

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000_000_000 });
  let backups: Backup[] = [];
  const notices: string[] = [];
  const watcher = new BackupWatcher(
    async () => backups,
    (_id, text) => notices.push(text),
  );
  t.after(() => watcher.stop());
  return { watcher, notices, set: (b: Backup[]) => (backups = b) };
}

test('watch reports the first backup that appears after the start', async (t) => {
  const { watcher, notices, set } = setup(t);
  const since = Date.now();
  set([{ name: 'old.zip', size: 1, mtimeMs: since - MIN }]);
  assert.equal(watcher.watch('gtnh', since), true);
  assert.equal(watcher.watch('gtnh', since), false); // one watch per server
  t.mock.timers.tick(10_000);
  await flush();
  assert.deepEqual(notices, []);
  set([{ name: '2026-09-24-06-00-00.zip', size: 3 * 1024 ** 3, mtimeMs: since + 192_000 }]);
  t.mock.timers.tick(10_000);
  await flush();
  assert.deepEqual(notices, ['✅ Backup finished: 2026-09-24-06-00-00.zip (3.0 GB, 3 m 12 s)']);
  assert.equal(watcher.watch('gtnh', Date.now()), true); // free again
});

test('watch gives up after 60 minutes', async (t) => {
  const { watcher, notices } = setup(t);
  watcher.watch('gtnh', Date.now());
  for (let i = 0; i < 6 * 60; i++) {
    t.mock.timers.tick(10_000);
    await flush();
  }
  assert.deepEqual(notices, ['⚠️ No finished backup appeared within 60 minutes']);
});

test('the watchdog warns once when backups are overdue and re-arms after a new one', async (t) => {
  const { watcher, notices, set } = setup(t);
  set([{ name: 'a.zip', size: 1, mtimeMs: Date.now() - 30 * 60 * MIN }]); // 30 h old
  watcher.watchdog('gtnh', 26);
  t.mock.timers.tick(10 * MIN);
  await flush();
  t.mock.timers.tick(10 * MIN);
  await flush();
  assert.deepEqual(notices, ['⚠️ No new backup for 30 h (newest: a.zip)']);
  set([{ name: 'b.zip', size: 1, mtimeMs: Date.now() }]);
  t.mock.timers.tick(10 * MIN);
  await flush();
  set([{ name: 'b.zip', size: 1, mtimeMs: Date.now() - 27 * 60 * MIN }]);
  t.mock.timers.tick(10 * MIN);
  await flush();
  assert.equal(notices.length, 2);
  assert.match(notices[1], /No new backup for 27 h/);
});
```

`hub/test/crashlogs.test.ts`, the full file (the symlink test is at the end, and `symlink` is added to the import):

```ts
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findCrashLogs } from '../src/crashlogs.ts';

async function file(path: string, mtimeSec: number, bytes = 10): Promise<void> {
  await writeFile(path, 'x'.repeat(bytes));
  await utimes(path, mtimeSec, mtimeSec);
}

test('finds the newest crash report and JVM log written since the cutoff', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crashlogs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'crash-reports'));
  await file(join(dir, 'crash-reports', 'crash-old-server.txt'), 1000);
  await file(join(dir, 'crash-reports', 'crash-new-server.txt'), 3000);
  await file(join(dir, 'crash-reports', 'notes.md'), 4000); // wrong extension
  await file(join(dir, 'hs_err_pid111.log'), 1000);
  await file(join(dir, 'hs_err_pid222.log'), 3500);
  await file(join(dir, 'hs_err_pid333.txt'), 4000); // wrong name
  assert.deepEqual(await findCrashLogs(dir, 2000 * 1000), [
    join(dir, 'crash-reports', 'crash-new-server.txt'),
    join(dir, 'hs_err_pid222.log'),
  ]);
});

test('ignores files older than the cutoff or too big to upload', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crashlogs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'crash-reports'));
  await file(join(dir, 'crash-reports', 'crash-old.txt'), 1000);
  await file(join(dir, 'hs_err_pid1.log'), 5000, 9 * 1024 * 1024);
  assert.deepEqual(await findCrashLogs(dir, 2000 * 1000), []);
});

test('a missing folder yields no files instead of an error', async () => {
  assert.deepEqual(await findCrashLogs(join(tmpdir(), 'does-not-exist-' + Date.now()), 0), []);
});

test('a symlink is not followed (it could point at the hub token)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'crashlogs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'crash-reports'));
  await file(join(dir, 'secret.env'), 3000);
  await symlink(join(dir, 'secret.env'), join(dir, 'crash-reports', 'crash-evil.txt'));
  assert.deepEqual(await findCrashLogs(dir, 0), []);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd hub && npm test`
Expected: FAIL. `backups.test.ts` fails with `ERR_MODULE_NOT_FOUND`, and `crashlogs.test.ts` fails `a symlink is not followed` (the symlinked file is returned).

- [ ] **Step 3: Implement**

`hub/src/backups.ts`:

```ts
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { formatBytes, formatDuration } from './units.ts';

export type Backup = { name: string; size: number; mtimeMs: number };

/** ServerUtilities' backup names: "<YYYY-MM-DD-HH-MM-SS>.zip", moved into place atomically when finished. */
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}.*\.zip$/;
const POLL_MS = 10_000;
const WATCH_TIMEOUT_MS = 60 * 60_000;
const WATCHDOG_MS = 10 * 60_000;
const HOUR = 60 * 60_000;

/** Finished backups in a folder, newest first. Skips staging files, folders and symlinks; never throws. */
export async function listBackups(dir: string): Promise<Backup[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const found: Backup[] = [];
  for (const name of names) {
    if (!BACKUP_NAME.test(name)) continue;
    try {
      const st = await lstat(join(dir, name));
      if (st.isFile()) found.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // deleted between readdir and lstat (e.g. old backups being pruned)
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Watches backup folders: reports when a backup started from Discord finishes, and warns when scheduled
 * backups stop appearing. Hub core (plain-text notices); `list` is injected so tests needn't touch disk.
 */
export class BackupWatcher {
  #list: (serverId: string) => Promise<Backup[]>;
  #notify: (serverId: string, text: string) => void;
  #watches = new Map<string, NodeJS.Timeout>();
  #watchdogs = new Map<string, NodeJS.Timeout>();
  #overdue = new Set<string>();

  constructor(list: (serverId: string) => Promise<Backup[]>, notify: (serverId: string, text: string) => void) {
    this.#list = list;
    this.#notify = notify;
  }

  /** After `/backup start`: report the first backup modified since `since`. False if already watching. */
  watch(serverId: string, since: number): boolean {
    if (this.#watches.has(serverId)) return false;
    const deadline = since + WATCH_TIMEOUT_MS;
    const poll = async () => {
      const found = (await this.#list(serverId)).find((b) => b.mtimeMs >= since);
      if (found) {
        this.#watches.delete(serverId);
        this.#notify(
          serverId,
          `✅ Backup finished: ${found.name} (${formatBytes(found.size)}, ${formatDuration(found.mtimeMs - since)})`,
        );
      } else if (Date.now() >= deadline) {
        this.#watches.delete(serverId);
        this.#notify(serverId, '⚠️ No finished backup appeared within 60 minutes');
      } else {
        this.#watches.set(serverId, setTimeout(() => void poll(), POLL_MS));
      }
    };
    this.#watches.set(serverId, setTimeout(() => void poll(), POLL_MS));
    return true;
  }

  /** Every 10 minutes, warn once if the newest backup is older than `maxAgeHours`; re-arms after a new one. */
  watchdog(serverId: string, maxAgeHours: number): void {
    clearInterval(this.#watchdogs.get(serverId));
    const check = async () => {
      const newest = (await this.#list(serverId))[0];
      const age = newest ? Date.now() - newest.mtimeMs : Infinity;
      if (age <= maxAgeHours * HOUR) {
        this.#overdue.delete(serverId);
      } else if (!this.#overdue.has(serverId)) {
        this.#overdue.add(serverId);
        this.#notify(
          serverId,
          newest ? `⚠️ No new backup for ${Math.floor(age / HOUR)} h (newest: ${newest.name})` : '⚠️ No backups found',
        );
      }
    };
    this.#watchdogs.set(serverId, setInterval(() => void check(), WATCHDOG_MS));
  }

  /** Clears every timer (hub shutdown). */
  stop(): void {
    for (const timer of this.#watches.values()) clearTimeout(timer);
    for (const timer of this.#watchdogs.values()) clearInterval(timer);
    this.#watches.clear();
    this.#watchdogs.clear();
  }
}
```

`hub/src/crashlogs.ts`:

```ts
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Discord's upload limit is 10 MB; stay under it. */
const MAX_BYTES = 8 * 1024 * 1024;

async function newest(dir: string, match: (name: string) => boolean, sinceMs: number): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null; // no such folder (e.g. no crash has ever happened)
  }
  let best: { path: string; mtime: number } | null = null;
  for (const name of names) {
    if (!match(name)) continue;
    const path = join(dir, name);
    try {
      const st = await lstat(path); // lstat: a symlink (e.g. to the hub's .env) is not a file and is skipped
      if (!st.isFile() || st.size > MAX_BYTES || st.mtimeMs < sinceMs) continue;
      if (!best || st.mtimeMs > best.mtime) best = { path, mtime: st.mtimeMs };
    } catch {
      // deleted between readdir and stat
    }
  }
  return best?.path ?? null;
}

/**
 * The newest Minecraft crash report and the newest JVM crash log (hs_err_pid*.log) in a server folder,
 * each only if written at or after `sinceMs` and small enough to upload. Returns 0–2 paths; never throws.
 */
export async function findCrashLogs(serverDir: string, sinceMs: number): Promise<string[]> {
  const found = await Promise.all([
    newest(join(serverDir, 'crash-reports'), (n) => n.endsWith('.txt'), sinceMs),
    newest(serverDir, (n) => /^hs_err_pid\d+\.log$/.test(n), sinceMs),
  ]);
  return found.filter((p): p is string => p !== null);
}
```

- [ ] **Step 4: Verify**

Run: `cd hub && npm test && npm run typecheck`
Expected: `ℹ pass 80`, `ℹ fail 0`, and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add hub/src/backups.ts hub/src/crashlogs.ts hub/test/backups.test.ts hub/test/crashlogs.test.ts
git commit -m "feat(hub): backup listing, finish notices and missing-backup watchdog; crash logs skip symlinks"
```

---

### Task 4: Embeds, new commands and wiring

**Files:**
- Modify: `hub/src/format.ts` (returns `Post`, which is plain text or embeds; new formatters), `hub/src/discord.ts`, `hub/src/index.ts`, `hub/config.example.json`
- Test: `hub/test/format.test.ts`, `hub/test/discord.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces:
  - `type Post = { content } | { embeds: APIEmbed[] }`
  - `formatNotice(text)`, `formatStatus`, `formatPlayers`, `formatPlaytime`, `formatLastSeen`, `formatTop`, `formatBackupStatus`, `formatBackupList`, `formatSummary`, `COLORS`, `TOP_PERIODS`
  - `startDiscord(hub, db, restarts, backups, cfg: DiscordConfig & { backupDirs }, token): Promise<{ client, notice(serverId, text), summary(serverId, Summary) }>`
  - `COMMANDS` gains `playtime`, `top` and `backup` (`backup` is hidden by default)

- [ ] **Step 1: Write the failing tests**

`hub/test/format.test.ts`, the full file:

````ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { APIEmbed } from 'discord.js';
import {
  COLORS,
  formatBackupList,
  formatBackupStatus,
  formatEvent,
  formatLastSeen,
  formatNotice,
  formatOutput,
  formatPlayers,
  formatPlaytime,
  formatPresence,
  formatStatus,
  formatSummary,
  formatTop,
  formatTopic,
  TOPIC_MIN_GAP_MS,
  topicDue,
  type Post,
} from '../src/format.ts';
import type { ServerState } from '../src/servers.ts';

test('formatEvent keeps chat-like events as escaped plain text', () => {
  assert.deepEqual(formatEvent({ serverId: 's', type: 'chat', player: 'x_y_z', message: '**hi** [a](http://x) §cred' }), {
    content: '**x\\_y\\_z**: \\*\\*hi\\*\\* \\[a](http://x) red',
  });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'chat', player: 'a', message: '# big' }), { content: '**a**: \\# big' });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'death', player: 'Steve', message: 'Steve fell from a high place' }), {
    content: '💀 Steve fell from a high place',
  });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'achievement', player: 'Steve', achievement: 'Taking Inventory' }), {
    content: '🏆 **Steve** earned **Taking Inventory**',
  });
});

test('formatEvent announces lifecycle as coloured embeds, but not reconnects', () => {
  assert.equal(formatEvent({ serverId: 's', type: 'connected' }), null);
  assert.equal(formatEvent({ serverId: 's', type: 'offline' }), null);
  assert.deepEqual(formatEvent({ serverId: 's', type: 'crashed' }), {
    embeds: [{ title: '💥 Server went down unexpectedly', color: COLORS.red }],
  });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'started' }), { embeds: [{ title: '✅ Server started', color: COLORS.green }] });
  assert.deepEqual(formatEvent({ serverId: 's', type: 'hung' }), { embeds: [{ title: '⚠️ Server not responding', color: COLORS.orange }] });
});

test('formatNotice colours by the leading emoji', () => {
  const color = (text: string) => (formatNotice(text) as { embeds: { color?: number }[] }).embeds[0].color;
  assert.equal(color('🔄 Restart in 5 minutes (by a)'), COLORS.blue);
  assert.equal(color('❌ Restart failed: timed out'), COLORS.red);
  assert.equal(color('⚠️ No new backup for 30 h'), COLORS.orange);
  assert.equal(color('✅ Backup finished: x.zip'), COLORS.green);
  const long = formatNotice('x'.repeat(300)) as { embeds: { title?: string }[] };
  assert.ok(long.embeds[0].title!.length <= 256);
});

test('formatOutput always yields one valid code block under 2000 chars', () => {
  assert.equal(formatOutput([]), '```\n(no output)\n```');
  assert.equal(formatOutput(['§aGreen', 'b']), '```\nGreen\nb\n```');
  const sneaky = formatOutput(['```', '@everyone']);
  assert.equal(sneaky, "```\n'''\n@everyone\n```");
  const long = formatOutput(['x'.repeat(5000)]);
  assert.ok(long.length < 2000);
  assert.ok(long.endsWith('… (truncated)\n```'));
});

const first = (p: Post) => (p as { embeds: APIEmbed[] }).embeds[0];

test('formatStatus is an embed with state, TPS, players and uptime', () => {
  const base: ServerState = { id: 's', name: 'GTNH', online: true, hung: false, tps: 19.96, players: ['a_b', 'c'] };
  const e = first(formatStatus(base, 1, 0.5));
  assert.equal(e.title, 'GTNH — 🟢 Online');
  assert.equal(e.color, COLORS.green);
  assert.deepEqual(
    e.fields!.map((f) => [f.name, f.value]),
    [
      ['TPS', '20.0'],
      ['Players', '2'],
      ['Uptime 24 h', '100.0%'],
      ['Uptime 7 d', '50.0%'],
      ['Online now', 'a\\_b, c'],
    ],
  );
  assert.equal(first(formatStatus({ ...base, hung: true }, null, null)).title, 'GTNH — 🟠 Not responding');
  const off = first(formatStatus({ ...base, online: false, tps: null, players: [] }, 0, 0));
  assert.equal(off.color, COLORS.red);
  assert.deepEqual(off.fields!.map((f) => f.name), ['Uptime 24 h', 'Uptime 7 d']);
});

test('formatPlayers lists escaped names in an embed', () => {
  assert.equal(first(formatPlayers([])).title, 'Nobody online');
  const e = first(formatPlayers(['Steve', 'a_b']));
  assert.equal(e.title, 'Online (2)');
  assert.equal(e.description, 'Steve, a\\_b');
});

test('formatPlaytime and formatLastSeen', () => {
  const now = 10 * 3600_000;
  assert.equal(formatLastSeen(null, now), 'never');
  assert.equal(formatLastSeen({ online: true }, now), 'online now');
  assert.equal(formatLastSeen(now - 3 * 3600_000, now), '3 h ago');
  const e = first(formatPlaytime('Steve', 5 * 3600_000 + 12 * 60_000, 3600_000, { online: true }, now));
  assert.deepEqual(
    e.fields!.map((f) => [f.name, f.value]),
    [
      ['Player', 'Steve'],
      ['Total', '5 h 12 m'],
      ['Last 7 days', '1 h'],
      ['Last seen', 'online now'],
    ],
  );
});

test('formatTop numbers players and handles an empty period', () => {
  const e = first(formatTop('week', [{ player: 'a_b', ms: 7200_000 }, { player: 'C', ms: 60_000 }]));
  assert.equal(e.title, 'Top players (last 7 days)');
  assert.equal(e.description, '1. **a\\_b**: 2 h\n2. **C**: 1 m');
  assert.equal(first(formatTop('day', [])).description, 'No playtime recorded.');
});

test('formatBackupStatus and formatBackupList show count and total size', () => {
  const now = 1_000_000_000_000;
  const backups = [
    { name: '2026-09-24-06-00-00.zip', size: 2 * 1024 ** 3, mtimeMs: now - 2 * 3600_000 },
    { name: '2026-09-23-06-00-00.zip', size: 1024 ** 3, mtimeMs: now - 26 * 3600_000 },
  ];
  const status = first(formatBackupStatus(backups, now));
  assert.deepEqual(
    status.fields!.map((f) => [f.name, f.value]),
    [
      ['Newest', '2026-09-24-06-00-00.zip'],
      ['Age', '2 h'],
      ['Size', '2.0 GB'],
      ['Count', '2'],
      ['Total size', '3.0 GB'],
    ],
  );
  const list = first(formatBackupList(backups));
  assert.equal(list.title, 'Backups: 2, 3.0 GB total');
  assert.equal(list.description, '`2026-09-24-06-00-00.zip` 2.0 GB\n`2026-09-23-06-00-00.zip` 1.0 GB');
  assert.equal(first(formatBackupStatus([], now)).description, 'No backups found.');
});

test('formatSummary lays out the daily stats', () => {
  const e = first(
    formatSummary('GTNH', {
      day: '2026-09-23',
      uptime: 0.75,
      peak: 3,
      unique: 4,
      totalMs: 6.5 * 3600_000,
      top: [{ player: 'A', ms: 3 * 3600_000 }],
      starts: 2,
      crashes: 1,
    }),
  );
  assert.equal(e.title, '📊 GTNH: 2026-09-23');
  assert.deepEqual(
    e.fields!.map((f) => [f.name, f.value]),
    [
      ['Uptime', '75.0%'],
      ['Peak players', '3'],
      ['Unique players', '4'],
      ['Total playtime', '6 h 30 m'],
      ['Starts', '2'],
      ['Crashes', '1'],
      ['Top players', '1. **A**: 3 h'],
    ],
  );
});

test('formatOutput truncates long emoji output without splitting an emoji', () => {
  const out = formatOutput(['😀'.repeat(2000)]);
  assert.ok(out.length <= 2000, `length ${out.length}`);
  assert.ok(out.endsWith('😀\n… (truncated)\n```'));
});

const online: ServerState = { id: 'gtnh', name: 'GTNH', online: true, hung: false, tps: 19.7, players: ['Steve', 'Alex'] };

test('formatPresence has one segment per server', () => {
  assert.equal(formatPresence([online]), 'GTNH: 2 online · 20 TPS');
  assert.equal(
    formatPresence([online, { ...online, id: 'sky', name: 'Sky', online: false, tps: null, players: [] }, { ...online, id: 'x', name: 'X', hung: true }]),
    'GTNH: 2 online · 20 TPS | Sky: offline | X: not responding',
  );
  assert.equal(formatPresence([{ ...online, tps: null }]), 'GTNH: 2 online');
  assert.ok(formatPresence(Array(20).fill(online)).length <= 128);
});

test('formatTopic shows state, TPS and players within 1024 chars', () => {
  assert.equal(formatTopic(online), '🟢 Online · 20 TPS · 2 players: Steve, Alex');
  assert.equal(formatTopic({ ...online, players: ['Steve'] }), '🟢 Online · 20 TPS · 1 player: Steve');
  assert.equal(formatTopic({ ...online, players: [] }), '🟢 Online · 20 TPS · 0 players');
  assert.equal(formatTopic({ ...online, hung: true }), '🟠 Not responding');
  assert.equal(formatTopic({ ...online, online: false }), '🔴 Offline');
  assert.ok(formatTopic({ ...online, players: Array(200).fill('SomeLongPlayerName') }).length <= 1024);
});

test('topicDue edits on first sight, then only on change and after the minimum gap', () => {
  assert.equal(topicDue(undefined, 'a', 0), true);
  const last = { text: 'a', at: 1000 };
  assert.equal(topicDue(last, 'a', 1000 + TOPIC_MIN_GAP_MS), false); // unchanged
  assert.equal(topicDue(last, 'b', 1000 + TOPIC_MIN_GAP_MS - 1), false); // too soon
  assert.equal(topicDue(last, 'b', 1000 + TOPIC_MIN_GAP_MS), true);
});
````

`hub/test/discord.test.ts`, the full file:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from 'discord.js';
import { COMMANDS, shouldRelay } from '../src/discord.ts';

const msg = (over: { bot?: boolean; webhookId?: string | null; system?: boolean }) =>
  ({ author: { bot: over.bot ?? false }, webhookId: over.webhookId ?? null, system: over.system ?? false }) as unknown as Message;

test('shouldRelay passes people only', () => {
  assert.equal(shouldRelay(msg({})), true);
  assert.equal(shouldRelay(msg({ bot: true })), false);
  assert.equal(shouldRelay(msg({ webhookId: '123' })), false); // includes our own relay webhook: no echo loop
  assert.equal(shouldRelay(msg({ system: true })), false); // "thread created", pins, joins
});

test('admin commands are hidden by default; public ones are not', () => {
  const perms = Object.fromEntries(COMMANDS.map((c) => [c.name, c.default_member_permissions]));
  assert.equal(perms.cmd, '0');
  assert.equal(perms.restart, '0');
  assert.equal(perms.backup, '0');
  for (const name of ['status', 'list', 'playtime', 'top']) assert.ok(!perms[name], name);
});

test('the command set includes stats and backup subcommands', () => {
  const byName = Object.fromEntries(COMMANDS.map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(byName).sort(), ['backup', 'cmd', 'list', 'playtime', 'restart', 'status', 'top']);
  assert.deepEqual(byName.backup.options?.map((o) => o.name), ['start', 'status', 'list']);
  assert.deepEqual(
    (byName.top.options?.[0] as { choices?: { value: string }[] }).choices?.map((c) => c.value),
    ['day', 'week', 'all'],
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd hub && npm test`
Expected: FAIL. `format.test.ts` errors with `does not provide an export named 'COLORS'`, and `discord.test.ts` fails the command-set tests (no `backup`, `playtime` or `top`).

- [ ] **Step 3: Implement**

`hub/src/format.ts`:

````ts
import { escapeMarkdown, type APIEmbed } from 'discord.js';
import type { Backup } from './backups.ts';
import { stripCodes, truncate, type HubEvent, type ServerState } from './servers.ts';
import type { Summary } from './summary.ts';
import { formatBytes, formatDuration } from './units.ts';

/** What the bot posts: plain text (chat-like messages) or an embed (everything else). */
export type Post = { content: string } | { embeds: APIEmbed[] };

export const COLORS = { green: 0x2ecc71, grey: 0x95a5a6, red: 0xe74c3c, orange: 0xe67e22, blue: 0x3498db } as const;

// Discord embed limits.
const TITLE = 256;
const FIELD = 1024;
const DESCRIPTION = 4096;

/** Escapes Minecraft text for Discord: no § codes, no markdown, headings, lists or masked links. */
export function md(s: string): string {
  return escapeMarkdown(stripCodes(s), { heading: true, maskedLink: true, bulletedList: true, numberedList: true });
}

/** Embed titles render less markdown than descriptions, so they only get § codes stripped. */
function title(s: string): string {
  return truncate(stripCodes(s), TITLE);
}

const embed = (e: APIEmbed): Post => ({ embeds: [e] });

/** The Discord post for a hub event, or null for events that aren't announced. */
export function formatEvent(e: HubEvent): Post | null {
  switch (e.type) {
    case 'chat':
      return { content: `**${md(e.player)}**: ${md(e.message)}` };
    case 'join':
      return { content: `➡️ **${md(e.player)}** joined` };
    case 'leave':
      return { content: `⬅️ **${md(e.player)}** left` };
    case 'death':
      return { content: `💀 ${md(e.message)}` };
    case 'achievement':
      return { content: `🏆 **${md(e.player)}** earned **${md(e.achievement)}**` };
    case 'started':
      return embed({ title: '✅ Server started', color: COLORS.green });
    case 'stopped':
      return embed({ title: '🛑 Server stopped', color: COLORS.grey });
    case 'crashed':
      return embed({ title: '💥 Server went down unexpectedly', color: COLORS.red });
    case 'hung':
      return embed({ title: '⚠️ Server not responding', color: COLORS.orange });
    case 'recovered':
      return embed({ title: '✅ Server responding again', color: COLORS.green });
    case 'connected': // may just be a reconnect after a hub restart
    case 'offline': // hub-start bookkeeping for uptime, not news
      return null;
  }
}

/** A hub-core notice (restarts, backups) as an embed, coloured by its leading emoji. */
export function formatNotice(text: string): Post {
  const color = text.startsWith('❌')
    ? COLORS.red
    : text.startsWith('⚠️')
      ? COLORS.orange
      : text.startsWith('✅')
        ? COLORS.green
        : COLORS.blue;
  return embed({ title: title(text), color });
}

const pct = (u: number | null) => (u === null ? 'n/a' : `${(u * 100).toFixed(1)}%`);

export function formatStatus(s: ServerState, day: number | null, week: number | null): Post {
  const [state, color] = !s.online
    ? ['🔴 Offline', COLORS.red]
    : s.hung
      ? ['🟠 Not responding', COLORS.orange]
      : ['🟢 Online', COLORS.green];
  const fields = [
    ...(s.online
      ? [
          { name: 'TPS', value: s.tps === null ? 'n/a' : s.tps.toFixed(1), inline: true },
          { name: 'Players', value: String(s.players.length), inline: true },
        ]
      : []),
    { name: 'Uptime 24 h', value: pct(day), inline: true },
    { name: 'Uptime 7 d', value: pct(week), inline: true },
  ];
  if (s.online && s.players.length) fields.push({ name: 'Online now', value: truncate(s.players.map(md).join(', '), FIELD), inline: false });
  return embed({ title: title(`${s.name} — ${state}`), color, fields });
}

export function formatPlayers(players: string[]): Post {
  if (!players.length) return embed({ title: 'Nobody online', color: COLORS.blue });
  return embed({
    title: `Online (${players.length})`,
    description: truncate(players.map(md).join(', '), DESCRIPTION),
    color: COLORS.blue,
  });
}

/** Command output as a code block that always fits in one Discord message. */
export function formatOutput(lines: string[]): string {
  const max = 1900;
  let text = stripCodes(lines.join('\n')).replaceAll('```', "'''") || '(no output)';
  if (text.length > max) text = truncate(text, max) + '\n… (truncated)';
  return '```\n' + text + '\n```';
}

export function formatLastSeen(seen: { online: true } | number | null, now: number): string {
  if (seen === null) return 'never';
  if (typeof seen === 'object') return 'online now';
  return `${formatDuration(now - seen)} ago`;
}

export function formatPlaytime(player: string, totalMs: number, weekMs: number, seen: { online: true } | number | null, now: number): Post {
  return embed({
    title: 'Playtime',
    color: COLORS.blue,
    fields: [
      { name: 'Player', value: md(player), inline: false },
      { name: 'Total', value: formatDuration(totalMs), inline: true },
      { name: 'Last 7 days', value: formatDuration(weekMs), inline: true },
      { name: 'Last seen', value: formatLastSeen(seen, now), inline: true },
    ],
  });
}

export const TOP_PERIODS = { day: 'last 24 hours', week: 'last 7 days', all: 'all time' } as const;

export function formatTop(period: keyof typeof TOP_PERIODS, rows: { player: string; ms: number }[]): Post {
  const lines = rows.map((r, i) => `${i + 1}. **${md(r.player)}**: ${formatDuration(r.ms)}`);
  return embed({
    title: `Top players (${TOP_PERIODS[period]})`,
    description: truncate(lines.join('\n'), DESCRIPTION) || 'No playtime recorded.',
    color: COLORS.blue,
  });
}

const totalSize = (backups: Backup[]) => formatBytes(backups.reduce((sum, b) => sum + b.size, 0));

export function formatBackupStatus(backups: Backup[], now: number): Post {
  const newest = backups[0];
  if (!newest) return embed({ title: 'Backups', description: 'No backups found.', color: COLORS.orange });
  return embed({
    title: 'Backups',
    color: COLORS.blue,
    fields: [
      { name: 'Newest', value: truncate(newest.name, FIELD), inline: false },
      { name: 'Age', value: `${formatDuration(now - newest.mtimeMs)}`, inline: true },
      { name: 'Size', value: formatBytes(newest.size), inline: true },
      { name: 'Count', value: String(backups.length), inline: true },
      { name: 'Total size', value: totalSize(backups), inline: true },
    ],
  });
}

export function formatBackupList(backups: Backup[]): Post {
  if (!backups.length) return embed({ title: 'Backups', description: 'No backups found.', color: COLORS.orange });
  const lines = backups.slice(0, 10).map((b) => `\`${b.name}\` ${formatBytes(b.size)}`);
  return embed({
    title: `Backups: ${backups.length}, ${totalSize(backups)} total`,
    description: truncate(lines.join('\n'), DESCRIPTION),
    color: COLORS.blue,
  });
}

export function formatSummary(serverName: string, s: Summary): Post {
  const top = s.top.map((p, i) => `${i + 1}. **${md(p.player)}**: ${formatDuration(p.ms)}`).join('\n') || 'Nobody played.';
  return embed({
    title: title(`📊 ${serverName}: ${s.day}`),
    color: COLORS.blue,
    fields: [
      { name: 'Uptime', value: pct(s.uptime), inline: true },
      { name: 'Peak players', value: s.peak === null ? 'n/a' : String(s.peak), inline: true },
      { name: 'Unique players', value: String(s.unique), inline: true },
      { name: 'Total playtime', value: formatDuration(s.totalMs), inline: true },
      { name: 'Starts', value: String(s.starts), inline: true },
      { name: 'Crashes', value: String(s.crashes), inline: true },
      { name: 'Top players', value: truncate(top, FIELD), inline: false },
    ],
  });
}

/** The bot's custom status: one segment per server, e.g. "GTNH: 3 online · 20 TPS". */
export function formatPresence(states: ServerState[]): string {
  const part = (s: ServerState) => {
    if (!s.online) return `${stripCodes(s.name)}: offline`;
    if (s.hung) return `${stripCodes(s.name)}: not responding`;
    return `${stripCodes(s.name)}: ${s.players.length} online${s.tps === null ? '' : ` · ${Math.round(s.tps)} TPS`}`;
  };
  return truncate(states.map(part).join(' | '), 128);
}

/** A channel topic for one server. TPS is rounded so the text (and the rate-limited edit) changes less often. */
export function formatTopic(s: ServerState): string {
  if (!s.online) return '🔴 Offline';
  if (s.hung) return '🟠 Not responding';
  const tps = s.tps === null ? '' : ` · ${Math.round(s.tps)} TPS`;
  const n = s.players.length;
  const who = n ? `: ${s.players.join(', ')}` : '';
  return truncate(`🟢 Online${tps} · ${n} player${n === 1 ? '' : 's'}${who}`, 1024);
}

export type TopicEdit = { text: string; at: number };
/** Discord allows 2 topic edits per channel per 10 minutes. */
export const TOPIC_MIN_GAP_MS = 5 * 60_000;

/** Whether a channel topic should be edited to `text` now, given the last edit. */
export function topicDue(last: TopicEdit | undefined, text: string, now: number): boolean {
  return !last || (last.text !== text && now - last.at >= TOPIC_MIN_GAP_MS);
}
````

`hub/src/discord.ts`:

```ts
import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
  type Webhook,
} from 'discord.js';
import { basename } from 'node:path';
import { listBackups, type BackupWatcher } from './backups.ts';
import { findCrashLogs } from './crashlogs.ts';
import type { Db } from './db.ts';
import {
  formatBackupList,
  formatBackupStatus,
  formatEvent,
  formatNotice,
  formatOutput,
  formatPlayers,
  formatPlaytime,
  formatPresence,
  formatStatus,
  formatSummary,
  formatTop,
  formatTopic,
  md,
  TOP_PERIODS,
  topicDue,
  type Post,
  type TopicEdit,
} from './format.ts';
import type { RestartScheduler } from './restarts.ts';
import type { HubEvent, ServerHub } from './servers.ts';
import type { Summary } from './summary.ts';

export type DiscordConfig = {
  guildId: string;
  adminRoleId: string;
  /** serverId -> channelId */
  channels: Record<string, string>;
  /** serverId -> server folder, for crash-log uploads */
  dirs: Record<string, string>;
  /** serverId -> ServerUtilities backup folder */
  backupDirs: Record<string, string>;
};

export type DiscordFrontend = {
  client: Client;
  /** Posts a hub-core notice (restarts, backups) to the server's channel. */
  notice: (serverId: string, text: string) => void;
  summary: (serverId: string, s: Summary) => void;
};

const DAY = 24 * 60 * 60 * 1000;
const WEBHOOK_NAME = 'GTNH Relay';
const CRASH_LOG_WINDOW_MS = 10 * 60_000;
// Discord API error codes.
const UNKNOWN_WEBHOOK = 10015;
const MISSING_PERMISSIONS = 50013;
const INVALID_FORM_BODY = 50035; // e.g. a webhook username containing "discord"

const ADMIN_COMMANDS = new Set(['cmd', 'restart', 'backup']);

// Admin commands are hidden (default_member_permissions "0") until the admin role is allowed under
// Server Settings → Integrations; the adminRoleId check below still applies either way.
export const COMMANDS = [
  new SlashCommandBuilder().setName('status').setDescription('Server status, TPS and uptime'),
  new SlashCommandBuilder().setName('list').setDescription('Players online'),
  new SlashCommandBuilder()
    .setName('playtime')
    .setDescription("A player's playtime and when they were last seen")
    .addStringOption((o) => o.setName('player').setDescription('Minecraft name').setRequired(true)),
  new SlashCommandBuilder()
    .setName('top')
    .setDescription('Top players by playtime')
    .addStringOption((o) =>
      o
        .setName('period')
        .setDescription('Default: last 7 days')
        .addChoices(
          { name: 'last 24 hours', value: 'day' },
          { name: 'last 7 days', value: 'week' },
          { name: 'all time', value: 'all' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('cmd')
    .setDescription('Run a server console command (admin role only)')
    .setDefaultMemberPermissions(0)
    .addStringOption((o) => o.setName('command').setDescription('Command, without the leading /').setRequired(true)),
  new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restart the server with an in-game countdown (admin role only)')
    .setDefaultMemberPermissions(0)
    .addSubcommand((s) =>
      s
        .setName('in')
        .setDescription('Schedule a restart')
        .addIntegerOption((o) =>
          o.setName('minutes').setDescription('Countdown length (0 = now)').setMinValue(0).setMaxValue(60).setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancel the scheduled restart')),
  new SlashCommandBuilder()
    .setName('backup')
    .setDescription('ServerUtilities backups (admin role only)')
    .setDefaultMemberPermissions(0)
    .addSubcommand((s) => s.setName('start').setDescription('Start a backup now and report when it finishes'))
    .addSubcommand((s) => s.setName('status').setDescription('Newest backup, count and total size'))
    .addSubcommand((s) => s.setName('list').setDescription('The 10 newest backups with sizes')),
].map((c) => c.toJSON());

/** Only people's own messages go into the game: not bots, webhooks (including our relay), or system notices. */
export function shouldRelay(m: Pick<Message, 'author' | 'webhookId' | 'system'>): boolean {
  return !m.author.bot && !m.webhookId && !m.system;
}

const errorCode = (err: unknown) => (err as { code?: number }).code;

export async function startDiscord(
  hub: ServerHub,
  db: Db,
  restarts: RestartScheduler,
  backups: BackupWatcher,
  cfg: DiscordConfig,
  token: string,
): Promise<DiscordFrontend> {
  const serverByChannel = new Map(Object.entries(cfg.channels).map(([serverId, channelId]) => [channelId, serverId]));
  const webhooks = new Map<string, Webhook>(); // serverId -> relay webhook
  const refusedNames = new Set<string>(); // player names Discord won't accept as a webhook username
  const topics = new Map<string, TopicEdit>(); // channelId -> last edit
  let presence = '';
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
    allowedMentions: { parse: [] }, // nothing the bot posts can ping anyone
  });

  async function post(serverId: string, message: Post, files: string[] = []): Promise<void> {
    const channelId = cfg.channels[serverId];
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId);
    if (channel?.isSendable()) await channel.send({ ...message, files });
  }

  const postSafe = (serverId: string, message: Post): void => {
    post(serverId, message).catch((err) => console.error(`[discord] post for ${serverId} failed:`, err));
  };

  // Game chat goes through the channel's webhook, with the player's name and skin; falls back to the bot.
  async function relayChat(e: Extract<HubEvent, { type: 'chat' }>): Promise<void> {
    const hook = webhooks.get(e.serverId);
    if (hook && !refusedNames.has(e.player)) {
      try {
        await hook.send({
          username: e.player,
          avatarURL: `https://mc-heads.net/avatar/${encodeURIComponent(e.player)}/64`,
          content: md(e.message),
          allowedMentions: { parse: [] },
        });
        return;
      } catch (err) {
        // A deleted webhook is forgotten; a refused name is remembered, so neither is retried per message.
        if (errorCode(err) === UNKNOWN_WEBHOOK) webhooks.delete(e.serverId);
        if (errorCode(err) === INVALID_FORM_BODY) refusedNames.add(e.player);
        console.warn(`[discord] webhook send failed, posting as the bot: ${(err as Error).message}`);
      }
    }
    await post(e.serverId, formatEvent(e)!);
  }

  async function postCrash(serverId: string, message: Post): Promise<void> {
    const files = cfg.dirs[serverId] ? await findCrashLogs(cfg.dirs[serverId], Date.now() - CRASH_LOG_WINDOW_MS) : [];
    const withNote: Post =
      files.length && 'embeds' in message
        ? { embeds: [{ ...message.embeds[0], description: `Crash logs attached: ${files.map((f) => basename(f)).join(', ')}` }] }
        : message;
    try {
      await post(serverId, withNote, files);
    } catch (err) {
      if (!files.length) throw err;
      console.warn(`[discord] crash log upload failed, posting without it: ${(err as Error).message}`);
      await post(serverId, message);
    }
  }

  hub.on('event', (e) => {
    if (e.type === 'chat') {
      relayChat(e).catch((err) => console.error('[discord] chat relay failed:', err));
      return;
    }
    const message = formatEvent(e);
    if (!message) return;
    if (e.type === 'crashed') postCrash(e.serverId, message).catch((err) => console.error('[discord] crash post failed:', err));
    else postSafe(e.serverId, message);
  });

  client.on(Events.MessageCreate, (m) => {
    const serverId = serverByChannel.get(m.channelId);
    if (!serverId || !shouldRelay(m)) return;
    const text = [m.cleanContent, ...m.attachments.map((a) => a.url)].join(' ');
    hub.say(serverId, m.member?.displayName ?? m.author.username, text);
  });

  client.on(Events.InteractionCreate, (i) => {
    if (!i.isChatInputCommand()) return;
    handleCommand(i).catch((err) => console.error('[discord] command failed:', err));
  });

  async function handleCommand(i: ChatInputCommandInteraction): Promise<void> {
    const serverId = serverByChannel.get(i.channelId);
    const state = serverId ? hub.get(serverId) : undefined;
    if (!serverId || !state) {
      await i.reply({ content: 'This channel is not linked to a server.', flags: MessageFlags.Ephemeral });
      return;
    }
    const now = Date.now();
    if (i.commandName === 'status') {
      await i.reply(formatStatus(state, db.uptime(serverId, now - DAY, now), db.uptime(serverId, now - 7 * DAY, now)));
      return;
    }
    if (i.commandName === 'list') {
      await i.reply(state.online ? formatPlayers(state.players) : formatNotice(`🔴 ${state.name} is offline`));
      return;
    }
    if (i.commandName === 'playtime') {
      const player = i.options.getString('player', true);
      await i.reply(
        formatPlaytime(
          player,
          db.playtime(serverId, player, 0, now),
          db.playtime(serverId, player, now - 7 * DAY, now),
          db.lastSeen(serverId, player),
          now,
        ),
      );
      return;
    }
    if (i.commandName === 'top') {
      const period = (i.options.getString('period') ?? 'week') as keyof typeof TOP_PERIODS;
      const from = period === 'day' ? now - DAY : period === 'week' ? now - 7 * DAY : 0;
      await i.reply(formatTop(period, db.top(serverId, from, now, 10)));
      return;
    }
    if (!ADMIN_COMMANDS.has(i.commandName)) return;
    if (!i.inCachedGuild() || !i.member.roles.cache.has(cfg.adminRoleId)) {
      await i.reply({ content: 'You need the admin role for this.', flags: MessageFlags.Ephemeral });
      return;
    }
    const audit = `discord:${i.user.username} (${i.user.id})`;
    if (i.commandName === 'cmd') {
      await i.deferReply(); // commands can take longer than Discord's 3 s reply window
      try {
        await i.editReply(formatOutput(await hub.runCommand(serverId, i.options.getString('command', true), audit)));
      } catch (err) {
        await i.editReply(`❌ ${(err as Error).message}`);
      }
    } else if (i.commandName === 'restart') {
      // The public announcement comes from the scheduler's notice; the reply is just for the admin.
      let reply: string;
      if (i.options.getSubcommand() === 'cancel') {
        reply = restarts.cancel(serverId, i.user.username) ? 'Restart cancelled.' : 'No restart is scheduled.';
      } else {
        try {
          restarts.schedule(serverId, i.options.getInteger('minutes', true), audit, i.user.username);
          reply = 'Restart scheduled.';
        } catch (err) {
          reply = `❌ ${(err as Error).message}`;
        }
      }
      await i.reply({ content: reply, flags: MessageFlags.Ephemeral });
    } else if (i.commandName === 'backup') {
      const dir = cfg.backupDirs[serverId];
      if (!dir) {
        await i.reply({ content: 'Set "dir" (or "backupDir") for this server in config.json.', flags: MessageFlags.Ephemeral });
        return;
      }
      const sub = i.options.getSubcommand();
      if (sub === 'status') {
        await i.reply(formatBackupStatus(await listBackups(dir), Date.now()));
      } else if (sub === 'list') {
        await i.reply(formatBackupList(await listBackups(dir)));
      } else {
        await i.deferReply();
        const since = Date.now();
        try {
          const output = await hub.runCommand(serverId, 'backup start', audit);
          backups.watch(serverId, since); // the "finished" notice follows in the channel
          await i.editReply(formatOutput(output));
        } catch (err) {
          await i.editReply(`❌ ${(err as Error).message}`);
        }
      }
    }
  }

  async function setupWebhooks(c: Client<true>): Promise<void> {
    for (const [serverId, channelId] of Object.entries(cfg.channels)) {
      try {
        const channel = await c.channels.fetch(channelId);
        if (channel?.type !== ChannelType.GuildText) continue;
        const existing = (await channel.fetchWebhooks()).find((h) => h.owner?.id === c.user.id && h.name === WEBHOOK_NAME);
        webhooks.set(serverId, existing ?? (await channel.createWebhook({ name: WEBHOOK_NAME })));
      } catch (err) {
        console.warn(`[discord] no chat webhook for ${serverId} (needs Manage Webhooks), posting as the bot: ${(err as Error).message}`);
      }
    }
  }

  function updatePresence(): void {
    const text = formatPresence(hub.list());
    if (text === presence) return;
    presence = text;
    client.user?.setPresence({ activities: [{ name: 'Custom Status', state: text, type: ActivityType.Custom }] });
  }

  async function updateTopics(): Promise<void> {
    const now = Date.now();
    for (const s of hub.list()) {
      const channelId = cfg.channels[s.id];
      const text = formatTopic(s);
      if (!channelId || !topicDue(topics.get(channelId), text, now)) continue;
      topics.set(channelId, { text, at: now }); // also on failure: don't retry until the text changes
      try {
        const channel = await client.channels.fetch(channelId);
        if (channel?.type === ChannelType.GuildText) await channel.setTopic(text);
      } catch (err) {
        const hint = errorCode(err) === MISSING_PERMISSIONS ? ' (the bot needs Manage Channels)' : '';
        console.warn(`[discord] topic update for ${s.id} failed${hint}: ${(err as Error).message}`);
      }
    }
  }

  client.once(Events.ClientReady, (c) => {
    console.log(`[discord] logged in as ${c.user.tag}`);
    c.guilds
      .fetch(cfg.guildId)
      .then((guild) => guild.commands.set(COMMANDS))
      .catch((err) => console.error('[discord] registering slash commands failed:', err));
    setupWebhooks(c).catch((err) => console.error('[discord] webhook setup failed:', err));
    updatePresence();
    setInterval(updatePresence, 30_000).unref();
    setInterval(() => void updateTopics(), 60_000).unref();
  });

  await client.login(token);
  return {
    client,
    notice: (serverId, text) => postSafe(serverId, formatNotice(text)),
    summary: (serverId, s) => postSafe(serverId, formatSummary(hub.get(serverId)?.name ?? serverId, s)),
  };
}
```

`hub/src/index.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BackupWatcher, listBackups } from './backups.ts';
import { everyDay, parseDaily } from './daily.ts';
import { Db, type State } from './db.ts';
import { startDiscord } from './discord.ts';
import { PlaytimeTracker } from './playtime.ts';
import { RestartScheduler } from './restarts.ts';
import { ServerHub, type Lifecycle, type ServerConfig } from './servers.ts';
import { buildSummary } from './summary.ts';

type Config = {
  listenPort: number;
  dbPath: string;
  guildId: string;
  adminRoleId: string;
  servers: (ServerConfig & {
    channelId: string;
    dir?: string;
    dailyRestart?: string;
    dailySummary?: string;
    backupDir?: string;
    backupMaxAgeHours?: number;
  })[];
};

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error('DISCORD_TOKEN is not set');
const config = JSON.parse(readFileSync(process.argv[2] ?? 'config.json', 'utf8')) as Config;
for (const s of config.servers) {
  if (s.dailySummary !== undefined && !parseDaily(s.dailySummary)) {
    throw new Error(`server "${s.id}": dailySummary must be HH:MM (24-hour), got "${s.dailySummary}"`);
  }
}
const backupDirs: Record<string, string> = Object.fromEntries(
  config.servers.flatMap((s) => {
    const dir = s.backupDir ?? (s.dir ? join(s.dir, 'backups') : undefined);
    return dir ? [[s.id, dir]] : [];
  }),
);

const db = new Db(config.dbPath);
db.markHubRestart(config.servers.map((s) => s.id)); // also ends sessions left open when the hub last stopped
setInterval(() => db.touch(), 60_000);

const hub = new ServerHub(config.servers);
const STATES = new Map<Lifecycle, State>([
  ['connected', 'up'],
  ['started', 'up'],
  ['recovered', 'up'],
  ['stopped', 'down'],
  ['crashed', 'down'],
  ['hung', 'down'],
  ['offline', 'down'],
]);
hub.on('event', (e) => {
  const state = STATES.get(e.type as Lifecycle);
  if (state) db.record(e.serverId, state, e.type);
});

// Hub-core notices go to Discord, which is connected below; until then they go nowhere.
let notice: (serverId: string, text: string) => void = () => {};
const notify = (serverId: string, text: string) => notice(serverId, text);
const restarts = new RestartScheduler(hub, notify);
for (const s of config.servers) if (s.dailyRestart) restarts.daily(s.id, s.dailyRestart); // throws on a bad time
const backups = new BackupWatcher((serverId) => listBackups(backupDirs[serverId] ?? ''), notify);
for (const s of config.servers) {
  if (s.backupMaxAgeHours && backupDirs[s.id]) backups.watchdog(s.id, s.backupMaxAgeHours);
}
const playtime = new PlaytimeTracker(hub, db);

const port = await hub.listen(config.listenPort);
console.log(`[hub] listening on 127.0.0.1:${port}`);
playtime.start();

const discord = await startDiscord(
  hub,
  db,
  restarts,
  backups,
  {
    guildId: config.guildId,
    adminRoleId: config.adminRoleId,
    channels: Object.fromEntries(config.servers.map((s) => [s.id, s.channelId])),
    dirs: Object.fromEntries(config.servers.flatMap((s) => (s.dir ? [[s.id, s.dir]] : []))),
    backupDirs,
  },
  token,
);
notice = discord.notice;
const summaries = config.servers.flatMap((s) =>
  s.dailySummary ? [everyDay(s.dailySummary, 0, (target) => discord.summary(s.id, buildSummary(db, s.id, target)))] : [],
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    restarts.stop();
    backups.stop();
    playtime.stop();
    for (const cancel of summaries) cancel();
    void discord.client.destroy();
    void hub.close().finally(() => {
      db.close();
      process.exit(0);
    });
  });
}
```

`hub/config.example.json`:

```json
{
  "listenPort": 25580,
  "dbPath": "hub.db",
  "guildId": "YOUR_DISCORD_SERVER_ID",
  "adminRoleId": "ROLE_ID_ALLOWED_TO_USE_CMD",
  "servers": [
    {
      "id": "gtnh",
      "name": "GTNH",
      "token": "CHANGE_ME_TO_A_LONG_RANDOM_STRING",
      "channelId": "CHANNEL_ID_FOR_THIS_SERVER",
      "dir": "/home/opc/GTNH",
      "dailyRestart": "06:00",
      "dailySummary": "09:00",
      "backupMaxAgeHours": 26
    }
  ]
}
```

- [ ] **Step 4: Verify**

Run: `cd hub && npm test && npm run typecheck`
Expected: `ℹ pass 86`, `ℹ fail 0`, and `tsc` prints nothing.

Smoke check:
```bash
cd hub && cp config.example.json config.json
DISCORD_TOKEN=bogus timeout 10 node src/index.ts           # "[hub] listening …", then TokenInvalid
sed 's/"09:00"/"9am"/' config.example.json > bad.json
DISCORD_TOKEN=bogus timeout 10 node src/index.ts bad.json  # dailySummary must be HH:MM, and no "listening"
node -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('hub.db').prepare(\"select name from sqlite_master where type='table'\").all().map(r=>r.name).join(','))"
                                                          # events,meta,sessions,peaks
rm -f config.json bad.json hub.db
```

- [ ] **Step 5: Commit**

```bash
git add hub/src/format.ts hub/src/discord.ts hub/src/index.ts hub/config.example.json hub/test/format.test.ts hub/test/discord.test.ts
git commit -m "feat(hub): embeds, /playtime, /top, /backup, daily summary; webhook name cache, clearer topic warning"
```

---

### Task 5: Mod — async command output and stale outbox

**Files:**
- Create: `mod/src/main/java/io/github/edwardpratt/gtnhdiscord/CommandOutput.java`
- Modify: `mod/src/main/java/io/github/edwardpratt/gtnhdiscord/GameEvents.java`, `GtnhDiscord.java`, `HubClient.java`
- Test: `mod/src/test/java/io/github/edwardpratt/gtnhdiscord/CommandOutputTest.java`, `HubClientTest.java`

**Interfaces:**
- Produces:
  - `CommandOutput(id, now)` with `add(line, now)`, `ready(now)`, `lines()` and the constants `QUIET_MS = 1500`, `MAX_MS = 8000`
  - `GameEvents.flushPending()`
  - `HubClient.dropNonLifecycle(Deque<JsonObject>)`, package-private

- [ ] **Step 1: Write the failing tests**

`mod/src/test/java/io/github/edwardpratt/gtnhdiscord/CommandOutputTest.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Arrays;

import org.junit.jupiter.api.Test;

class CommandOutputTest {

    @Test
    void readyAfterAQuietWindowEvenWithNoOutput() {
        CommandOutput out = new CommandOutput("1", 0);
        assertFalse(out.ready(CommandOutput.QUIET_MS - 1));
        assertTrue(out.ready(CommandOutput.QUIET_MS));
        assertEquals(
            0,
            out.lines()
                .size());
    }

    @Test
    void eachNewLineRestartsTheQuietWindow() {
        CommandOutput out = new CommandOutput("1", 0);
        out.add("a", 1000);
        assertFalse(out.ready(2000));
        out.add("b", 2000);
        assertFalse(out.ready(3000));
        assertTrue(out.ready(2000 + CommandOutput.QUIET_MS));
        assertEquals(Arrays.asList("a", "b"), out.lines());
    }

    @Test
    void alwaysReadyByTheMaxWindow() {
        CommandOutput out = new CommandOutput("1", 0);
        for (long t = 0; t < CommandOutput.MAX_MS; t += 500) out.add("line", t);
        assertFalse(out.ready(CommandOutput.MAX_MS - 1));
        assertTrue(out.ready(CommandOutput.MAX_MS));
    }

    @Test
    void acceptsLinesFromAnotherThread() throws InterruptedException {
        // Like spark: the reply comes from a worker thread after the command call returned.
        final CommandOutput out = new CommandOutput("1", System.currentTimeMillis());
        Thread worker = new Thread(
            () -> { for (int i = 0; i < 1000; i++) out.add("line " + i, System.currentTimeMillis()); });
        worker.start();
        worker.join();
        assertEquals(
            1000,
            out.lines()
                .size());
        assertEquals(
            "line 999",
            out.lines()
                .get(999));
    }
}
```

`mod/src/test/java/io/github/edwardpratt/gtnhdiscord/HubClientTest.java`, the full file (the `droppingStaleLines…` test is at the end):

```java
package io.github.edwardpratt.gtnhdiscord;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.function.BooleanSupplier;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import com.google.gson.JsonObject;

class HubClientTest {

    /** Plays the hub's side of the protocol over a real socket. */
    static class FakeHub implements AutoCloseable {

        final ServerSocket server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
        Socket socket;
        BufferedReader in;
        Writer out;

        FakeHub() throws IOException {
            server.setSoTimeout(5000);
        }

        void accept() throws IOException {
            socket = server.accept();
            socket.setSoTimeout(5000);
            in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
            out = new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8);
        }

        JsonObject read() throws IOException {
            return HubClient.parse(in.readLine());
        }

        void write(String json) throws IOException {
            out.write(json + "\n");
            out.flush();
        }

        JsonObject handshake() throws IOException {
            accept();
            JsonObject hello = read();
            write("{\"type\":\"welcome\"}");
            return hello;
        }

        @Override
        public void close() throws IOException {
            if (socket != null) socket.close();
            server.close();
        }
    }

    FakeHub hub;
    HubClient client;

    @BeforeEach
    void setUp() throws IOException {
        hub = new FakeHub();
        client = new HubClient("127.0.0.1", hub.server.getLocalPort(), "gtnh", "secret-token-0123", "test");
        client.minBackoffMs = 50;
        client.maxBackoffMs = 200;
    }

    @AfterEach
    void tearDown() throws IOException {
        client.stop(1000);
        hub.close();
    }

    static JsonObject msg(String type) {
        JsonObject o = new JsonObject();
        o.addProperty("type", type);
        return o;
    }

    static void waitUntil(BooleanSupplier cond) throws InterruptedException {
        long end = System.currentTimeMillis() + 5000;
        while (!cond.getAsBoolean()) {
            if (System.currentTimeMillis() > end) throw new AssertionError("condition not met in time");
            Thread.sleep(10);
        }
    }

    @Test
    void handshakesThenSendsAndReceives() throws Exception {
        client.start();
        JsonObject hello = hub.handshake();
        assertEquals("hello", HubClient.str(hello, "type"));
        assertEquals("gtnh", HubClient.str(hello, "serverId"));
        assertEquals("secret-token-0123", HubClient.str(hello, "token"));
        assertEquals(
            1,
            hello.get("protocol")
                .getAsInt());
        waitUntil(client::isConnected);

        JsonObject chat = msg("chat");
        chat.addProperty("player", "Steve");
        chat.addProperty("message", "hi");
        client.send(chat);
        assertEquals(chat, hub.read());

        hub.write("{\"type\":\"say\",\"author\":\"Bob\",\"message\":\"yo\"}");
        waitUntil(() -> client.poll() != null);
    }

    @Test
    void whileDisconnectedKeepsOnlyLifecycleMessages() throws Exception {
        client.send(msg("chat"));
        client.send(msg("heartbeat"));
        client.send(msg("started"));
        client.start();
        hub.handshake();
        assertEquals("started", HubClient.str(hub.read(), "type"));
        waitUntil(client::isConnected);
        client.send(msg("join"));
        assertEquals("join", HubClient.str(hub.read(), "type"));
    }

    @Test
    void dropsOldestWhenOutboxIsFull() throws Exception {
        for (int i = 0; i <= HubClient.MAX_OUTBOX; i++) {
            JsonObject m = msg("started");
            m.addProperty("seq", i);
            client.send(m);
        }
        client.start();
        hub.handshake();
        assertEquals(
            1,
            hub.read()
                .get("seq")
                .getAsInt()); // seq 0 was dropped
    }

    @Test
    void reconnectsAfterTheHubDropsTheConnection() throws Exception {
        client.start();
        hub.handshake();
        waitUntil(client::isConnected);
        hub.socket.close();
        waitUntil(() -> !client.isConnected());
        hub.handshake();
        waitUntil(client::isConnected);
    }

    @Test
    void refusedConnectionStaysDisconnected() throws Exception {
        client.start();
        hub.accept();
        hub.read();
        hub.write("{\"type\":\"reject\",\"reason\":\"bad token\"}");
        assertNull(hub.in.readLine()); // client hangs up
        assertFalse(client.isConnected());
    }

    @Test
    void stopFlushesQueuedMessagesThenCloses() throws Exception {
        client.start();
        hub.handshake();
        waitUntil(client::isConnected);
        client.send(msg("stopping"));
        client.stop(2000);
        assertEquals("stopping", HubClient.str(hub.read(), "type"));
        assertNull(hub.in.readLine());
        assertTrue(!client.isConnected());
    }

    @Test
    void sendAfterStopNeverReachesTheHubOrReconnects() throws Exception {
        client.start();
        hub.handshake();
        waitUntil(client::isConnected);
        client.stop(2000);
        assertNull(hub.in.readLine());
        client.send(msg("stopping")); // what the JVM shutdown hook does after a clean /stop or a crash
        client.stop(2000);
        hub.server.setSoTimeout(500);
        assertThrows(SocketTimeoutException.class, hub.server::accept);
    }

    @Test
    void stopWithZeroTimeoutReturnsEvenIfTheHubNeverAnswers() throws Exception {
        client.start();
        hub.accept();
        hub.read(); // hello arrives, but no welcome is ever sent: the client is blocked reading
        assertTimeoutPreemptively(Duration.ofSeconds(2), () -> client.stop(0));
    }

    @Test
    void droppingStaleLinesKeepsOnlyLifecycleMessages() {
        java.util.Deque<JsonObject> queue = new java.util.ArrayDeque<>();
        queue.add(msg("chat"));
        queue.add(msg("started"));
        queue.add(msg("heartbeat"));
        queue.add(msg("stopping"));
        HubClient.dropNonLifecycle(queue);
        assertEquals(2, queue.size());
        assertEquals("started", HubClient.str(queue.pollFirst(), "type"));
        assertEquals("stopping", HubClient.str(queue.pollFirst(), "type"));
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd mod && ./gradlew --console=plain test`
Expected: FAIL at `compileTestJava`, with `cannot find symbol … class CommandOutput` and `… method dropNonLifecycle`.

- [ ] **Step 3: Implement**

`mod/src/main/java/io/github/edwardpratt/gtnhdiscord/CommandOutput.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import java.util.ArrayList;
import java.util.List;

/**
 * The replies to one {@code /cmd}. Some mods (spark) answer from a worker thread after the command has returned,
 * so lines can arrive from any thread; the result is sent once replies go quiet or a hard limit passes. No
 * Minecraft classes, so it is unit-testable.
 */
final class CommandOutput {

    /** Send once this long passes without a new line (counted from the start if there are none yet). */
    static final long QUIET_MS = 1500;
    /** Always send by now: below the hub's 10 s command timeout. */
    static final long MAX_MS = 8000;

    final String id;
    private final long startedAt;
    private final List<String> lines = new ArrayList<>();
    private long lastLineAt;

    CommandOutput(String id, long now) {
        this.id = id;
        this.startedAt = now;
        this.lastLineAt = now;
    }

    synchronized void add(String line, long now) {
        lines.add(line);
        lastLineAt = now;
    }

    synchronized boolean ready(long now) {
        return now - lastLineAt >= QUIET_MS || now - startedAt >= MAX_MS;
    }

    synchronized List<String> lines() {
        return new ArrayList<>(lines);
    }
}
```

`mod/src/main/java/io/github/edwardpratt/gtnhdiscord/GameEvents.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

import net.minecraft.entity.player.EntityPlayerMP;
import net.minecraft.network.rcon.RConConsoleSource;
import net.minecraft.server.MinecraftServer;
import net.minecraft.stats.StatisticsFile;
import net.minecraft.util.ChatComponentText;
import net.minecraft.util.ChatStyle;
import net.minecraft.util.EnumChatFormatting;
import net.minecraft.util.IChatComponent;
import net.minecraft.util.MathHelper;
import net.minecraftforge.event.ServerChatEvent;
import net.minecraftforge.event.entity.living.LivingDeathEvent;
import net.minecraftforge.event.entity.player.AchievementEvent;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

import cpw.mods.fml.common.eventhandler.EventPriority;
import cpw.mods.fml.common.eventhandler.SubscribeEvent;
import cpw.mods.fml.common.gameevent.PlayerEvent;
import cpw.mods.fml.common.gameevent.TickEvent;

/**
 * Game-side half of the bridge. Registered on both buses by {@link GtnhDiscord}: chat/death/achievement are Forge-bus
 * events, login/logout/tick are FML-bus events. Everything here runs on the server thread.
 */
public class GameEvents {

    private static final long HEARTBEAT_MS = 5000;

    private final HubClient client;
    private long lastHeartbeat;
    /** Commands still collecting replies. Server thread only (the replies themselves may come from any thread). */
    private final List<CommandOutput> pending = new ArrayList<>();

    GameEvents(HubClient client) {
        this.client = client;
    }

    static JsonObject msg(String type, String... keyValues) {
        JsonObject o = new JsonObject();
        o.addProperty("type", type);
        for (int i = 0; i + 1 < keyValues.length; i += 2) o.addProperty(keyValues[i], keyValues[i + 1]);
        return o;
    }

    // LOWEST priority + canceled events not received: muted chat and prevented deaths are not relayed.
    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onChat(ServerChatEvent e) {
        client.send(msg("chat", "player", e.username, "message", e.message));
    }

    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onDeath(LivingDeathEvent e) {
        if (!(e.entityLiving instanceof EntityPlayerMP)) return;
        EntityPlayerMP player = (EntityPlayerMP) e.entityLiving;
        // Same call vanilla EntityPlayerMP.onDeath uses for the death broadcast.
        String text = player.func_110142_aN()
            .func_151521_b()
            .getUnformattedText();
        client.send(msg("death", "player", player.getCommandSenderName(), "message", text));
    }

    @SubscribeEvent(priority = EventPriority.LOWEST)
    public void onAchievement(AchievementEvent e) {
        if (!(e.entityPlayer instanceof EntityPlayerMP)) return;
        // Fires on every trigger; only report a real first unlock.
        StatisticsFile stats = ((EntityPlayerMP) e.entityPlayer).func_147099_x();
        if (stats.hasAchievementUnlocked(e.achievement) || !stats.canUnlockAchievement(e.achievement)) return;
        String name = e.achievement.func_150951_e()
            .getUnformattedText();
        client.send(msg("achievement", "player", e.entityPlayer.getCommandSenderName(), "achievement", name));
    }

    @SubscribeEvent
    public void onLogin(PlayerEvent.PlayerLoggedInEvent e) {
        client.send(msg("join", "player", e.player.getCommandSenderName()));
    }

    @SubscribeEvent
    public void onLogout(PlayerEvent.PlayerLoggedOutEvent e) {
        client.send(msg("leave", "player", e.player.getCommandSenderName()));
    }

    @SubscribeEvent
    public void onTick(TickEvent.ServerTickEvent e) {
        if (e.phase != TickEvent.Phase.END) return;
        try {
            MinecraftServer server = MinecraftServer.getServer();
            JsonObject in;
            while ((in = client.poll()) != null) handle(server, in);
            long now = System.currentTimeMillis();
            for (Iterator<CommandOutput> it = pending.iterator(); it.hasNext();) {
                CommandOutput out = it.next();
                if (out.ready(now)) {
                    sendResult(out);
                    it.remove();
                }
            }
            // Sent from the tick so that a frozen tick loop stops heartbeats (that is how the hub spots a hang).
            if (now - lastHeartbeat >= HEARTBEAT_MS) {
                lastHeartbeat = now;
                client.send(heartbeat(server));
            }
        } catch (RuntimeException ex) {
            GtnhDiscord.LOG.error("Discord bridge tick failed", ex);
        }
    }

    private void handle(MinecraftServer server, JsonObject in) {
        String type = HubClient.str(in, "type");
        if (type.equals("say")) {
            IChatComponent line = new ChatComponentText("");
            line.appendSibling(
                new ChatComponentText("[Discord] ").setChatStyle(new ChatStyle().setColor(EnumChatFormatting.BLUE)));
            line.appendSibling(
                new ChatComponentText("<" + HubClient.str(in, "author") + "> " + HubClient.str(in, "message")));
            server.getConfigurationManager()
                .sendChatMsg(line);
        } else if (type.equals("cmd")) {
            final CommandOutput output = new CommandOutput(HubClient.str(in, "id"), System.currentTimeMillis());
            // Vanilla's RCON sender: op-level, real world and coordinates. We only capture its replies per line,
            // including ones that arrive later from another thread (the result waits for them; see CommandOutput).
            RConConsoleSource sender = new RConConsoleSource() {

                @Override
                public String getCommandSenderName() {
                    return "Discord";
                }

                @Override
                public void addChatMessage(IChatComponent message) {
                    output.add(message.getUnformattedText(), System.currentTimeMillis());
                }
            };
            server.getCommandManager()
                .executeCommand(sender, HubClient.str(in, "command"));
            pending.add(output);
        }
    }

    /** Sends every pending command result now, ready or not: on shutdown ticks stop, so they'd never go. */
    void flushPending() {
        for (CommandOutput out : pending) sendResult(out);
        pending.clear();
    }

    private void sendResult(CommandOutput out) {
        JsonObject result = msg("cmdResult", "id", out.id);
        JsonArray lines = new JsonArray();
        for (String s : out.lines()) lines.add(new JsonPrimitive(s));
        result.add("output", lines);
        client.send(result);
    }

    private static JsonObject heartbeat(MinecraftServer server) {
        double msPerTick = MathHelper.average(server.tickTimeArray) * 1.0E-6D; // tickTimeArray is nanoseconds
        JsonObject o = msg("heartbeat");
        o.addProperty("tps", Math.min(20.0, 1000.0 / Math.max(msPerTick, 0.001)));
        JsonArray players = new JsonArray();
        for (String name : server.getAllUsernames()) players.add(new JsonPrimitive(name));
        o.add("players", players);
        return o;
    }
}
```

`mod/src/main/java/io/github/edwardpratt/gtnhdiscord/GtnhDiscord.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import net.minecraftforge.common.MinecraftForge;
import net.minecraftforge.common.config.Configuration;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

import cpw.mods.fml.common.FMLCommonHandler;
import cpw.mods.fml.common.Mod;
import cpw.mods.fml.common.event.FMLPreInitializationEvent;
import cpw.mods.fml.common.event.FMLServerStartedEvent;
import cpw.mods.fml.common.event.FMLServerStartingEvent;
import cpw.mods.fml.common.event.FMLServerStoppedEvent;
import cpw.mods.fml.common.event.FMLServerStoppingEvent;

@Mod(
    modid = GtnhDiscord.MODID,
    version = Tags.VERSION,
    name = "GTNH Discord",
    acceptedMinecraftVersions = "[1.7.10]",
    acceptableRemoteVersions = "*")
public class GtnhDiscord {

    public static final String MODID = "gtnhdiscord";
    public static final Logger LOG = LogManager.getLogger(MODID);

    private String hubHost;
    private int hubPort;
    private String serverId;
    private String token;
    private HubClient client;
    private GameEvents events;

    @Mod.EventHandler
    public void preInit(FMLPreInitializationEvent event) {
        Configuration config = new Configuration(event.getSuggestedConfigurationFile());
        String general = Configuration.CATEGORY_GENERAL;
        hubHost = config.getString("hubHost", general, "127.0.0.1", "Address of the gtnh-discord hub");
        hubPort = config.getInt("hubPort", general, 25580, 1, 65535, "TCP port of the hub");
        serverId = config.getString("serverId", general, "gtnh", "This server's id in the hub's config.json");
        token = config.getString("token", general, "", "This server's token from the hub's config.json");
        if (config.hasChanged()) config.save();
    }

    @Mod.EventHandler
    public void serverStarting(FMLServerStartingEvent event) {
        if (!event.getServer()
            .isDedicatedServer()) return;
        if (token.isEmpty()) {
            LOG.warn("No token set in config/gtnhdiscord.cfg - Discord bridge disabled");
            return;
        }
        client = new HubClient(hubHost, hubPort, serverId, token, Tags.VERSION);
        events = new GameEvents(client);
        MinecraftForge.EVENT_BUS.register(events);
        FMLCommonHandler.instance()
            .bus()
            .register(events);
        client.start();
        // SIGTERM (systemctl stop, Ctrl+C): vanilla's shutdown hook calls stopServer() directly, so
        // FMLServerStoppingEvent never fires. Announce the stop here too. Harmless after a clean /stop or a crash:
        // the client is already stopped, so this send is never delivered.
        final HubClient c = client;
        Runtime.getRuntime()
            .addShutdownHook(new Thread(() -> announceStop(c), "GTNHDiscord-shutdown"));
    }

    @Mod.EventHandler
    public void serverStarted(FMLServerStartedEvent event) {
        if (client != null) client.send(GameEvents.msg("started"));
    }

    @Mod.EventHandler
    public void serverStopping(FMLServerStoppingEvent event) {
        if (client == null) return;
        events.flushPending(); // e.g. `/cmd stop` gets its output before the connection closes
        announceStop(client);
    }

    /** Queues `stopping` and flushes it before the JVM can exit, so a clean stop never looks like a crash. */
    private static void announceStop(HubClient c) {
        c.send(GameEvents.msg("stopping"));
        c.stop(2000);
    }

    @Mod.EventHandler
    public void serverStopped(FMLServerStoppedEvent event) {
        if (client == null) return;
        client.stop(0); // no-op after a clean stop; after a crash, drops the connection right away
        MinecraftForge.EVENT_BUS.unregister(events);
        FMLCommonHandler.instance()
            .bus()
            .unregister(events);
        client = null;
        events = null;
    }
}
```

`mod/src/main/java/io/github/edwardpratt/gtnhdiscord/HubClient.java`:

```java
package io.github.edwardpratt.gtnhdiscord;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Deque;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.TimeUnit;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * Line-delimited JSON connection to the hub. Runs on its own daemon threads and never touches Minecraft classes, so
 * the game thread only ever calls {@link #send} and {@link #poll}.
 */
public class HubClient {

    static final int MAX_OUTBOX = 1000;
    private static final Logger LOG = LogManager.getLogger("gtnhdiscord");

    private final String host;
    private final int port;
    private final JsonObject hello = new JsonObject();
    private final LinkedBlockingDeque<JsonObject> outbox = new LinkedBlockingDeque<>();
    private final ConcurrentLinkedQueue<JsonObject> inbox = new ConcurrentLinkedQueue<>();
    private volatile boolean running;
    private volatile boolean connected;
    private volatile Socket socket;
    private Thread thread;
    long minBackoffMs = 1000;
    long maxBackoffMs = 30_000;

    public HubClient(String host, int port, String serverId, String token, String modVersion) {
        this.host = host;
        this.port = port;
        hello.addProperty("type", "hello");
        hello.addProperty("protocol", 1);
        hello.addProperty("serverId", serverId);
        hello.addProperty("token", token);
        hello.addProperty("modVersion", modVersion);
    }

    public synchronized void start() {
        if (running) return;
        running = true;
        thread = new Thread(this::run, "GTNHDiscord-hub");
        thread.setDaemon(true);
        thread.start();
    }

    /**
     * Queues a message for the hub. While disconnected only started/stopping are kept, so a hub outage never replays
     * stale chat. The queue is bounded: when full, the oldest message is dropped.
     */
    public void send(JsonObject msg) {
        if (!connected && !isLifecycle(msg)) return;
        synchronized (outbox) {
            if (outbox.size() >= MAX_OUTBOX) outbox.pollFirst();
            outbox.offerLast(msg);
        }
    }

    private static boolean isLifecycle(JsonObject msg) {
        String type = str(msg, "type");
        return type.equals("started") || type.equals("stopping");
    }

    /** After a connection ends, only started/stopping survive: other lines would be stale by the next connection. */
    static void dropNonLifecycle(Deque<JsonObject> queue) {
        synchronized (queue) {
            queue.removeIf(msg -> !isLifecycle(msg));
        }
    }

    /** Next message from the hub, or null. */
    public JsonObject poll() {
        return inbox.poll();
    }

    public boolean isConnected() {
        return connected;
    }

    /**
     * Writes out whatever is queued (waiting at most timeoutMs; 0 = don't wait), then disconnects for good. Safe to
     * call twice.
     */
    public void stop(long timeoutMs) {
        running = false;
        Thread t = thread;
        if (t == null) return;
        t.interrupt();
        try {
            if (timeoutMs > 0) t.join(timeoutMs); // join(0) would wait forever
        } catch (InterruptedException e) {
            Thread.currentThread()
                .interrupt();
        }
        closeQuietly(socket);
    }

    private void run() {
        long backoff = minBackoffMs;
        while (running) {
            try (Socket s = new Socket()) {
                socket = s;
                s.connect(new InetSocketAddress(host, port), 5000);
                Writer out = new BufferedWriter(new OutputStreamWriter(s.getOutputStream(), StandardCharsets.UTF_8));
                BufferedReader in = new BufferedReader(
                    new InputStreamReader(s.getInputStream(), StandardCharsets.UTF_8));
                writeLine(out, hello.toString());
                JsonObject reply = parse(in.readLine());
                if (reply != null && "welcome".equals(str(reply, "type"))) {
                    connected = true;
                    backoff = minBackoffMs;
                    LOG.info("Connected to hub at {}:{}", host, port);
                    Thread reader = new Thread(() -> readLoop(s, in), "GTNHDiscord-hub-reader");
                    reader.setDaemon(true);
                    reader.start();
                    writeLoop(s, out);
                } else {
                    LOG.error("Hub refused connection: {}", reply == null ? "no reply" : str(reply, "reason"));
                    backoff = maxBackoffMs;
                }
            } catch (IOException e) {
                if (running) LOG.warn("Hub connection failed: {}", e.getMessage());
            } finally {
                connected = false;
                dropNonLifecycle(outbox);
            }
            if (!running) return;
            try {
                Thread.sleep(backoff);
            } catch (InterruptedException e) {
                return;
            }
            backoff = Math.min(backoff * 2, maxBackoffMs);
        }
    }

    private void writeLoop(Socket s, Writer out) throws IOException {
        while (running && !s.isClosed()) {
            JsonObject msg;
            try {
                msg = outbox.pollFirst(200, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                continue; // stop() interrupts us; the loop condition sees running == false
            }
            if (msg != null) writeLine(out, msg.toString());
        }
        if (s.isClosed()) throw new IOException("connection closed by hub");
        JsonObject msg;
        while ((msg = outbox.pollFirst()) != null) writeLine(out, msg.toString()); // stopping: flush what's left
    }

    private void readLoop(Socket s, BufferedReader in) {
        try {
            String line;
            while ((line = in.readLine()) != null) {
                JsonObject msg = parse(line);
                if (msg != null) inbox.add(msg);
            }
        } catch (IOException ignored) {} finally {
            closeQuietly(s);
        }
    }

    private static void writeLine(Writer out, String line) throws IOException {
        out.write(line);
        out.write('\n');
        out.flush();
    }

    static JsonObject parse(String line) {
        if (line == null) return null;
        try {
            JsonElement e = new JsonParser().parse(line);
            return e.isJsonObject() ? e.getAsJsonObject() : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    static String str(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e != null && e.isJsonPrimitive() ? e.getAsString() : "";
    }

    private static void closeQuietly(Socket s) {
        if (s == null) return;
        try {
            s.close();
        } catch (IOException ignored) {}
    }
}
```

- [ ] **Step 4: Verify**

Run:
```bash
cd mod && ./gradlew --console=plain spotlessApply build
grep -ho 'tests="[0-9]*" skipped="[0-9]*" failures="[0-9]*" errors="[0-9]*"' build/test-results/test/*.xml
git diff --stat -- src   # only the four files above plus the two tests: the SIGTERM hook and v1 tests must be untouched
```
Expected: `BUILD SUCCESSFUL`, and two result lines, `tests="9" …failures="0" errors="0"` (HubClientTest) and `tests="4" …` (CommandOutputTest).

- [ ] **Step 5: Commit**

```bash
git add mod/src
git commit -m "feat(mod): /cmd waits for async replies (spark), flushes them on stop; drop stale outbox lines"
```

---

### Task 6: Docs, Node 24 check and manual smoke test

**Files:**
- Modify: `README.md`, `hub/CLAUDE.md`, `mod/CLAUDE.md`, `docs/ROADMAP.md` (mark v1.2a done)

- [ ] **Step 1: Update the docs**

`README.md`, the full file:

````markdown
# gtnh-discord

Talk to your GT: New Horizons servers from Discord: two-way chat, console
commands, status, and start/stop/crash alerts.

```
[GTNH server] ─ gtnhdiscord mod ─┐
[GTNH server] ─ gtnhdiscord mod ─┼─ TCP 127.0.0.1:25580 ─> hub (Node) ─> Discord
                                 ┘                              └─ SQLite uptime log
```

| Directory | What | Toolchain |
|---|---|---|
| `mod/` | Server-side Forge 1.7.10 mod. Relays game events, runs commands. | JDK 25, Gradle wrapper |
| `hub/` | The bot. Owns server state and uptime, talks to Discord. | Node 24+ |
| `deploy/` | systemd units for running both on one server. | systemd |
| `docs/` | Design spec and implementation plan. | — |

## Setup

### 1. Discord application

1. <https://discord.com/developers/applications> → **New Application** → **Bot**.
   Copy the bot token.
2. On the **Bot** page enable **Message Content Intent**. Without it the bot
   receives empty messages and Discord → game chat does nothing.
3. **OAuth2 → URL Generator**: scopes `bot` and `applications.commands`;
   permissions *View Channels*, *Send Messages*, *Read Message History*,
   *Attach Files*, *Manage Webhooks* (player-skin chat) and *Manage Channels*
   (live status in the channel topic). Open the URL and add the bot to your
   Discord server. Without the last two, chat posts as the bot and topics
   stay unchanged; everything else works.
   Already added the bot? Give its role those permissions under
   Server Settings → Roles instead.
4. In Discord, enable *Settings → Advanced → Developer Mode*, then right-click
   to **Copy ID** of: your Discord server (guild), the channel for each game
   server, and the role allowed to use `/cmd`.
5. `/cmd` and `/restart` are hidden from everyone by default. Show them to the
   admin role under Server Settings → Integrations → your bot → each command.
   The admin-role check still applies either way.

### 2. Hub

```bash
cd hub
npm ci
cp config.example.json config.json
openssl rand -hex 24          # one token per game server
$EDITOR config.json           # guildId, adminRoleId, and per server: id, name, token, channelId
echo 'DISCORD_TOKEN=<bot token>' > .env
set -a; . ./.env; set +a; npm start
```

`config.json` and `.env` are git-ignored. To run it permanently, see
[Running on a server](#running-on-a-server).

### 3. Mod

```bash
cd mod
./gradlew build
```

Copy `build/libs/gtnhdiscord-<version>.jar` (not `-dev` or `-sources`) into the
server's `mods/` folder. Clients don't need it. Start the server once to create
`config/gtnhdiscord.cfg`, then set the id and token from the hub's
`config.json`:

```
general {
    S:hubHost=127.0.0.1
    I:hubPort=25580
    S:serverId=gtnh
    S:token=<token from hub config.json>
}
```

Restart the server. The hub logs the connection, and the channel gets
"✅ Server started".

## Running on a server

`deploy/` has systemd units for running the hub and the GTNH server together on
one Linux machine. Edit `User=`/`SocketUser=` and the paths in the files first.

```bash
sudo install -m 600 -o root -g root hub/.env /etc/gtnh-discord.env   # bot token, root-only
sudo cp deploy/gtnh-hub.service deploy/gtnh.service deploy/gtnh.socket /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gtnh-hub gtnh
```

These work with SELinux enforcing (the default on RHEL/Oracle Linux): the token
lives in `/etc` rather than `/home`, and the server runs without tmux, which
SELinux doesn't let services start. If `gtnh.socket` fails with "Permission
denied" (SELinux blocking systemd from its own console FIFO), install the small
policy module in `deploy/gtnh-fifo.te`, which allows exactly that and nothing else:

```bash
checkmodule -M -m -o /tmp/gtnh-fifo.mod deploy/gtnh-fifo.te
semodule_package -o /tmp/gtnh-fifo.pp -m /tmp/gtnh-fifo.mod
sudo semodule -i /tmp/gtnh-fifo.pp
```

- **Hub logs:** `journalctl -u gtnh-hub -f`
- **Server console output:** `journalctl -u gtnh -f` (add yourself to the
  `systemd-journal` group to read it without sudo)
- **Server console input:** `echo "say hello" > /run/gtnh.stdin`, or `/cmd` from Discord
- **Stopping the server:** `sudo systemctl stop gtnh` stops it for maintenance.
  An in-game `/stop`, or `/cmd stop` from Discord, restarts it. So does a crash.
- **Start order doesn't matter:** the mod reconnects to the hub within about 30 s.

**Ports.** Only Minecraft needs to be reachable from outside:

- **Bot:** the bot only makes outbound connections to Discord (HTTPS), so it
  needs no inbound port.
- **Hub:** it listens on `127.0.0.1:25580`. **Don't open 25580**: that
  connection is only protected by its token.
- **Minecraft (25565/tcp)** on Oracle Cloud must be opened in two places:
  1. **OCI console:** VCN → Security List (or NSG) → an ingress rule for
     `0.0.0.0/0`, TCP 25565.
  2. **The host firewall:**
     `sudo firewall-cmd --permanent --add-port=25565/tcp && sudo firewall-cmd --reload`

## Using it

- Chat in the linked channel appears in game as `[Discord] <name> message`.
  In-game chat posts with each player's name and skin head; joins, leaves,
  deaths and achievements post as the bot.
- The bot's status and each channel's topic show who's online and the TPS.
  Topics update at most every 5 minutes (a Discord limit).
- `/status` shows online state, TPS, player count and 24 h / 7 d uptime.
  Alerts, status, stats and backups post as embeds; chat stays plain text.
- `/list` shows online players.
- `/playtime <player>` shows total playtime, the last 7 days and when they were
  last seen; `/top [day|week|all]` ranks players by playtime.
- `/cmd <command>` runs a console command and shows its output. Admin role only.
  Every command is logged by the hub. The reply takes about 1.5 s: it waits for
  mods such as spark that answer a moment later.
- `/restart in <minutes>` restarts with in-game warnings at 10 / 5 / 1 min,
  30 s and 10 s; `/restart cancel` calls it off. Admin role only. Add
  `"dailyRestart": "06:00"` to a server in `config.json` for a daily restart
  at that local time (the countdown starts 10 minutes before).
- Alerts: started, stopped, went down unexpectedly (crash or kill), not
  responding (no heartbeat for 30 s), responding again. With `"dir"` set to
  the server's folder in `config.json`, a crash alert comes with the crash
  report and JVM error log (`hs_err_pid*.log`) attached.
- `/backup start` starts a ServerUtilities backup and posts when it has
  finished; `/backup status` shows the newest backup, the count and the total
  size; `/backup list` shows the 10 newest. Admin role only. Backups are read
  from `"backupDir"`, or `<dir>/backups` if that isn't set. With
  `"backupMaxAgeHours": 26`, the bot warns once if no new backup appears for
  that long.
- `"dailySummary": "09:00"` posts yesterday's stats every day at that time:
  uptime, peak and unique players, total playtime, top players, starts and
  crashes.

Adding another game server: add an entry to `servers` in `config.json`,
restart the hub, and install the mod with that entry's `serverId` and token.

## Development

```bash
cd hub && npm test && npm run typecheck
cd mod && ./gradlew spotlessApply build   # build runs the JUnit tests
```

The wire protocol and design are in
`docs/superpowers/specs/2026-09-24-gtnh-discord-design.md`. What's planned next is in `docs/ROADMAP.md`.
````

`hub/CLAUDE.md`, the full file:

````markdown
# hub

Node 24+ (tested on 24.21 and 26.9) + TypeScript + discord.js 14. Node runs `.ts` directly (type stripping) — there is no build step.

```bash
npm test            # node --test "test/*.test.ts"
npm run typecheck   # tsc, noEmit
npm start           # node src/index.ts; reads ./config.json (or argv[2]) and env DISCORD_TOKEN
```

## TypeScript constraints (type stripping)

- Erasable syntax only: no `enum`, `namespace`, or constructor parameter properties.
- Relative imports include the `.ts` extension; type-only imports use `import type` / `type X`.

## Modules

| File | Job |
|---|---|
| `src/protocol.ts` | Wire types + `parseModLine` validation. The contract with the mod. |
| `src/servers.ts` | `ServerHub`: TCP server, per-server state, liveness (crash/stop/hung), `say`, `runCommand`, `event` emitter. The API frontends use. |
| `src/db.ts` | SQLite (`node:sqlite`): up/down/unknown log and uptime math; player sessions, daily peaks and stats queries. Writes never throw. |
| `src/daily.ts` | `everyDay(time, leadMs, fn(target))`: DST-safe daily timers (used by restarts and the summary). Hub core. |
| `src/units.ts` | `formatDuration`, `formatBytes`, `localDay` (local calendar, not UTC). Hub core. |
| `src/playtime.ts` | `PlaytimeTracker`: syncs sessions with each server's live player list every 10 s. Hub core. |
| `src/summary.ts` | `buildSummary`: yesterday's stats, from the scheduled time. Hub core. |
| `src/backups.ts` | `listBackups`, `BackupWatcher` (finish notices, missing-backup watchdog). Hub core. |
| `src/restarts.ts` | `RestartScheduler`: countdown restarts (in-game `say` warnings, then `stop`) and daily restarts. Hub core. |
| `src/crashlogs.ts` | `findCrashLogs`: newest crash report / `hs_err_pid*.log` in a server folder. Hub core. |
| `src/format.ts` | Pure Discord output: `Post` = plain text or embeds; `md`, `format*`, `topicDue`. Unit-tested. |
| `src/discord.ts` | Discord frontend: webhook chat, alerts (+ crash-log uploads), presence, topics, notices as embeds, `/status` `/list` `/playtime` `/top` `/cmd` `/restart` `/backup`. |
| `src/index.ts` | Config loading and wiring only. |

A future web dashboard goes in `src/web/` and calls `ServerHub` and `RestartScheduler` — never the mod sockets.
Hub-core modules (`servers`, `restarts`, `crashlogs`, `db`) must not import `discord.js` or `format.ts`.

## Dependencies

Runtime: `discord.js` only. Prefer Node built-ins (`node:net`, `node:readline`, `node:sqlite`,
`node:test`, `node:crypto`) over adding packages.

## Trust boundaries (do not weaken)

- Mod input: every line goes through `parseModLine` (checks `Object.hasOwn` on the type and field types).
  Tokens ≥16 chars, compared with `timingSafeEqual`. Hub binds `127.0.0.1`.
- Discord → MC: `ServerHub.say` cleans text with `mcText` (strips `§` codes/control chars, caps 256).
- MC → Discord: `md()` escapes markdown incl. headings/masked links; the Client uses
  `allowedMentions: { parse: [] }` so nothing the bot posts can ping.
- `/cmd`: admin role check + `deferReply`; `runCommand` logs who ran it.

## Tests

`test/servers.test.ts` drives a real socket with a fake mod (`fakeMod`, `online`, `until` helpers) — use it
for any hub behaviour change. Keep timing-sensitive tests on small `HubOptions` timeouts, not sleeps of seconds.
````

`mod/CLAUDE.md`, the full file:

````markdown
# mod (gtnhdiscord)

Server-side-only Forge 1.7.10 mod, built from the GTNewHorizons ExampleMod1.7.10 template
(RetroFuturaGradle, Gradle 9.3.1). Package `io.github.edwardpratt.gtnhdiscord`, modid `gtnhdiscord`.

```bash
./gradlew spotlessApply build   # spotless is enforced; build also runs the JUnit 5 tests
./gradlew test
```

- Needs a full JDK 25 (`javac`). The jar to deploy is the newest `build/libs/gtnhdiscord-<version>.jar`
  (not `-dev`/`-sources`); version comes from `git describe`.
- Don't edit `build.gradle.kts`; project settings go in `gradle.properties` / `dependencies.gradle`.
- Checkstyle rejects wildcard imports.

## Java 8 runtime

`enableModernJavaSyntax = jabel`: modern *syntax* compiles to Java 8 bytecode, but Java 9+ *APIs*
(`List.of`, `String.isBlank`, …) will crash on Java 8 servers. Gson is 2.2.4: use `new JsonParser().parse(...)`
and `JsonArray.add(JsonElement)`.

## Minecraft names

MCP stable-12 mappings. Some methods have no readable name and must be called by SRG name, e.g.
`func_110142_aN()` (combat tracker), `func_151521_b()` (death message), `func_147099_x()` (stats file),
`func_150951_e()` (achievement name). Check signatures in the decompiled sources at
`build/rfg/minecraft-src/java/` (present after the first build) instead of guessing.

## Rules

- `HubClient` must not touch Minecraft classes (keeps it unit-testable; it runs on its own threads).
- Game state is only touched on the server thread: inbound `say`/`cmd` are drained in
  `ServerTickEvent` (phase END), which also emits the heartbeat. Never block the tick on I/O.
- Event buses: `ServerChatEvent`, `LivingDeathEvent`, `AchievementEvent` → `MinecraftForge.EVENT_BUS`;
  `PlayerLoggedIn/Out`, `TickEvent` → `FMLCommonHandler.instance().bus()`. `GameEvents` is registered on both.
- `HubClient.stop(0)` must return immediately (crash path); `stop(2000)` flushes `stopping` on clean shutdown.
- A clean stop is announced from two places: `FMLServerStoppingEvent` (`/stop`) and a JVM shutdown hook
  (SIGTERM — vanilla's hook bypasses the FML event). Both go through `announceStop`.
- `/cmd` output is collected in a `CommandOutput` until replies go quiet (1.5 s) or 8 s pass, because some mods
  (spark) reply from a worker thread after the command returns. `serverStopping` calls `flushPending()` first.
- The outbox holds `JsonObject`s; when a connection ends, `dropNonLifecycle` keeps only `started`/`stopping`.

## Tests

`HubClientTest` plays the hub over a real `ServerSocket`. `GameEvents`/`GtnhDiscord` can only be verified by
the manual smoke test on a real GTNH server (see the plan's final task).
````

In `docs/ROADMAP.md`, change `## v1.2a — in progress (hub + small mod update, no protocol change)` to `## v1.2a — done (hub + small mod update, no protocol change)`.

- [ ] **Step 2: Run the suite on Node 24 too**

```bash
cd hub && npm test && npm run typecheck
V=v24.21.0; T=$(mktemp -d)
curl -fsSL https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz | tar -xJ -C "$T"
"$T/node-$V-linux-x64/bin/node" --test "test/*.test.ts"; rm -rf "$T"
```
Expected: `ℹ pass 86`, `ℹ fail 0` on both.

- [ ] **Step 3: Commit and push**

```bash
git add README.md hub/CLAUDE.md mod/CLAUDE.md docs/ROADMAP.md
git commit -m "docs: v1.2a commands, config and module notes"
git push -u origin feat/v1.2a
```

- [ ] **Step 4: Manual smoke test on the real server (with the user)**

Deploy:
1. `git pull`, then `npm ci` in `hub/`.
2. Add `dailySummary` / `backupMaxAgeHours` (and `backupDir` if needed) to `config.json`.
3. Build the mod: `cd mod && ./gradlew build`.
4. `sudo systemctl stop gtnh`, copy the newest `build/libs/gtnhdiscord-*.jar` (not `-dev`/`-sources`) over the old one in the server's `mods/`, then `sudo systemctl start gtnh`.
5. `sudo systemctl restart gtnh-hub`.

Check:
1. **Spark:** `/cmd spark tps` shows spark's TPS output, after about 1.5 s. This is the first check.
2. **Plain commands:** `/cmd list` still works, after about 1.5 s.
3. **Embeds:** `/status`, `/list` and the lifecycle alerts post as coloured embeds; chat stays plain.
4. **Stats:** after a few minutes online, `/playtime <you>` shows time and "online now", and `/top week` lists you.
5. **Backups:** `/backup start` → ServerUtilities' reply, then later "✅ Backup finished: … (size, duration)". `/backup status` and `/backup list` show the count and total size.
6. **Summary:** set `dailySummary` to about 3 minutes from now, restart the hub, and the summary embed posts. Then set it back.
7. **Stop during collection:** `/cmd stop` shows its output, and the server restarts.
8. **Old history kept:** after the upgrade, `/status` still shows uptime from before it.

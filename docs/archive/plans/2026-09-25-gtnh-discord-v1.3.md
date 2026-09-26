# GTNH Discord v1.3 Implementation Plan

> **For agentic workers:** work task by task, in order; each task ends green and committed. Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** operations: independent hub/mod releases from git tags, CI, a protocol version range, a restore script,
backup disk-space warnings and growth, `hub.db` upkeep, a liveness ping and `npm run check-config`.

**Architecture:** there are two new hub-core modules, `config.ts` (the `Config` type, `validateConfig`,
`loadConfig`) and `health.ts` (`startPinger`), plus a `check-config.ts` entry point. `backups.ts` gains free space
and growth. `db.ts` gains `maintain`. `index.ts` loses its inline validation and wires the new pieces. The mod
changes only its build (version from `mod-v*` tags). New `deploy/restore-backup.sh` with a bash test, and
`.github/workflows/ci.yml` + `release.yml`.

**Tech stack:** as for v1.2b. Nothing new at runtime. CI uses `actions/checkout`, `setup-node`, `setup-java`,
`gradle/actions/setup-gradle`, `upload-artifact`/`download-artifact` (all `@v4`) and `gh`.

**Spec:** `docs/superpowers/specs/2026-09-25-gtnh-discord-v1.3-design.md` · **ADR:** `docs/adr/0001-monorepo-independent-versions.md`

**Precondition:** branch `feat/v1.3` (from `main` at `6bdce14`, plus the v1.3 spec and this plan); the hub
suite is at 108 passing tests.

## Verified while planning

- **Mod versioning (spec's open question): works.** With `gtnh.modules.gitVersion = false` and
  `extra["modVersion"]` set in `build.gradle.kts`, the plugin picks it up: a throwaway `mod-v9.9.9` tag gave
  `gtnhdiscord-9.9.9-dev.jar`. A `hub-v9.9.10` tag on the same commit didn't leak in. With no mod tag,
  `0.0.0-<hash>`. The generated `Tags.VERSION`, which the hello sends as `modVersion`, follows. Setting only
  `version` fails the build ("Cannot get property 'modVersion' on extra properties").
- **`client.isReady()` stays `true` through reconnects** (discord.js 14.27: it checks the manager's status,
  set to `Ready` once). Use the shards' status: `client.ws.shards.every((s) => s.status === Status.Ready)`.
  `Status` is exported by `discord.js`.
- **`VACUUM INTO ?`** accepts a bound file path in `node:sqlite`, including from a `:memory:` database.
- `unzip -Zt x.zip` prints `N files, <bytes> bytes uncompressed, …`: the byte count is field 3.

## Global constraints

- Protocol stays `1`. `MIN_PROTOCOL` is new, and also `1`.
- Hub: erasable TypeScript only, relative imports end in `.ts`, dependencies unchanged.
- Hub-core modules (now also `config`, `health`) must not import `discord.js` or `format.ts`.
- Filesystem and network work is best-effort and logged; `Db` methods never throw.
- `./gradlew spotlessApply` before `build`. Hub must pass on Node 24 and 26.
- Every commit message ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```
- **Don't push tags or branches.** Pushing is the user's call (Task 10).

---

### Task 1: Mod version from `mod-v*` tags; tag past releases locally

**Files:** Modify `mod/gradle.properties`, `mod/build.gradle.kts`, `mod/CLAUDE.md`.

- [ ] **Step 1:** In `mod/gradle.properties`, directly after `autoUpdateBuildScript = false`, add:

```properties
# Version comes from mod-v* tags only (build.gradle.kts), so hub-v* tags can't leak in (docs/adr/0001).
gtnh.modules.gitVersion = false
```

- [ ] **Step 2:** Append to `mod/build.gradle.kts`:

```kotlin

// Version from the nearest mod-v* tag only (docs/adr/0001): "1.3.0" on the tag, "1.3.0-2-g<hash>" after it,
// "-dirty" with uncommitted changes, "0.0.0-<hash>" with no mod tag yet.
val gitDescribe = providers.exec {
    commandLine("git", "describe", "--tags", "--match", "mod-v*", "--dirty", "--always")
    isIgnoreExitValue = true
}.standardOutput.asText.get().trim()
val modVersion = if (gitDescribe.startsWith("mod-v")) gitDescribe.removePrefix("mod-v") else "0.0.0-$gitDescribe"
version = modVersion
extra["modVersion"] = modVersion // read by the gtnh plugin for the jar name and Tags.VERSION
```

- [ ] **Step 3: Tag the past releases (local only):**

```bash
for p in hub mod; do
  git tag "$p-v1.0.0" 17fc0e1; git tag "$p-v1.1.0" 07823d6; git tag "$p-v1.2.0" 6bdce14
done
```

- [ ] **Step 4: Verify.** `cd mod && ./gradlew spotlessApply build`, then `ls -t build/libs | head -3`. Expect
  `gtnhdiscord-1.2.0-<n>-g<hash>-dirty…` (dirty until committed). Then run
  `grep VERSION build/generated/sources/gradleTokens/*/*/Tags.java` or
  `find build -name Tags.java | xargs grep VERSION` and check it shows the same version.

- [ ] **Step 5:** In `mod/CLAUDE.md`, replace `version comes from \`git describe\`.` with
  `version comes from the nearest \`mod-v*\` tag (\`build.gradle.kts\`; hub tags are ignored, see docs/adr/0001).`

- [ ] **Step 6:** Commit: `build(mod): version from mod-v* tags only`.

---

### Task 2: Protocol version range

**Files:** Modify `hub/src/protocol.ts`, `hub/src/servers.ts`, `hub/test/servers.test.ts`.

- [ ] **Step 1: Failing test.** In `hub/test/servers.test.ts`, replace the test
  `'rejects an unsupported protocol version'` with:

```ts
test('accepts only protocol versions in the supported range', async (t) => {
  const { port } = await setup(t);
  for (const protocol of [0, 2, 1.5]) {
    const mod = fakeMod(port);
    mod.send(hello(TOKEN, protocol));
    const reply = (await mod.next()) as { type: string; reason: string };
    assert.equal(reply.type, 'reject');
    assert.equal(reply.reason, `protocol ${protocol} not supported (hub speaks 1)`);
    await mod.closed;
  }
});
```

Run `npm test`. This already passes: the current `!== 1` check rejects all three with the same message.
The test pins that behaviour while the check becomes a range, so it still counts as the first step.

- [ ] **Step 2:** In `hub/src/protocol.ts`, after `export const PROTOCOL_VERSION = 1;`:

```ts
/**
 * Oldest mod protocol the hub still accepts. Policy (docs/adr/0001): the hub supports the current and the
 * previous version, so servers can update their mods one at a time.
 */
export const MIN_PROTOCOL = 1;
```

- [ ] **Step 3:** In `hub/src/servers.ts`, import `MIN_PROTOCOL` alongside `PROTOCOL_VERSION`. Then replace
  the version check in `#checkHello` with:

```ts
    const p = hello.protocol;
    if (!Number.isInteger(p) || p < MIN_PROTOCOL || p > PROTOCOL_VERSION) {
      const speaks = MIN_PROTOCOL === PROTOCOL_VERSION ? `${PROTOCOL_VERSION}` : `${MIN_PROTOCOL}–${PROTOCOL_VERSION}`;
      return `protocol ${p} not supported (hub speaks ${speaks})`;
    }
```

- [ ] **Step 4:** `npm test && npm run typecheck`. All green (108). Commit:
  `feat(hub): accept a range of protocol versions`.

---

### Task 3: `config.ts` and `npm run check-config`

**Files:** Create `hub/src/config.ts`, `hub/src/check-config.ts`, `hub/test/config.test.ts`. Modify
`hub/src/index.ts`, `hub/package.json`, `hub/config.example.json`.

- [ ] **Step 1: Failing tests.** `hub/test/config.test.ts`:

```ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, validateConfig } from '../src/config.ts';

const ID = '123456789012345678';

function valid(dir: string) {
  return {
    listenPort: 25580,
    dbPath: 'hub.db',
    guildId: ID,
    adminRoleId: ID,
    healthcheckUrl: 'https://hc-ping.com/abc',
    servers: [
      {
        id: 'gtnh',
        name: 'GTNH',
        token: 'a-long-enough-token',
        channelId: ID,
        dir,
        dailyRestart: '06:00',
        dailySummary: '09:00',
        backupMaxAgeHours: 26,
        backupMinFreeGB: 10,
        lagTps: 15,
        lagMinutes: 2,
        lagAlerts: true,
        quests: 'batched',
      },
    ],
  };
}

test('a valid config has no errors', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.deepEqual(validateConfig(valid(dir)), []);
});

test('validateConfig reports every problem at once, with where it is', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const c = valid(dir);
  const second = { ...c.servers[0], name: 'Two', token: 'short' };
  Object.assign(c.servers[0], { dailyRestart: '6am', quests: 'loud', lagTps: 30, dir: join(dir, 'missing') });
  const bad = { ...c, guildId: 'abc', healthcheckUrl: 'ftp://x', servers: [c.servers[0], second] };
  assert.deepEqual(validateConfig(bad), [
    '"guildId" must be a Discord ID (17–20 digits)',
    '"healthcheckUrl" must be an http(s) URL',
    'server "gtnh": "dailyRestart" must be HH:MM (24-hour), got "6am"',
    'server "gtnh": "quests" must be one of batched, main, all, off',
    'server "gtnh": "lagTps" must be a number from 1 to 20',
    `server "gtnh": "dir" is not an existing folder: ${join(dir, 'missing')}`,
    'server "gtnh": duplicate id',
    'server "gtnh": "token" must be at least 16 characters',
  ]);
  assert.deepEqual(validateConfig([]), ['config must be a JSON object']);
  assert.deepEqual(validateConfig({}), [
    '"listenPort" must be a port number (1–65535)',
    '"dbPath" is required',
    '"guildId" is required',
    '"adminRoleId" is required',
    '"servers" must be a non-empty list',
  ]);
});

test('loadConfig throws one error listing every problem; check-config prints them and exits 1', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ ...valid(dir), guildId: 'x', adminRoleId: 'y' }));
  assert.throws(() => loadConfig(path), /2 problems:\n- "guildId" .*\n- "adminRoleId"/);
  await writeFile(join(dir, 'broken.json'), '{ nope');
  assert.throws(() => loadConfig(join(dir, 'broken.json')), /broken\.json: /);

  const run = (p: string) => execFileSync(process.execPath, ['src/check-config.ts', p], { encoding: 'utf8', stdio: 'pipe' });
  assert.throws(() => run(path), (err: { status: number; stderr: string }) => err.status === 1 && /"guildId"/.test(err.stderr));
  await writeFile(path, JSON.stringify(valid(dir)));
  assert.equal(run(path), `${path} OK\n`);
});
```

- [ ] **Step 2:** `hub/src/config.ts`:

```ts
import { readFileSync, statSync } from 'node:fs';
import { parseDaily } from './daily.ts';
import { QUEST_MODES, type QuestMode } from './quests.ts';
import type { ServerConfig } from './servers.ts';

export type ServerEntry = ServerConfig & {
  channelId: string;
  dir?: string;
  dailyRestart?: string;
  dailySummary?: string;
  backupDir?: string;
  backupMaxAgeHours?: number;
  backupMinFreeGB?: number;
  lagTps?: number;
  lagMinutes?: number;
  lagAlerts?: boolean;
  quests?: QuestMode;
};

export type Config = {
  listenPort: number;
  dbPath: string;
  guildId: string;
  adminRoleId: string;
  healthcheckUrl?: string;
  servers: ServerEntry[];
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const SNOWFLAKE = /^\d{17,20}$/;

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every problem with a parsed config.json, each prefixed with where it is; empty if it's valid. Offline. */
export function validateConfig(raw: unknown): string[] {
  if (!isObj(raw)) return ['config must be a JSON object'];
  const errors: string[] = [];
  const err = (where: string, msg: string) => errors.push(where ? `${where}: ${msg}` : msg);
  const str = (o: Obj, key: string, where: string, required = true): string | undefined => {
    const v = o[key];
    if (v === undefined) {
      if (required) err(where, `"${key}" is required`);
      return undefined;
    }
    if (typeof v !== 'string' || v === '') {
      err(where, `"${key}" must be a non-empty string`);
      return undefined;
    }
    return v;
  };
  const id = (o: Obj, key: string, where: string) => {
    const v = str(o, key, where);
    if (v !== undefined && !SNOWFLAKE.test(v)) err(where, `"${key}" must be a Discord ID (17–20 digits)`);
  };
  const num = (o: Obj, key: string, where: string, ok: (n: number) => boolean, rule: string) => {
    const v = o[key];
    if (v !== undefined && (typeof v !== 'number' || !ok(v))) err(where, `"${key}" must be ${rule}`);
  };

  const port = raw.listenPort;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    err('', '"listenPort" must be a port number (1–65535)');
  }
  str(raw, 'dbPath', '');
  id(raw, 'guildId', '');
  id(raw, 'adminRoleId', '');
  const url = str(raw, 'healthcheckUrl', '', false);
  if (url !== undefined && !/^https?:$/.test(URL.parse(url)?.protocol ?? '')) err('', '"healthcheckUrl" must be an http(s) URL');

  if (!Array.isArray(raw.servers) || raw.servers.length === 0) {
    err('', '"servers" must be a non-empty list');
    return errors;
  }
  const ids = new Set<string>();
  const tokens = new Set<string>();
  raw.servers.forEach((s: unknown, i: number) => {
    if (!isObj(s)) return err(`servers[${i}]`, 'must be an object');
    const sid = str(s, 'id', `servers[${i}]`);
    const where = sid === undefined ? `servers[${i}]` : `server "${sid}"`;
    str(s, 'name', where);
    id(s, 'channelId', where);
    for (const key of ['dailyRestart', 'dailySummary']) {
      const time = str(s, key, where, false);
      if (time !== undefined && !parseDaily(time)) err(where, `"${key}" must be HH:MM (24-hour), got "${time}"`);
    }
    if (s.quests !== undefined && !QUEST_MODES.includes(s.quests as QuestMode)) {
      err(where, `"quests" must be one of ${QUEST_MODES.join(', ')}`);
    }
    num(s, 'lagTps', where, (n) => n > 0 && n <= 20, 'a number from 1 to 20');
    num(s, 'lagMinutes', where, (n) => Number.isInteger(n) && n >= 1, 'a whole number of at least 1');
    num(s, 'backupMaxAgeHours', where, (n) => n > 0, 'a positive number');
    num(s, 'backupMinFreeGB', where, (n) => n > 0, 'a positive number');
    if (s.lagAlerts !== undefined && typeof s.lagAlerts !== 'boolean') err(where, '"lagAlerts" must be true or false');
    for (const key of ['dir', 'backupDir']) {
      const path = str(s, key, where, false);
      if (path !== undefined && !isDir(path)) err(where, `"${key}" is not an existing folder: ${path}`);
    }
    // Last, so a duplicate's own problems read first.
    if (sid !== undefined) {
      if (ids.has(sid)) err(where, 'duplicate id');
      ids.add(sid);
    }
    const token = str(s, 'token', where);
    if (token !== undefined) {
      if (token.length < 16) err(where, '"token" must be at least 16 characters');
      else if (tokens.has(token)) err(where, '"token" is the same as another server\'s');
      tokens.add(token);
    }
  });
  return errors;
}

/** Reads, parses and validates a config file; throws one error listing every problem. */
export function loadConfig(path: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`);
  }
  const errors = validateConfig(raw);
  if (errors.length) {
    throw new Error(`${path} has ${errors.length} problem${errors.length === 1 ? '' : 's'}:\n- ${errors.join('\n- ')}`);
  }
  return raw as Config;
}
```

`URL.parse` needs Node 22.1+, so it's fine on 24. Check that the expected order in the Step 1 test matches the
code's check order, and fix the **test** if they differ. The order in the code is the intended one.

- [ ] **Step 3:** `hub/src/check-config.ts`:

```ts
// npm run check-config [-- path]: validates config.json offline (no DISCORD_TOKEN, no network), same rules as startup.
import { loadConfig } from './config.ts';

const path = process.argv[2] ?? 'config.json';
try {
  loadConfig(path);
  console.log(`${path} OK`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
```

`hub/package.json` scripts: add `"check-config": "node src/check-config.ts"`.

- [ ] **Step 4:** Update `hub/src/index.ts`:
  - Delete the `Config` type, the `JSON.parse(readFileSync(...))` line and the `for (const s of config.servers) { … }`
    validation loop.
  - Replace them with `const config = loadConfig(process.argv[2] ?? 'config.json');` (import `loadConfig` from
    `./config.ts`). Keep the `DISCORD_TOKEN` check before it.
  - Drop `readFileSync`, `parseDaily` and `QUEST_MODES` from the imports if they're now unused. `RestartScheduler.daily`
    and the `ServerHub` token check keep their own guards: they're public-API checks.

- [ ] **Step 5:** `hub/config.example.json`: add `"healthcheckUrl": "https://hc-ping.com/YOUR-CHECK-UUID"` after
  `adminRoleId`, and `"backupMinFreeGB": 10` after `backupMaxAgeHours`. Then run
  `npm run check-config -- config.example.json`. Expect errors only for the placeholder IDs, and for `dir` if
  `/home/opc/GTNH` doesn't exist on this machine. That's the point of the tool.

- [ ] **Step 6:** `npm test && npm run typecheck`, then commit: `feat(hub): check-config, one validateConfig for startup and CLI`.

---

### Task 4: Backup free space and growth

**Files:** Modify `hub/src/backups.ts`, `hub/src/format.ts`, `hub/src/summary.ts`, `hub/src/discord.ts`,
`hub/src/index.ts`, `hub/test/backups.test.ts`, `hub/test/format.test.ts`.

- [ ] **Step 1: Failing tests.** In `hub/test/backups.test.ts`:
  - Import `growthPerDay`, `freeBytes`, `backupStats`.
  - Change `setup` to also inject free space:

```ts
function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000_000_000 });
  let backups: Backup[] = [];
  let free: number | null = 100 * GB;
  const notices: string[] = [];
  const watcher = new BackupWatcher(
    async () => backups,
    async () => free,
    (_id, text) => notices.push(text),
  );
  t.after(() => watcher.stop());
  return { watcher, notices, set: (b: Backup[]) => (backups = b), setFree: (f: number | null) => (free = f) };
}
```

  - Add `const GB = 1024 ** 3;` at the top.
  - In the existing watchdog test, change `watcher.watchdog('gtnh', 26)` to
    `watcher.watchdog('gtnh', { maxAgeHours: 26, minFreeGB: 10 })`.
  - Add:

```ts
test('growthPerDay compares the newest backup with the oldest, if a day or more apart', () => {
  const b = (size: number, hoursAgo: number) => ({ name: 'x.zip', size, mtimeMs: 1e12 - hoursAgo * 3600_000 });
  assert.equal(growthPerDay([b(3 * GB, 0), b(2 * GB, 24), b(1 * GB, 48)]), GB);
  assert.equal(growthPerDay([b(1 * GB, 0), b(2 * GB, 48)]), -GB / 2);
  assert.equal(growthPerDay([b(3 * GB, 0), b(1 * GB, 23)]), null);
  assert.equal(growthPerDay([]), null);
});

test('freeBytes and backupStats read the real folder, and never throw', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'backups-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, '2026-09-24-06-00-00.zip'), 'x'.repeat(10));
  assert.ok(((await freeBytes(dir)) ?? 0) > 0);
  assert.equal(await freeBytes(join(dir, 'missing')), null);
  const stats = await backupStats(dir);
  assert.deepEqual({ ...stats, free: stats.free !== null }, { count: 1, total: 10, free: true, growth: null });
});

test('the watchdog warns once about low disk space and re-arms when there is room again', async (t) => {
  const { watcher, notices, set, setFree } = setup(t);
  set([{ name: 'a.zip', size: 1, mtimeMs: Date.now() }]);
  setFree(5 * GB);
  watcher.watchdog('gtnh', { minFreeGB: 10 }); // no age limit
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(10 * MIN);
    await flush();
  }
  assert.deepEqual(notices, ['⚠️ Low disk space for backups: 5.0 GB free (limit 10 GB)']);
  setFree(20 * GB);
  t.mock.timers.tick(10 * MIN);
  await flush();
  setFree(null); // unreadable: no notice, no re-arm
  t.mock.timers.tick(10 * MIN);
  await flush();
  setFree(4 * GB);
  t.mock.timers.tick(10 * MIN);
  await flush();
  assert.equal(notices.length, 2);
  assert.match(notices[1], /4\.0 GB free/);
});
```

  If one `flush()` isn't enough (the check now awaits twice), make the helper
  `const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); };`.

- [ ] **Step 2:** `hub/src/backups.ts`:
  - Import `statfs` from `node:fs/promises` and `formatBytes` from `./units.ts`.
  - Add `const DAY = 24 * HOUR;`, `const GB = 1024 ** 3;` and `export const DEFAULT_MIN_FREE_GB = 10;`.
  - Add:

```ts
/** Bytes per day from the oldest backup to the newest (negative if shrinking); null if under a day apart. */
export function growthPerDay(backups: Backup[]): number | null {
  const newest = backups[0];
  const oldest = backups.at(-1);
  if (!newest || !oldest) return null;
  const days = (newest.mtimeMs - oldest.mtimeMs) / DAY;
  return days < 1 ? null : (newest.size - oldest.size) / days;
}

/** Free bytes (for non-root users) on the filesystem holding `dir`; null if it can't be read. Never throws. */
export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export type BackupStats = { count: number; total: number; free: number | null; growth: number | null };

export async function backupStats(dir: string): Promise<BackupStats> {
  const backups = await listBackups(dir);
  return {
    count: backups.length,
    total: backups.reduce((sum, b) => sum + b.size, 0),
    free: await freeBytes(dir),
    growth: growthPerDay(backups),
  };
}
```

  - `BackupWatcher`: the constructor takes `(list, free: (serverId: string) => Promise<number | null>, notify)`.
    Add a `#lowDisk = new Set<string>()`. `watchdog` becomes:

```ts
  /**
   * Every 10 minutes: warn once if the newest backup is older than `maxAgeHours` (when set), and once if free
   * space is under `minFreeGB`. Each re-arms when the problem clears.
   */
  watchdog(serverId: string, limits: { maxAgeHours?: number; minFreeGB: number }): void {
    clearInterval(this.#watchdogs.get(serverId));
    const check = async () => {
      if (limits.maxAgeHours !== undefined) {
        // … the existing age logic, unchanged, with maxAgeHours → limits.maxAgeHours
      }
      const free = await this.#free(serverId);
      if (free === null) return;
      if (free >= limits.minFreeGB * GB) {
        this.#lowDisk.delete(serverId);
      } else if (!this.#lowDisk.has(serverId)) {
        this.#lowDisk.add(serverId);
        this.#notify(serverId, `⚠️ Low disk space for backups: ${formatBytes(free)} free (limit ${limits.minFreeGB} GB)`);
      }
    };
    this.#watchdogs.set(serverId, setInterval(() => void check(), WATCHDOG_MS));
  }
```

  Update the class doc comment to mention the free-space warning.

- [ ] **Step 3: Format tests.** In `hub/test/format.test.ts`:
  - The backup status test calls `formatBackupStatus(backups, now, 50 * 1024 ** 3)`, and its expected fields
    gain `['Free disk', '50.0 GB']` and `['Growth', '+1.0 GB/day']` at the end (the two fixtures are 24 h and
    1 GB apart).
  - Add `assert.equal(first(formatBackupStatus([backups[0]], now, null)).fields!.at(-1)!.value, 'n/a');`: one
    backup, so growth is omitted and the last field is *Free disk*.
  - Add a summary test:

```ts
test('formatSummary adds a backups line when it has backup stats', () => {
  const base = { day: '2026-09-23', uptime: 1, peak: 1, unique: 1, totalMs: 0, top: [], starts: 0, crashes: 0 };
  const GB = 1024 ** 3;
  const withBackups = first(formatSummary('GTNH', { ...base, backups: { count: 2, total: 3 * GB, free: 50 * GB, growth: -GB } }));
  assert.deepEqual(withBackups.fields!.at(-1), { name: 'Backups', value: '2, 3.0 GB total, 50.0 GB free, −1.0 GB/day', inline: false });
  const noGrowth = first(formatSummary('GTNH', { ...base, backups: { count: 0, total: 0, free: null, growth: null } }));
  assert.equal(noGrowth.fields!.at(-1)!.value, '0, 0 B total, n/a free');
  assert.equal(first(formatSummary('GTNH', base)).fields!.at(-1)!.name, 'Top players');
});
```

  - [ ] **Step 4:** `hub/src/format.ts`:
  - Add a helper:
    `const formatGrowth = (g: number) => \`${g < 0 ? '−' : '+'}${formatBytes(Math.abs(g))}/day\`;`
  - `formatBackupStatus(backups, now, free: number | null)`:
    - After *Total size*, add `{ name: 'Free disk', value: free === null ? 'n/a' : formatBytes(free), inline: true }`.
    - Then, if `growthPerDay(backups)` isn't null, add `{ name: 'Growth', value: formatGrowth(g), inline: true }`.
    - Import `growthPerDay` from `./backups.ts`. `format.ts` already imports the `Backup` type from there.
  - `formatSummary`: when `s.backups` is set, append after *Top players*:

```ts
{ name: 'Backups', value: [`${b.count}`, `${formatBytes(b.total)} total`, `${b.free === null ? 'n/a' : formatBytes(b.free)} free`, ...(b.growth === null ? [] : [formatGrowth(b.growth)])].join(', '), inline: false }
```

- [ ] **Step 5:** In `hub/src/summary.ts`, the `Summary` type gains `backups?: BackupStats`, with
  `import type { BackupStats } from './backups.ts'`. `buildSummary` is unchanged.

- [ ] **Step 6:** `hub/src/discord.ts`, `/backup status`:
  `formatBackupStatus(await listBackups(dir), Date.now(), await freeBytes(dir))` (import `freeBytes`).

- [ ] **Step 7:** `hub/src/index.ts`:
  - Construct the watcher with both functions:

```ts
const backups = new BackupWatcher(
  (serverId) => listBackups(backupDirs[serverId] ?? ''),
  (serverId) => freeBytes(backupDirs[serverId] ?? ''),
  notify,
);
for (const s of config.servers) {
  if (backupDirs[s.id]) {
    backups.watchdog(s.id, { maxAgeHours: s.backupMaxAgeHours, minFreeGB: s.backupMinFreeGB ?? DEFAULT_MIN_FREE_GB });
  }
}
```

  - The daily summary adds the backup stats:

```ts
const summaries = config.servers.flatMap((s) =>
  s.dailySummary
    ? [
        everyDay(s.dailySummary, 0, (target) => {
          const summary = buildSummary(db, s.id, target);
          const dir = backupDirs[s.id];
          void (dir ? backupStats(dir) : Promise.resolve(undefined)).then((backups) =>
            discord.summary(s.id, { ...summary, backups }),
          );
        }),
      ]
    : [],
);
```

- [ ] **Step 8:** `npm test && npm run typecheck`, then commit: `feat(hub): backup free-space warning, growth and free space in status and summary`.

---

### Task 5: `hub.db` upkeep

**Files:** Modify `hub/src/db.ts`, `hub/src/index.ts`, `hub/test/db.test.ts`, `.gitignore`.

- [ ] **Step 1: Failing test** in `hub/test/db.test.ts` (add imports: `mkdir`, `mkdtemp`, `readdir`, `rm`, `writeFile`
  from `node:fs/promises`; `tmpdir`; `join`; `DatabaseSync` from `node:sqlite`):

```ts
test('maintain prunes old TPS samples, copies the database and keeps 7 copies', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'db-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const DAY = 24 * 3600_000;
  const now = new Date(2026, 8, 25, 4, 0).getTime();
  const db = new Db(':memory:');
  db.recordTps('gtnh', now - 91 * DAY, 20, null, null);
  db.recordTps('gtnh', now - 89 * DAY, 19, null, null);
  db.openSession('gtnh', 'Old', now - 400 * DAY);
  const copies = join(dir, 'db-backups');
  await mkdir(copies);
  for (let d = 1; d <= 8; d++) await writeFile(join(copies, `hub-2026-09-${String(d).padStart(2, '0')}.db`), '');
  await writeFile(join(copies, 'notes.txt'), '');

  db.maintain(copies, now);

  assert.deepEqual(db.tpsSince('gtnh', 0).map((r) => r.tps), [19]);
  assert.deepEqual((await readdir(copies)).sort(), [
    'hub-2026-09-03.db', 'hub-2026-09-04.db', 'hub-2026-09-05.db', 'hub-2026-09-06.db',
    'hub-2026-09-07.db', 'hub-2026-09-08.db', 'hub-2026-09-25.db', 'notes.txt',
  ]);
  const copy = new DatabaseSync(join(copies, 'hub-2026-09-25.db'));
  assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 1);
  copy.close();

  db.maintain(copies, now); // same day again: replaces today's copy, doesn't throw
  db.maintain(join(copies, 'notes.txt', 'x'), now); // a folder under a file (ENOTDIR): logged, doesn't throw
});
```

- [ ] **Step 2:** `hub/src/db.ts`:
  - Import `mkdirSync`, `readdirSync` and `rmSync` from `node:fs`, `join` from `node:path`, and `localDay` from `./units.ts`.
  - Add constants `const TPS_KEEP_MS = 90 * 24 * 60 * 60_000;` and `const COPIES_KEPT = 7;`.
  - Add a method:

```ts
  /**
   * Nightly upkeep: drops TPS samples older than 90 days (every other table is small and kept for all-time
   * stats), then writes a copy to `copyDir/hub-<local day>.db` and keeps the 7 newest copies. Never throws.
   */
  maintain(copyDir: string, now = Date.now()): void {
    this.#write('prune tps', 'DELETE FROM tps WHERE ts < ?', now - TPS_KEEP_MS);
    try {
      mkdirSync(copyDir, { recursive: true });
      const file = join(copyDir, `hub-${localDay(now)}.db`);
      rmSync(file, { force: true }); // VACUUM INTO refuses to overwrite
      this.#db.prepare('VACUUM INTO ?').run(file);
      const old = readdirSync(copyDir)
        .filter((n) => /^hub-\d{4}-\d{2}-\d{2}\.db$/.test(n))
        .sort()
        .reverse()
        .slice(COPIES_KEPT);
      for (const name of old) rmSync(join(copyDir, name), { force: true });
    } catch (err) {
      console.error('[db] nightly copy failed:', (err as Error).message);
    }
  }
```

  Update the `Db` class doc comment ("… and nightly upkeep").

- [ ] **Step 3:** `hub/src/index.ts`:
  - Add `const DB_UPKEEP_TIME = '04:00'; // local; before the usual 06:00 daily restart`.
  - After the summaries:

```ts
const dbCopies = join(dirname(config.dbPath), 'db-backups');
const upkeep = everyDay(DB_UPKEEP_TIME, 0, (target) => db.maintain(dbCopies, target));
```

  - Import `dirname` from `node:path` and call `upkeep()` in the shutdown handler.

- [ ] **Step 4:** Add `hub/db-backups/` to `.gitignore` under `# hub`. The copies hold Discord ID ↔ player
  links, and `hub/*.db*` doesn't match inside a subfolder.

- [ ] **Step 5:** `npm test && npm run typecheck`, then commit: `feat(hub): nightly hub.db upkeep (prune TPS, 7 copies)`.

---

### Task 6: Liveness ping

**Files:** Create `hub/src/health.ts`, `hub/test/health.test.ts`. Modify `hub/src/discord.ts`, `hub/src/index.ts`.

- [ ] **Step 1: Failing test** `hub/test/health.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPinger } from '../src/health.ts';

const flush = () => new Promise((r) => setImmediate(r));

test('pings every interval only while up, and survives failures', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let up = false;
  const calls: string[] = [];
  let result: Promise<{ ok: boolean; status: number }> = Promise.resolve({ ok: true, status: 200 });
  const stop = startPinger('https://hc/x', () => up, 60_000, async (url) => {
    calls.push(url);
    return result;
  });
  t.mock.timers.tick(60_000);
  assert.deepEqual(calls, []);
  up = true;
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
```

- [ ] **Step 2:** `hub/src/health.ts`:

```ts
type Get = (url: string) => Promise<{ ok: boolean; status: number }>;

const httpGet: Get = (url) => fetch(url, { signal: AbortSignal.timeout(10_000) });

/**
 * GETs `url` every `everyMs` while `up()` is true, so an outside monitor (e.g. healthchecks.io) alerts when the
 * pings stop: hub dead, host dead, or Discord unreachable. Returns a stop function. Never throws.
 */
export function startPinger(url: string, up: () => boolean, everyMs = 60_000, get: Get = httpGet): () => void {
  const timer = setInterval(() => {
    if (!up()) return;
    get(url).then(
      (res) => {
        if (!res.ok) console.error(`[health] ping got HTTP ${res.status}`);
      },
      (err: Error) => console.error('[health] ping failed:', err.message),
    );
  }, everyMs);
  return () => clearInterval(timer);
}
```

- [ ] **Step 3:** `hub/src/discord.ts`:
  - Import `Status` from `discord.js`.
  - `DiscordFrontend` gains `/** True while every gateway shard is Ready (client.isReady() stays true through reconnects). */ connected: () => boolean;`.
  - The returned object gains
    `connected: () => client.ws.shards.size > 0 && client.ws.shards.every((s) => s.status === Status.Ready),`.

- [ ] **Step 4:** `hub/src/index.ts`, after `startDiscord`:

```ts
const stopPing = config.healthcheckUrl ? startPinger(config.healthcheckUrl, discord.connected) : () => {};
```

  Call `stopPing()` in the shutdown handler.

- [ ] **Step 5:** `npm test && npm run typecheck`, then commit: `feat(hub): liveness ping while Discord is connected`.

---

### Task 7: Restore script

**Files:** Create `deploy/restore-backup.sh`, `deploy/test-restore-backup.sh` (both `chmod +x`).

- [ ] **Step 1: Failing test** `deploy/test-restore-backup.sh`:

```bash
#!/usr/bin/env bash
# Tests restore-backup.sh against a fake server folder and a systemctl stub. Needs zip and unzip.
#   bash deploy/test-restore-backup.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export GTNH_DIR=$T/server BACKUP_DIR=$T/server/backups GTNH_SERVICE=gtnh STATES=$T/states
export PATH=$T/bin:$PATH
mkdir -p "$T/bin" "$BACKUP_DIR"

# systemctl stub: prints the first line of $STATES, and drops it unless it's the last one.
cat > "$T/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
head -1 "$STATES"
if [[ $(wc -l < "$STATES") -gt 1 ]]; then sed -i 1d "$STATES"; fi
EOF
chmod +x "$T/bin/systemctl"
states() { printf '%s\n' "$@" > "$STATES"; }

# Fixtures: World/ at the zip root; level.dat at the zip root (newest); a corrupt zip (oldest).
mkdir -p "$T/a/World/region" "$T/b/region"
echo a > "$T/a/World/level.dat"
echo b > "$T/b/level.dat"
(cd "$T/a" && zip -qr "$BACKUP_DIR/2026-09-20-06-00-00.zip" World)
(cd "$T/b" && zip -qr "$BACKUP_DIR/2026-09-21-06-00-00.zip" .)
echo junk > "$BACKUP_DIR/2026-09-19-06-00-00.zip"

reset_world() { rm -rf "$GTNH_DIR"/World*; mkdir -p "$GTNH_DIR/World"; echo old > "$GTNH_DIR/World/level.dat"; }
restore() { echo y | bash "$HERE/restore-backup.sh" "$@" > "$T/out" 2>&1; }
untouched() { [[ $(cat "$GTNH_DIR/World/level.dat") == old ]] && ! compgen -G "$GTNH_DIR/.restore-*" > /dev/null; }

fail=0
check() {
  if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; sed 's/^/     /' "$T/out"; fail=1; fi
}

reset_world; states active
check 'refuses while the server is active' '! restore latest && grep -q "stop it first" "$T/out" && untouched'
states activating
check 'refuses while it is starting' '! restore latest && untouched'
states inactive
check 'refuses unknown names' '! restore 2026-01-01-00-00-00.zip && untouched'
check 'refuses paths' '! restore ../backups/2026-09-21-06-00-00.zip && untouched'
check 'refuses a corrupt zip' '! restore 2026-09-19-06-00-00.zip && untouched'
check 'cancels without a yes' '! (echo n | bash "$HERE/restore-backup.sh" latest > "$T/out" 2>&1) && untouched'
states inactive active
check 'refuses if the server was started while unpacking' '! restore latest && grep -q "was started" "$T/out" && untouched'
states inactive
check 'restores the newest backup (level.dat at the zip root)' \
  'restore latest && [[ $(cat "$GTNH_DIR/World/level.dat") == b && -d $GTNH_DIR/World/region ]] &&
   [[ $(cat "$GTNH_DIR"/World.pre-restore-*/level.dat) == old ]] && ! compgen -G "$GTNH_DIR/.restore-*" > /dev/null'
reset_world; states failed
check 'restores a named backup (World/ at the zip root)' \
  'restore 2026-09-20-06-00-00.zip && [[ $(cat "$GTNH_DIR/World/level.dat") == a && -d $GTNH_DIR/World/region ]]'
check 'lists backups and pre-restore worlds with no argument' \
  'bash "$HERE/restore-backup.sh" > "$T/out" 2>&1 && grep -q 2026-09-21-06-00-00.zip "$T/out" && grep -q pre-restore "$T/out"'
# Everything above ran without server.properties (default World); now a non-default level-name (CRLF, like Windows edits).
printf 'motd=x\r\nlevel-name=Saved\r\n' > "$GTNH_DIR/server.properties"
mkdir -p "$GTNH_DIR/Saved"; echo old > "$GTNH_DIR/Saved/level.dat"; states inactive
check 'restores into the level-name from server.properties' \
  'restore latest && [[ $(cat "$GTNH_DIR/Saved/level.dat") == b && $(cat "$GTNH_DIR"/Saved.pre-restore-*/level.dat) == old ]]'
exit $fail
```

Run `bash deploy/test-restore-backup.sh`. Every check fails because the script doesn't exist yet.

- [ ] **Step 2:** `deploy/restore-backup.sh`:

```bash
#!/usr/bin/env bash
# Puts a ServerUtilities backup back in place of a stopped GTNH server's world. Run as the server's user, not root.
#   deploy/restore-backup.sh              list backups (newest first) and pre-restore worlds
#   deploy/restore-backup.sh latest       restore the newest backup
#   deploy/restore-backup.sh <name>.zip   restore that backup
# Stop the server first with `sudo systemctl stop gtnh` (an in-game /stop restarts it: Restart=always).
# Settings, from the environment: GTNH_DIR (/home/opc/GTNH), BACKUP_DIR ($GTNH_DIR/backups), GTNH_SERVICE (gtnh).
# The current world is kept as <world>.pre-restore-<time>. Nothing deletes those: remove them by hand.
set -euo pipefail

GTNH_DIR=${GTNH_DIR:-/home/opc/GTNH}
BACKUP_DIR=${BACKUP_DIR:-$GTNH_DIR/backups}
GTNH_SERVICE=${GTNH_SERVICE:-gtnh}
NAME_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{2}.*\.zip$' # as hub/src/backups.ts

die() { echo "restore-backup: $*" >&2; exit 1; }

backups() { # newest first (names are timestamps)
  find "$BACKUP_DIR" -maxdepth 1 -type f -printf '%f\n' 2>/dev/null | grep -E "$NAME_RE" | sort -r || true
}

stopped() {
  local state
  state=$(systemctl show -p ActiveState --value "$GTNH_SERVICE")
  [[ $state == inactive || $state == failed ]]
}

pre_restore() {
  local dirs=("$GTNH_DIR/$WORLD".pre-restore-*)
  [[ -d ${dirs[0]} ]] || return 0
  echo "Pre-restore worlds (delete by hand once you're happy):"
  du -sh "${dirs[@]}" | sed 's/^/  /'
}

[[ $(id -u) -ne 0 ]] || die "don't run as root: root-owned world files would break the server"
WORLD=World
if [[ -f $GTNH_DIR/server.properties ]]; then # guarded: under pipefail a missing file would end the script silently
  WORLD=$(sed -n 's/^level-name=//p' "$GTNH_DIR/server.properties" | tail -1 | tr -d '\r')
  WORLD=${WORLD:-World}
fi

if [[ $# -eq 0 ]]; then
  echo "Backups in $BACKUP_DIR (newest first):"
  backups | while read -r name; do printf '  %s  %s\n' "$name" "$(du -h "$BACKUP_DIR/$name" | cut -f1)"; done
  pre_restore
  exit 0
fi
[[ $# -eq 1 ]] || die "usage: $0 [latest | <backup>.zip]"

if [[ $1 == latest ]]; then
  NAME=$(backups | head -1)
  [[ -n $NAME ]] || die "no backups in $BACKUP_DIR"
else
  NAME=$1
  [[ $NAME != */* && $NAME =~ $NAME_RE ]] || die "not a backup name: $NAME (run with no arguments to list them)"
  [[ -f $BACKUP_DIR/$NAME ]] || die "no such backup: $BACKUP_DIR/$NAME"
fi
ZIP=$BACKUP_DIR/$NAME

stopped || die "$GTNH_SERVICE is running; stop it first: sudo systemctl stop $GTNH_SERVICE"
command -v unzip > /dev/null || die "unzip is not installed (sudo dnf install unzip)"

NEED=$(unzip -Zt "$ZIP" 2> /dev/null | awk '{ print $3 }') || die "can't read $NAME (corrupt?)"
FREE=$(df --output=avail -B1 "$GTNH_DIR" | tail -1)
((FREE > NEED + NEED / 10)) ||
  die "not enough space: $NAME unpacks to $(numfmt --to=iec "$NEED") (+10 %), $(numfmt --to=iec "$FREE") free"

STAMP=$(date +%Y-%m-%d-%H-%M-%S)
OLD=$GTNH_DIR/$WORLD.pre-restore-$STAMP
echo "Restore $NAME (taken $(date -r "$ZIP" '+%Y-%m-%d %H:%M')) into $GTNH_DIR/$WORLD."
if [[ -e $GTNH_DIR/$WORLD ]]; then echo "The current world will be kept as $OLD."; fi
read -r -p "Continue? [y/N] " answer || true
[[ ${answer:-} == [yY] ]] || die "cancelled"

# Unpack next to the world (same filesystem), so the swap below is two renames.
STAGE=$GTNH_DIR/.restore-$STAMP
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE"
unzip -q "$ZIP" -d "$STAGE" || die "unzip failed; the world was not touched"
if [[ -f $STAGE/level.dat ]]; then
  NEW=$STAGE
else
  mapfile -t found < <(find "$STAGE" -mindepth 2 -maxdepth 2 -name level.dat)
  [[ ${#found[@]} -eq 1 ]] || die "$NAME has no level.dat at its root or in exactly one folder; the world was not touched"
  NEW=$(dirname "${found[0]}")
fi

# Unpacking can take minutes: make sure nobody started the server meanwhile.
stopped || die "$GTNH_SERVICE was started while unpacking; the world was not touched"
if [[ -e $GTNH_DIR/$WORLD ]]; then mv "$GTNH_DIR/$WORLD" "$OLD"; fi
if ! mv "$NEW" "$GTNH_DIR/$WORLD"; then
  if [[ -e $OLD ]]; then mv "$OLD" "$GTNH_DIR/$WORLD"; fi
  die "couldn't move the restored world into place; the old world is back"
fi

echo "Restored $NAME into $GTNH_DIR/$WORLD."
echo "Next: sudo systemctl start $GTNH_SERVICE, then join and check the world."
pre_restore
```

- [ ] **Step 3:** `chmod +x deploy/*.sh` and `bash deploy/test-restore-backup.sh`. Every check should print `ok`.
  Also run `shellcheck deploy/*.sh` if it's installed; fix real findings, ignore style-only ones.

- [ ] **Step 4:** Commit: `feat(deploy): restore-backup.sh with staging, double service check, and its test`.

---

### Task 8: CI and release workflows

**Files:** Create `.github/workflows/ci.yml`, `.github/workflows/release.yml`.

- [ ] **Step 1:** `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
  workflow_call:

jobs:
  hub:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [24, 26]
    defaults:
      run:
        working-directory: hub
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
          cache-dependency-path: hub/package-lock.json
      - run: npm ci
      - run: npm test
      - run: npm run typecheck

  mod:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: mod
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the version comes from mod-v* tags
      - uses: actions/setup-java@v4
        with:
          distribution: temurin
          java-version: 25
      - uses: gradle/actions/setup-gradle@v4
      - run: ./gradlew spotlessCheck build
      - uses: actions/upload-artifact@v4
        with:
          name: mod-jar
          path: |
            mod/build/libs/gtnhdiscord-*.jar
            !mod/build/libs/*-dev.jar
            !mod/build/libs/*-sources.jar

  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bash deploy/test-restore-backup.sh
```

- [ ] **Step 2:** `.github/workflows/release.yml`:

```yaml
name: Release
on:
  push:
    tags: ['hub-v*', 'mod-v*']

permissions:
  contents: write # gh release create

jobs:
  ci:
    uses: ./.github/workflows/ci.yml

  release:
    needs: ci
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Notes from this part's history only
        run: |
          part=${GITHUB_REF_NAME%%-v*}   # hub or mod
          prev=$(git describe --tags --abbrev=0 --match "$part-v*" "$GITHUB_REF_NAME^" 2>/dev/null || true)
          git log --oneline "${prev:+$prev..}$GITHUB_REF_NAME" -- "$part/" > notes.md
      - uses: actions/download-artifact@v4
        if: startsWith(github.ref_name, 'mod-v')
        with:
          name: mod-jar
          path: dist
      - name: Create the release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          files=()
          if [[ -d dist ]]; then files=(dist/*.jar); fi
          gh release create "$GITHUB_REF_NAME" --title "$GITHUB_REF_NAME" --notes-file notes.md "${files[@]}"
```

- [ ] **Step 3: Check locally** what can be checked:
  - Syntax: `python3 -c "import yaml,sys;[yaml.safe_load(open(f)) for f in sys.argv[1:]]" .github/workflows/*.yml`,
    or `actionlint` if installed.
  - The notes command, with the local tags from Task 1:
    `GITHUB_REF_NAME=mod-v1.2.0 bash -c 'part=${GITHUB_REF_NAME%%-v*}; prev=$(git describe --tags --abbrev=0 --match "$part-v*" "$GITHUB_REF_NAME^" 2>/dev/null || true); echo "prev=$prev"; git log --oneline "${prev:+$prev..}$GITHUB_REF_NAME" -- "$part/" | head'`.
    Expect `prev=mod-v1.1.0` and only commits that touch `mod/`.
  - Pushing the old `*-v1.x` tags triggers nothing: those commits have no workflows.

- [ ] **Step 4:** Commit: `ci: hub/mod/deploy checks; per-part releases from hub-v*/mod-v* tags`.

---

### Task 9: Docs

**Files:** Modify `CLAUDE.md`, `hub/CLAUDE.md`, `docs/superpowers/specs/2026-09-24-gtnh-discord-design.md`,
`docs/ROADMAP.md`.

- [ ] **Step 1:** Root `CLAUDE.md`:
  - In "Changing the wire protocol", add this after the bump line:
    `The hub accepts MIN_PROTOCOL..PROTOCOL_VERSION (protocol.ts). Policy: keep the previous version supported, so raise MIN_PROTOCOL only one release after a bump.`
  - Add a section:

```markdown
## Releases

Hub and mod are versioned separately (docs/adr/0001). Tag `hub-vX.Y.Z` or `mod-vX.Y.Z` on `main` and push
the tag: `.github/workflows/release.yml` runs CI, then creates the GitHub release. Its notes are that part's
commits, and for the mod it attaches the jar. The hub is deployed with `git checkout hub-vX.Y.Z` on the server.
```

  - In the `deploy/` bullet, mention `restore-backup.sh` (restore a backup over a stopped server's world).

- [ ] **Step 2:** `hub/CLAUDE.md`:
  - Add `npm run check-config   # validates ./config.json (or -- <path>) offline` to the command block.
  - Modules table:
    - add a row for `src/config.ts`: `Config` type, `validateConfig` (all errors at once) and `loadConfig`. Used by startup and `check-config`. Hub core.
    - add a row for `src/check-config.ts`: the `npm run check-config` entry point.
    - add a row for `src/health.ts`: `startPinger`, the `healthcheckUrl` liveness ping while Discord is connected. Hub core.
    - extend `db.ts`: `maintain` (nightly TPS prune and copies).
    - extend `backups.ts`: free space, growth, `backupStats`.
    - update the `index.ts` row to "wiring only (config via `config.ts`)".

- [ ] **Step 3:** Original spec's "Protocol (v1)" section: add one line saying that from v1.3 the hub accepts a
  range `MIN_PROTOCOL..PROTOCOL_VERSION` (current and previous), per ADR-0001.

- [ ] **Step 4:** `docs/ROADMAP.md`: move v1.3 under **Done**, in the style of v1.2a/v1.2b ("v1.3 — done"). Do
  this in the final commit only once Task 10's automated checks pass. The manual smoke test is listed there as
  pending, as for earlier releases.

- [ ] **Step 5:** Commit: `docs: v1.3 releases, protocol range, module notes`.

---

### Task 10: Verify, then hand over (manual steps are the user's)

- [ ] **Step 1: Full local verification**:

```bash
cd hub && npm test && npm run typecheck; cd ..
(cd hub && npm run check-config -- config.example.json) # exits 1 on purpose: the placeholder IDs
cd mod && ./gradlew spotlessApply build; cd ..
bash deploy/test-restore-backup.sh
git status --short   # clean
```

`check-config` on the example is *expected* to fail on the placeholder IDs, and on `dir` if `/home/opc/GTNH`
doesn't exist here. Confirm that's all it reports.

- [ ] **Step 2: Hand over.** Tell the user plainly what was verified here and what wasn't. These need them:
  1. **Push** the branch and open a PR, where CI runs for the first time. Before merging, download the run's
     `mod-jar` artifact and check the jar name has no `-dirty`. That would mean the build touches tracked
     files (e.g. under `gtnhShared/`), which should be fixed before any release exists. Then push the past
     tags: `git push origin hub-v1.0.0 hub-v1.1.0 hub-v1.2.0 mod-v1.0.0 mod-v1.1.0 mod-v1.2.0`.
  2. **Release:** after merging, `git tag hub-v1.3.0 && git tag mod-v1.3.0` on `main`, then push both tags.
     Check the mod release has `gtnhdiscord-1.3.0.jar` and each release's notes list only its part's commits.
  3. **Server smoke test:**
     - `npm run check-config` against the real `config.json`.
     - Add `healthcheckUrl` and check it goes green. Then `sudo systemctl stop gtnh-hub` and confirm the
       monitor alerts.
     - Restore: `sudo systemctl stop gtnh`, then `deploy/restore-backup.sh` (list), then
       `deploy/restore-backup.sh latest`. Start the server, join, and confirm the world is the backup's.
     - After the restore, `sudo ausearch -m AVC -ts recent | tail -3` should show no new SELinux denials.
       This also confirms which zip layout ServerUtilities uses.
     - The next morning: `hub/db-backups/hub-<day>.db` exists, and the daily summary has a *Backups* line.
     - `/backup status` shows *Free disk*, and *Growth* once the backups span a day.

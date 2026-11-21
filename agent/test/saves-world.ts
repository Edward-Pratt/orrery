// The setup the `Saves` tests share (`saves.test.ts`, `saves-folder.test.ts`, `saves-copy.test.ts`): a server data
// folder with `saves/` and `Saves` on it with fast waits (`world`), a file with a given time (`file`), and the times
// every test is relative to.

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { Saves, type BackupResult, type SavesMsg, type SavesOptions } from '../src/saves.ts';
import type { UnitState } from '../src/service.ts';
import { savedAs } from './fake-rcon.ts';

/** Now, in whole seconds (as save names carry it): every time in these tests is relative to it, never a fixed date. */
export const T0 = Math.floor(Date.now() / 1000) * 1000;
export const HOUR = 3600_000;
export const stopped: UnitState = { unit: 'factorio.service', active: 'inactive', sub: 'dead', since: T0, result: 'success' };

/**
 * A server data folder with `saves/`, and `Saves` on it with fast waits. `run` answers `/orrery-save` like the mod
 * and, like Factorio, writes the save (`write`, which a test may replace); `commands` records every command.
 */
export async function world(t: TestContext, o: Partial<SavesOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-saves-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = join(dir, 'factorio');
  const saves = join(data, 'saves');
  await mkdir(saves, { recursive: true });
  const commands: string[] = [];
  const w = {
    dir,
    data,
    saves,
    commands,
    write: (name: string) => writeFile(join(saves, savedAs(name)), 'map'),
    s: null as unknown as Saves,
    backups: [] as BackupResult[],
    pushed: [] as SavesMsg[],
  };
  w.s = new Saves({
    dir: saves,
    log: join(data, 'factorio-current.log'),
    run: async (command) => {
      commands.push(command);
      const name = command.slice('/orrery-save '.length);
      await w.write(name);
      return JSON.stringify({ ok: true, name });
    },
    unit: async () => stopped,
    pollMs: 10,
    stableMs: 50,
    waitMs: 1000,
    ...o,
  });
  w.s.on('backup', (b) => w.backups.push(b));
  w.s.on('saves', (m) => w.pushed.push(m));
  return w;
}

/** A file in `dir` with this content and modified time. */
export async function file(dir: string, name: string, at: number, content = name): Promise<void> {
  await writeFile(join(dir, name), content);
  await utimes(join(dir, name), at / 1000, at / 1000);
}

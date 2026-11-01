import { chmod, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { UnitState } from '../src/service.ts';

/**
 * A fake `systemctl` first on PATH, for the test file's process (node --test runs each file in its own): `show` prints
 * the unit's state as `set` last wrote it, in systemctl's `Key=Value` lines, and `list-units` the lines `units` last
 * wrote (none at first); any other call is recorded (its argv, in `calls`) and exits 0, or with `refuse(true)` prints
 * polkit's refusal and exits 1, as for a unit it may not touch.
 */
export async function fakeSystemctl(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-systemctl-'));
  const tab = '\t';
  await writeFile(
    join(dir, 'systemctl'),
    [
      '#!/bin/sh',
      `if [ "$1" = show ]; then cat "${dir}/state"; exit 0; fi`,
      `if [ "$1" = list-units ]; then cat "${dir}/units" 2>/dev/null; exit 0; fi`,
      `out="$1"; shift; for a in "$@"; do out="$out${tab}$a"; done; printf '%s\\n' "$out" >> "${dir}/calls"`,
      `if [ -e "${dir}/refuse" ]; then echo 'Failed to stop factorio.service: Access denied' >&2; exit 1; fi`,
      '',
    ].join('\n'),
  );
  await chmod(join(dir, 'systemctl'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  t.after(async () => {
    process.env.PATH = path;
    await rm(dir, { recursive: true, force: true });
  });
  /** The unit's state from now on (written whole, so a `show` never reads half of it). */
  const set = async (s: Omit<UnitState, 'unit'>) => {
    const at = s.since === 0 ? '' : `@${Math.floor(s.since / 1000)}`;
    await writeFile(join(dir, 'state.tmp'), `ActiveState=${s.active}\nSubState=${s.sub}\nStateChangeTimestamp=${at}\nResult=${s.result}\n`);
    await rename(join(dir, 'state.tmp'), join(dir, 'state'));
  };
  await set({ active: 'inactive', sub: 'dead', since: 0, result: 'success' });
  return {
    set,
    /** Every call but `show`, each its argv. */
    calls: async () =>
      (await readFile(join(dir, 'calls'), 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split(tab)),
    refuse: async (on: boolean) => (on ? writeFile(join(dir, 'refuse'), '') : rm(join(dir, 'refuse'), { force: true })),
    /** What `list-units` prints from now on: systemctl's `--plain --no-legend` lines. */
    units: (lines: string[]) => writeFile(join(dir, 'units'), lines.map((l) => `${l}\n`).join('')),
  };
}

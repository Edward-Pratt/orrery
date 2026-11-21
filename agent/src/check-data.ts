// The first-boot check's S6 (`check.ts`): Factorio's log in the data folder (this run's, this uid's), S1's save there,
// and nothing under `releases/<version>` changed since that release's first run (`lstat`, no link followed);
// `player-data.json` and `mods/mod-settings.dat` (`NAMES`, not confirmed by the notes) a warning only under the
// release instead, or when `lstat` fails other than `ENOENT`; missing in both, a note on S6's ok or FAIL line ("not
// written yet, in either"), never reported as outside the data folder.
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckCtx } from './check-ctx.ts';
import { installed } from './check-util.ts';
import { openPlain } from './files.ts';
import { printable } from './wire.ts';

/** S6: files the notes don't confirm Factorio writes in the data folder, relative to it. */
const NAMES = ['player-data.json', 'mods/mod-settings.dat'];

/** How many entries under `root` (it included, never following a link) changed at or after `since`, and the first. */
async function changedSince(root: string, since: number): Promise<{ count: number; first: string | null }> {
  let count = 0;
  let first: string | null = null;
  const walk = async (path: string): Promise<void> => {
    const st = await lstat(path);
    if (st.mtimeMs >= since) {
      count++;
      first ??= path;
    }
    if (st.isDirectory()) for (const name of await readdir(path)) await walk(join(path, name));
  };
  await walk(root);
  return { count, first };
}

/**
 * S6: read-data/write-data put Factorio's files under the data folder (its log there, this run's and this uid's;
 * S1's save in saves/), and nothing under the release since it started. Two more names the notes don't confirm
 * Factorio writes (`NAMES`) are a warning at most: one under the release instead, or one that can't be looked up. One
 * in neither place is only not written yet, so it goes on S6's ok or FAIL line, never as outside the data folder.
 */
export async function s6(k: CheckCtx): Promise<void> {
  const { data, install } = k.c.server;
  const uid = process.getuid!();
  const found: string[] = [];
  const problems: string[] = [];
  const log = await openPlain(k.log).catch(() => null);
  if (!log) problems.push(`no factorio-current.log in ${data}`);
  else {
    await log.fh.close();
    if (log.st.mtimeMs < k.since) problems.push('factorio-current.log was not written since the start');
    else if (log.st.uid !== uid) problems.push(`factorio-current.log belongs to uid ${log.st.uid}, not ${uid}`);
    else found.push(`factorio-current.log (uid ${uid})`);
  }
  if (k.a) {
    const a = k.a.name;
    if ((await k.saves.list()).saves.some((s) => s.name === a)) found.push(`saves/${a}`);
    else problems.push(`S1's ${a} is not in ${data}/saves`);
  }
  const ver = await installed(k);
  let release = `${install}/releases`;
  if (ver === null) problems.push(`${install}/current is not a link to releases/<version>`);
  else {
    release = join(install, 'releases', ver);
    for (const name of ['factorio-current.log', 'saves']) {
      if (await lstat(join(release, name)).then(() => true, () => false)) problems.push(`${release}/${name} exists`);
    }
    // Since the first run of this release: a re-run of setup may have put it there after an older one started.
    const since = k.runs.find((r) => r.version === ver)?.since;
    if (since === undefined) problems.push(`no run of Factorio ${ver} was seen, so ${release} was not checked (see S29)`);
    else {
      const changed = await changedSince(release, since);
      if (changed.count > 0) problems.push(`${changed.count} entries under ${release} changed since Factorio started, ${printable(changed.first!)} first`);
    }
  }
  // NAMES: in the data folder (through mods/ wherever it is mounted or linked), else under the release, else not yet.
  const absent: string[] = [];
  const misplaced: string[] = [];
  const unreadable: string[] = [];
  for (const name of NAMES) {
    const err = await lstat(join(data, name)).then(() => null, (e: NodeJS.ErrnoException) => e);
    if (!err) continue;
    if (err.code !== 'ENOENT') unreadable.push(`${name} (${err.code ?? printable(err.message)})`);
    else if (ver !== null && (await lstat(join(release, name)).then(() => true, () => false))) misplaced.push(name);
    else absent.push(name);
  }
  // Not written yet goes on S6's own line, whichever it is, so a FAIL still says it.
  const notYet = absent.length > 0 ? `; ${absent.join(', ')} not written yet, in either` : '';
  if (problems.length > 0) k.report.say('FAIL', `S6 ${problems.join('; ')}: fallback, mount the release read-write${notYet}`);
  else k.report.say('ok', `S6 Factorio writes under ${data} (${found.join(', ')}), nothing under ${release}${notYet}`);
  if (misplaced.length > 0) k.report.say('warn', `S6 under ${release}, not ${data} (names not verified, so no FAIL): ${misplaced.join(', ')}`);
  if (unreadable.length > 0) k.report.say('warn', `S6 can't look in ${data} for: ${unreadable.join(', ')}`);
}

// The first-boot check's save and stops (`check.ts`), S1, S20, S3 and S5, only with nobody on and `auto_pause` on
// (else each is `warn … skipped`): S1 a named save (`Saves.save`, 60 s; the tick read just before it); S20 200
// `/orrery-status` (one tick each while paused), a restart, then the tick no lower and `factorio-previous.log` with
// `Saving map as` and `Goodbye`; S3 200 more, a stop, S1's save restored (`Saves.restore`), a start, which must load
// the restored copy (`loadedMap` of a log written since the start) at a tick from S1's and below the stop's; S5 that
// stop: `Received SIGINT`, saved, `Goodbye`, `Result=success`, within 170 s (`SIGTERM` a warning); the server is
// always started again. `shutdownOf` reads a run's shutdown from the end of its log.
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CheckCtx } from './check-ctx.ts';
import { answer } from './check-rcon.ts';
import { describe, isStopped, MiB, secs, span } from './check-util.ts';
import { ENGINE } from './events.ts';
import { head, tail } from './files.ts';
import { loadedMap, type BackupResult } from './saves.ts';
import type { UnitState } from './service.ts';
import { parseStatus, type Status } from './status.ts';
import { printable } from './wire.ts';

/**
 * `/orrery-status` commands sent before a stop: each runs exactly one tick while auto-paused (smoke-x64 section 1), so
 * the map is this far past S1's save, and a start that loaded the wrong save shows in the tick.
 */
const MARGIN = 200;
/** Podman's --stop-timeout: Factorio has this long after SIGINT to save and exit (S5). */
const STOP_MS = 170_000;
/** Lines of a log read for its shutdown: "Saving progress" lines come between SIGINT and Goodbye. */
const TAIL = 2000;

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

/**
 * Factorio's shutdown lines (smoke-x64 section 7): the signal and Goodbye carry only the seconds, the save is an engine
 * line, so a mod's `log()` or a chat line can't pass for any of them.
 */
const SIGNAL = /^ *\d+\.\d+ Received (SIG[A-Z]+), shutting down$/;
const SAVING = new RegExp(ENGINE + 'Saving map as (.+)$');
const GOODBYE = /^ *\d+\.\d+ Goodbye$/;

export type Shutdown = { signal: string | null; saved: string | null; goodbye: boolean };

/** What the end of a run's log says about its shutdown: the signal, the file it saved to, whether it said Goodbye. */
export function shutdownOf(lines: string[]): Shutdown {
  const s: Shutdown = { signal: null, saved: null, goodbye: false };
  for (const line of lines) {
    let m: RegExpExecArray | null;
    if ((m = SIGNAL.exec(line))) s.signal = m[1]!;
    else if ((m = SAVING.exec(line))) s.saved = m[1]!;
    else if (GOODBYE.test(line)) s.goodbye = true;
  }
  return s;
}

/** Reads the unit until `done` says so or `ms` passed: the last state read, and whether it was done. */
async function until(k: CheckCtx, done: (s: UnitState) => boolean, ms: number): Promise<{ state: UnitState | null; done: boolean }> {
  const until = performance.now() + ms;
  let state: UnitState | null = null;
  for (;;) {
    state = (await k.service.read().catch(() => null)) ?? state;
    if (state && done(state)) return { state, done: true };
    if (performance.now() >= until) return { state, done: false };
    await sleep(k.w.poll);
  }
}

/** `MARGIN` × `/orrery-status`, so the map moves on that many ticks while paused: the last answer. */
async function advance(k: CheckCtx): Promise<Status> {
  let status: Status | null = null;
  for (let i = 0; i < MARGIN; i++) status = parseStatus(await k.run('/orrery-status'));
  if (!status) throw new Error('/orrery-status gave no status');
  if (status.players.length > 0) k.gate = `${status.players.length} online now`;
  return status;
}

/** The end of one of Factorio's logs in the data folder: how its run shut down. */
async function shutdown(k: CheckCtx, name: string): Promise<Shutdown> {
  return shutdownOf((await tail(join(k.c.server.data, name), TAIL).catch(() => null)) ?? []);
}

/** S1: a named save while auto-paused with nobody on. */
export async function s1(k: CheckCtx): Promise<void> {
  if (k.gate) return k.report.say('warn', `S1 skipped (${k.gate}): the save while paused, and the stops of S20, S3 and S5, need nobody on and auto_pause on`);
  // The tick before the save, not after: the save holds this tick or a later one, so a start from it (S3) can't be
  // behind it. Every RCON command runs a tick while paused, and the agent's own polls too.
  const before = parseStatus(await k.run('/orrery-status'));
  if (!before) throw new Error('/orrery-status gave no status');
  let result = null as BackupResult | null;
  k.saves.once('backup', (b) => (result = b));
  const t0 = performance.now();
  await k.saves.save();
  const took = performance.now() - t0;
  const fallback = 'fallback, while paused skip the named save and record the newest existing save';
  if (!result?.ok) return k.report.say('FAIL', `S1 ${result?.detail ?? 'no save was made'}: ${fallback}`);
  const a = (await k.saves.list()).saves.find((s) => s.kind === 'named');
  if (!a) return k.report.say('FAIL', `S1 ${result.detail}, but saves/ lists no named save: ${fallback}`);
  k.a = { name: a.name, tick: before.tick };
  k.report.say('ok', `S1 /orrery-save while paused: ${a.name} (${mb(a.size)}) in ${secs(took)}, from tick ${before.tick}`);
}

/** S20: a restart saves before the new run starts, so the map goes on from where it was. */
export async function s20(k: CheckCtx): Promise<void> {
  if (k.gate) return k.report.say('warn', `S20 skipped (${k.gate})`);
  const tb = await advance(k);
  if (k.gate) return k.report.say('warn', `S20 skipped (${k.gate})`);
  const { unit } = k.c.server;
  const before = await k.service.read();
  k.report.note(`S20 restarting ${unit}: Factorio saves, then starts again (up to ${span(k.w.stop + k.w.rcon)})`);
  const t0 = performance.now();
  await k.service.act('restart');
  let down = false;
  const after = await until(k, (s) => {
    if (s.active !== 'active') down = true;
    return s.active === 'failed' || (s.active === 'active' && (down || s.since > before.since));
  }, k.w.stop + k.w.rcon);
  if (after.state?.active !== 'active' || !after.done) {
    k.up = false;
    return k.report.say('FAIL', `S20 ${unit} did not come back after a restart: it is ${describe(after.state)}`);
  }
  const ta = await answer(k);
  if (typeof ta === 'string') return k.report.say('FAIL', `S20 no RCON after the restart: ${ta}`);
  const took = performance.now() - t0;
  const end = await shutdown(k, 'factorio-previous.log'); // the ended run's log, renamed at this start
  const saved = end.saved ? `saved ${printable(end.saved)}` : 'no "Saving map as" line';
  const evidence = `tick ${tb.tick} -> ${ta.tick}, ${saved}, ${end.goodbye ? 'Goodbye' : 'no Goodbye'}; up again in ${secs(took)}`;
  if (ta.tick >= tb.tick && end.saved && end.goodbye) k.report.say('ok', `S20 restart saves first: ${evidence}`);
  else k.report.say('FAIL', `S20 restart lost ticks or did not save (factorio-previous.log): ${evidence}`);
}

/**
 * S3 and S5: a stop (S5: SIGINT, saved, exit 0 within 170 s), S1's save restored, a start, which must load the
 * restored copy (`--start-server-load-latest` takes the newest file). Started again whatever failed in between.
 */
export async function s3(k: CheckCtx): Promise<void> {
  const skip = (why: string) => {
    k.report.say('warn', `S3 skipped (${why})`);
    k.report.say('warn', `S5 skipped (${why})`);
  };
  if (k.gate) return skip(k.gate);
  if (!k.up) return skip('no RCON since the last start');
  const t2 = await advance(k);
  if (k.gate) return skip(k.gate);
  const { unit, data } = k.c.server;
  const a = k.a;
  k.report.note(`S3 stopping ${unit} (up to ${span(k.w.stop)}), restoring ${a ? a.name : 'nothing (S1 made no save)'}, and starting it again`);
  const t0 = performance.now();
  try {
    await k.service.act('stop');
  } catch (err) {
    k.report.say('FAIL', `S3 ${printable((err as Error).message)}`);
    return void k.report.say('warn', 'S5 skipped (no stop)');
  }
  const stop = await until(k, isStopped, k.w.stop);
  const stopMs = performance.now() - t0;
  let end: Shutdown | null = null;
  let notRestored: string | null = null;
  let copy: string | null = null;
  try {
    if (!stop.done) notRestored = `${unit} did not stop within ${span(k.w.stop)}: it is ${describe(stop.state)}`;
    else {
      end = await shutdown(k, 'factorio-current.log'); // the stopped run's log, before the next start renames it
      if (!a) notRestored = 'S1 made no save to restore';
      else {
        await k.saves.restore(a.name);
        copy = (await k.saves.list()).saves[0]?.name ?? null; // the newest: the restored copy, 2 s past the rest
      }
    }
  } catch (err) {
    notRestored = printable((err as Error).message);
  }

  // Started again whatever happened above: the check never leaves the server down.
  let t3: Status | string;
  const t1 = performance.now();
  try {
    await k.service.act('start');
    const start = await until(k, (s) => s.active === 'active' || s.active === 'failed', k.w.rcon);
    t3 = start.state?.active === 'active' ? await answer(k) : `${unit} did not start: it is ${describe(start.state)}`;
  } catch (err) {
    t3 = printable((err as Error).message);
  }
  if (typeof t3 === 'string') k.up = false;

  if (notRestored || typeof t3 === 'string') {
    const why = [notRestored && `not restored: ${notRestored}`, typeof t3 === 'string' && `no RCON after the start: ${t3}`];
    k.report.say('FAIL', `S3 ${why.filter(Boolean).join('; ')}`);
  } else {
    const loaded = loadedMap((await head(k.log, MiB, k.since)) ?? '');
    const want = copy && join(data, 'saves', copy);
    const evidence = `loaded ${loaded ? printable(loaded) : 'no map (no "Loading map" line in factorio-current.log)'}, tick ${t3.tick} (S1 saved from ${a!.tick}, stopped at ${t2.tick}); up in ${secs(performance.now() - t1)}`;
    if (loaded === want && a!.tick <= t3.tick && t3.tick < t2.tick) {
      k.report.say('ok', `S3 a start loads the newest save, the restored copy: ${evidence}, ${t2.tick - t3.tick} ticks back`);
    } else k.report.say('FAIL', `S3 ${evidence}: fallback, start with --start-server <file> through a state file read by ExecStartPre`);
  }

  if (!stop.done) return k.report.say('FAIL', `S5 ${unit} did not stop within ${span(k.w.stop)}: it is ${describe(stop.state)}`);
  const e = end ?? { signal: null, saved: null, goodbye: false };
  const evidence = [
    e.signal ?? 'no "Received SIG…" line',
    e.saved ? `saved ${printable(e.saved)}` : 'no "Saving map as" line',
    e.goodbye ? 'Goodbye' : 'no Goodbye',
    `${stop.state!.active} with Result=${stop.state!.result} in ${secs(stopMs)}`,
  ].join(', ');
  const clean = e.saved !== null && e.goodbye && stop.state!.result === 'success' && stopMs <= STOP_MS;
  if (clean && e.signal === 'SIGINT') k.report.say('ok', `S5 stop: ${evidence}`);
  else if (clean && e.signal === 'SIGTERM') k.report.say('warn', `S5 stop: ${evidence}: Podman sent SIGTERM, so PodmanArgs --stop-signal=SIGINT was not applied`);
  else k.report.say('FAIL', `S5 stop: ${evidence}: fallback, raise the timeouts`);
}

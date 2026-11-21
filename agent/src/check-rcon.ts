// The server's unit and RCON, as the first-boot check (`check.ts`) finds them: factorio.service (`failed` or
// `inactive`: a `FAIL` at once with its state, RCON not tried); `/orrery-status` on the check's own `RconSession`,
// retried for 5 minutes (the start timeout), but final at once on a refused password (`RconRefused`) or the unit
// stopping (`answer`, also after S20's restart and S3's start); then whether the stops can run (nobody on and
// `auto_pause` on). S2 (always) `/orrery-unlink` refused as for players (a nil `player_index`); S8 the largest reply
// (or Factorio's `/help`) over 4096 bytes, else a warning.
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CheckCtx } from './check-ctx.ts';
import { describe, isObject, isStopped, span } from './check-util.ts';
import { RconRefused } from './rcon.ts';
import { parseStatus, readAutoPause, type Status } from './status.ts';
import { printable } from './wire.ts';

/** Source RCON servers split replies at this size; Factorio sends any size as one packet (S8). */
const SOURCE_SPLIT = 4096;

/** A reply quoted for the report: JSON, at most 200 characters of it, `printable`. */
const quote = (reply: string) => printable(JSON.stringify(reply.slice(0, 200)));

/** The unit, then RCON's first answer: false if Factorio isn't there to check. */
export async function factorio(k: CheckCtx): Promise<boolean> {
  const { unit, rconPort } = k.c.server;
  const first = await k.service.read().catch((err: Error) => err);
  if (first instanceof Error) k.report.say('warn', `unit: can't read ${unit}: ${printable(first.message)}`);
  else if (isStopped(first)) {
    k.report.say('FAIL', `unit: ${unit} is ${describe(first)}: as root, journalctl -u ${unit} says why`);
    return false;
  }
  k.report.note(`waiting for /orrery-status over RCON (up to ${span(k.w.rcon)}: Factorio may still be loading the map)`);
  const status = await answer(k);
  if (typeof status === 'string') {
    k.report.say('FAIL', `rcon: 127.0.0.1:${rconPort}: ${status}`);
    return false;
  }
  const since = k.since ? ` (${unit} active since ${new Date(k.since).toISOString()})` : '';
  k.report.say('ok', `rcon: Factorio ${status.version} answers /orrery-status: tick ${status.tick}, ${status.players.length} online${since}`);
  const autoPause = await readAutoPause(join(k.c.server.data, 'config', 'server-settings.json'));
  k.gate = status.players.length > 0 ? `${status.players.length} online` : autoPause ? null : 'auto_pause is off';
  return true;
}

/**
 * `/orrery-status` once RCON answers, retried for `waits.rcon`, the run it answered for noted; why not, if it didn't.
 * A refused password, or the unit stopped or failed, is final at once: waiting can't change it.
 */
export async function answer(k: CheckCtx): Promise<Status | string> {
  const { unit } = k.c.server;
  const until = performance.now() + k.w.rcon;
  k.up = false;
  for (;;) {
    let why: string;
    try {
      const status = parseStatus(await k.run('/orrery-status'));
      if (status) {
        k.since = (await k.service.read().catch(() => null))?.since ?? 0;
        k.runs.push({ since: k.since, version: status.version });
        k.up = true;
        return status;
      }
      why = '/orrery-status gave no status (is the orrery mod loaded?)';
    } catch (err) {
      if (err instanceof RconRefused) return 'RCON refused the password: RCON_PASSWORD is not the one factorio.service started with (/etc/orrery-factorio.env)';
      why = printable((err as Error).message);
    }
    const now = await k.service.read().catch(() => null);
    if (now && isStopped(now)) return `${unit} is ${describe(now)}: as root, journalctl -u ${unit} says why`;
    if (performance.now() + k.w.retry > until) return why;
    await sleep(k.w.retry);
  }
}

/** S2: a command over RCON runs with a nil player_index, so a command for players refuses it. */
export async function s2(k: CheckCtx): Promise<void> {
  const reply = await k.run('/orrery-unlink');
  let r: unknown = null;
  try {
    r = JSON.parse(reply);
  } catch {
    // not JSON: not the mod's refusal
  }
  if (isObject(r) && Object.keys(r).length === 2 && r.ok === false && r.error === '/orrery-unlink is for players') {
    k.report.say('ok', 'S2 RCON commands run with player_index nil (/orrery-status answered, /orrery-unlink refused as for players)');
  } else k.report.say('FAIL', `S2 /orrery-unlink over RCON answered ${quote(reply)}, not "/orrery-unlink is for players"`);
}

/** S8: a reply over Source RCON's 4096-byte split arrives whole, as Factorio's one packet. */
export async function s8(k: CheckCtx): Promise<void> {
  // The biggest harmless reply (never /c or /sc, which flag the save); untested on 2.1, so a failure only notes.
  const help = await k.run('/help').then(
    (reply) => `/help ${Buffer.byteLength(reply)} bytes`,
    (err: Error) => `/help failed: ${printable(err.message)}`,
  );
  if (k.largest > SOURCE_SPLIT) k.report.say('ok', `S8 one packet of ${k.largest} bytes, read whole (${help})`);
  else k.report.say('warn', `S8 not exercised (largest reply ${k.largest} bytes; ${help}): run check again once the friend's mods are in`);
}

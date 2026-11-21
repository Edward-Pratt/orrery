// The first-boot check's S29 (`check.ts`): setup's six mods and every one `mod-list.json` enables loaded, in the
// version `<install>/current` points at. Mod names print `printable`; `enabledMods` reads `mod-list.json` defensively.
import { join } from 'node:path';
import type { CheckCtx } from './check-ctx.ts';
import { installed, isObject, small } from './check-util.ts';
import { parseStatus } from './status.ts';
import { printable } from './wire.ts';

/** The mods setup's mod-list.json enables (S29). */
const SETUP_MODS = ['base', 'space-age', 'quality', 'elevated-rails', 'recycler', 'orrery'];

/** The names `mod-list.json` enables, read defensively (the container writes it): null if it isn't that shape. */
export function enabledMods(text: string): string[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw) || !Array.isArray(raw.mods)) return null;
  return raw.mods.filter((m): m is { name: string } => isObject(m) && m.enabled === true && typeof m.name === 'string').map((m) => m.name);
}

/** S29: setup's mods and every one mod-list.json enables are loaded, in the version `current` points at. */
export async function s29(k: CheckCtx): Promise<void> {
  const { data, install } = k.c.server;
  const status = parseStatus(await k.run('/orrery-status'));
  if (!status) return k.report.say('FAIL', 'S29 /orrery-status gave no status');
  const enabled = enabledMods((await small(join(data, 'mods', 'mod-list.json'))) ?? '');
  const missing = [...new Set([...SETUP_MODS, ...(enabled ?? [])])].filter((m) => !Object.hasOwn(status.mods, m));
  const ver = await installed(k);
  const mods = Object.entries(status.mods)
    .map(([name, v]) => `${printable(name)} ${v}`)
    .join(', ');
  const problems: string[] = [];
  if (missing.length > 0) {
    const names = missing.slice(0, 20).map(printable).join(', ');
    problems.push(`not loaded: ${names}${missing.length > 20 ? ` and ${missing.length - 20} more` : ''}`);
  }
  if (status.version !== ver) problems.push(`Factorio ${status.version} runs, but ${install}/current is ${ver ?? 'not a link to releases/<version>'}`);
  const list = enabled === null ? "; mods/mod-list.json can't be read, so only setup's six were looked for" : '';
  if (problems.length > 0) k.report.say('FAIL', `S29 ${problems.join('; ')}${list}; mods: ${mods}`);
  else k.report.say('ok', `S29 Factorio ${status.version} (${install}/current)${list}; mods: ${mods}`);
}

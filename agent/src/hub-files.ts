// The agent's own files `HubClient` writes and reads back. `writeAtomic` writes a file whole or not at all (a temp
// file beside it, then a rename), for `<root>/connected` and these, and for `deploy.ts`. `<state>/installed.json`
// (`INSTALLED`) holds the latest `installed`, read back at start checked against the hub's limits and copied field by
// field; `<state>/started.json` the change time of the run last announced with `started`. Both are in the agent's own
// folder, and either reads as null when missing or not that.

import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import type { InstalledMsg } from './update.ts';
import { LIMITS } from './wire.ts';

/** Writes `file` whole or not at all: a temp file beside it, then a rename. */
export async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, file);
}

/** `installed`'s file in the agent's state folder. */
export const INSTALLED = 'installed.json';

/**
 * What the server ran last, from `<state>/installed.json` (the agent's own folder), as `installed` sends it: checked
 * against the hub's limits and copied field by field; null if none or not that.
 */
export function readInstalled(file: string): InstalledMsg | null {
  const text = (v: unknown): v is string => typeof v === 'string' && v.length <= LIMITS.text;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { factorio?: unknown; mods?: unknown };
    if (!text(raw.factorio) || !Array.isArray(raw.mods) || raw.mods.length > LIMITS.mods) return null;
    const mods: InstalledMsg['mods'] = [];
    for (const m of raw.mods as { name?: unknown; version?: unknown }[]) {
      if (typeof m !== 'object' || m === null || !text(m.name) || !text(m.version)) return null;
      mods.push({ name: m.name, version: m.version });
    }
    return { factorio: raw.factorio, mods };
  } catch {
    return null;
  }
}

/** The run last announced with `started`, from `<state>/started.json` (the agent's own folder); null if none. */
export function readStarted(file: string): number | null {
  try {
    const { since } = JSON.parse(readFileSync(file, 'utf8')) as { since?: unknown };
    return typeof since === 'number' && Number.isSafeInteger(since) ? since : null;
  } catch {
    return null;
  }
}

// Helpers the first-boot checks (`check.ts`) share: how a report line writes a time, a state or a size; a small file
// read without following a link (`small`: the container writes most of what the checks read); agent.log's lines
// (`agentLine`); and the Factorio version `<install>/current` points at (`installed`).
import { constants, open, readlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckCtx } from './check-ctx.ts';
import type { UnitState } from './service.ts';

/** Far past where Factorio logs the map it loads, and a cap on the small files read. */
export const MiB = 1024 * 1024;

export const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
export const span = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 6000) / 10} minutes` : `${ms / 1000} s`);
export const isStopped = (s: UnitState) => s.active === 'inactive' || s.active === 'failed';
export const describe = (s: UnitState | null) => (s ? `${s.active} (${s.sub}), Result=${s.result}` : 'in an unknown state');
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A line of agent.log (`AgentLog`): its time, epoch ms, and what was logged. */
export function agentLine(line: string): { at: number; text: string } | null {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) (.*)$/.exec(line);
  return m ? { at: Date.parse(m[1]!), text: m[2]! } : null;
}

/** A small regular file's text (`O_NOFOLLOW`, `O_NONBLOCK`, at most 1 MiB); null if it isn't one or can't be read. */
export async function small(path: string): Promise<string | null> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = await fh.stat();
    if (!st.isFile() || st.size > MiB) return null;
    const buf = Buffer.alloc(st.size);
    const { bytesRead } = await fh.read(buf, 0, st.size, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/** The Factorio version `<install>/current` points at (`releases/<version>`); null if it isn't such a link. */
export async function installed(k: CheckCtx): Promise<string | null> {
  const target = await readlink(join(k.c.server.install, 'current')).catch(() => '');
  return /^releases\/(\d+\.\d+\.\d+)$/.exec(target)?.[1] ?? null;
}

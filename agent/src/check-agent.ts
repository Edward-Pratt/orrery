// The first-boot check's S16 (`check.ts`): Node's version, arch and glibc, orrery-agent.service running (`203/EXEC`
// fails) with `NRestarts` held 6 s, SELinux enforcing (else a warning); it notes when the agent's unit became active,
// for the hub's welcome (`check-hub.ts`).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CheckCtx } from './check-ctx.ts';
import { secs, span } from './check-util.ts';
import { AGENT_UNIT } from './logs.ts';
import { printable } from './wire.ts';

/** orrery-agent.service's `systemctl show` properties (no polkit needed). */
async function agentUnit(k: CheckCtx): Promise<Map<string, string>> {
  const out = await k.systemctl([
    'show',
    '--timestamp=unix',
    '--property=ActiveState,SubState,Result,ExecMainStatus,NRestarts,MainPID,ActiveEnterTimestamp',
    '--',
    AGENT_UNIT,
  ]);
  const props = new Map<string, string>();
  for (const line of out.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) props.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return props;
}

/**
 * S16: the private Node runs on this glibc (the check runs on it), and starts under systemd with SELinux enforcing:
 * orrery-agent.service running, not failing with 203/EXEC, and not restarting.
 */
export async function s16(k: CheckCtx): Promise<void> {
  const header = (process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } }).header;
  const glibc = typeof header?.glibcVersionRuntime === 'string' ? header.glibcVersionRuntime : 'unknown';
  k.report.say('ok', `S16 node ${process.version} ${process.arch}, glibc ${glibc}`);
  const running = (p: Map<string, string>) => p.get('ActiveState') === 'active' && p.get('SubState') === 'running';
  const state = (p: Map<string, string>) =>
    `${p.get('ActiveState') ?? '?'} (${p.get('SubState') ?? '?'}), Result=${p.get('Result') ?? '?'}, exit status ${p.get('ExecMainStatus') ?? '?'}`;
  const until = performance.now() + k.w.agent;
  let p = await agentUnit(k);
  while (!running(p) && p.get('ExecMainStatus') !== '203' && performance.now() < until) {
    await sleep(k.w.poll);
    p = await agentUnit(k);
  }
  if (p.get('ExecMainStatus') === '203') return k.report.say('FAIL', `S16 ${AGENT_UNIT} 203/EXEC (${state(p)}): fallback, a broader bin_t rule`);
  if (!running(p)) return k.report.say('FAIL', `S16 ${AGENT_UNIT} is ${state(p)} after ${span(k.w.agent)}`);
  const restarts = p.get('NRestarts') ?? '?';
  await sleep(k.w.restarts);
  const q = await agentUnit(k);
  if (!running(q) || q.get('NRestarts') !== p.get('NRestarts')) {
    return k.report.say('FAIL', `S16 ${AGENT_UNIT} restarted within ${secs(k.w.restarts)} (NRestarts ${restarts} -> ${q.get('NRestarts') ?? '?'}, ${state(q)})`);
  }
  const enter = /^@(\d+)$/.exec(q.get('ActiveEnterTimestamp') ?? '');
  k.agentSince = enter ? Number(enter[1]) * 1000 : null;
  const pid = q.get('MainPID') ?? '';
  const label = /^[1-9]\d*$/.test(pid) ? (await readFile(join(k.p.proc, pid, 'attr', 'current'), 'utf8').catch(() => '')).replace(/\0/g, '').trim() : '';
  const line = `S16 ${AGENT_UNIT} active (running), NRestarts ${restarts} held over ${secs(k.w.restarts)}${label ? `, label ${printable(label)}` : ''}`;
  const enforce = (await readFile(k.p.selinux, 'utf8').catch(() => '')).trim();
  if (enforce === '1') k.report.say('ok', `${line}, SELinux enforcing`);
  else k.report.say('warn', `${line}; SELinux is not enforcing, so 203/EXEC was not exercised`);
}

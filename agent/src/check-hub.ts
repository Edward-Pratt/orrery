// The first-boot check's last line (`check.ts`), the hub: a TCP connect (a warning only, for `--no-hub`), then the
// `connected` file written since the agent started (a welcome), else a warning quoting agent.log's latest `[hub]` line
// (at once on a rejection).
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CheckCtx } from './check-ctx.ts';
import { agentLine, isObject } from './check-util.ts';
import { tail } from './files.ts';
import { AGENT_LOG, AGENT_UNIT } from './logs.ts';
import { printable } from './wire.ts';

/** Null if a TCP connection to the hub opens (and is closed at once, nothing sent), else why not. */
function reach(host: string, port: number, waitMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: waitMs });
    socket.once('connect', () => (socket.destroy(), resolve(null)));
    socket.once('timeout', () => (socket.destroy(), resolve('timed out')));
    socket.once('error', (err) => resolve(err.message));
  });
}

/** The hub: reachable over TCP (a warning only, for `--no-hub`), and whether the agent was welcomed since its start. */
export async function hub(k: CheckCtx): Promise<void> {
  const { host, port } = k.c.hub;
  const why = await reach(host, port, k.w.hub);
  if (why !== null) return k.report.say('warn', `hub: can't reach ${host}:${port} (${why}); fine before the hub listens`);
  if (k.agentSince === null) return k.report.say('warn', `hub: ${host}:${port} answers; whether the agent was welcomed is unknown (${AGENT_UNIT} isn't running)`);
  const welcome = await hubWelcome(k, k.agentSince);
  if (welcome.version !== null) k.report.say('ok', `hub: ${host}:${port} welcomed ${welcome.version}`);
  else k.report.say('warn', `hub: ${host}:${port} answers, but no welcome since ${AGENT_UNIT} started: ${welcome.why}`);
}

/**
 * The agent's version from `<root>/connected` once it was written since `since` (each welcome writes it); or the
 * latest `[hub]` line agent.log has since then, as soon as that is a rejection, or once `waits.welcome` passed.
 */
async function hubWelcome(k: CheckCtx, since: number): Promise<{ version: string | null; why: string }> {
  const until = performance.now() + k.w.welcome;
  for (;;) {
    try {
      const c: unknown = JSON.parse(await readFile(join(k.c.root, 'connected'), 'utf8'));
      if (isObject(c) && typeof c.version === 'string' && typeof c.time === 'number' && c.time >= since) return { version: printable(c.version), why: '' };
    } catch {
      // not there yet
    }
    let latest: string | null = null;
    for (const raw of (await tail(join(k.c.root, AGENT_LOG), 1000).catch(() => null)) ?? []) {
      const l = agentLine(raw);
      if (l && l.at >= since && l.text.startsWith('[hub] ')) latest = l.text;
    }
    if (latest?.includes('(rejected: ') || performance.now() >= until) return { version: null, why: latest ? printable(latest) : 'agent.log has no [hub] line since' };
    await sleep(k.w.poll);
  }
}

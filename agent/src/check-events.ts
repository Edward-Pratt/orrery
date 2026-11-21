// The first-boot check's S4 (`check.ts`): Factorio's socket on 127.0.0.1:`factorioUdpPort` in `/proc/net/udp` as
// this uid, its `Opening socket` line (`socketState` on; an Opening line the socket failed or closed after is named as
// such), and the mod's hello (in agent.log since the start while the agent holds its port, else to the check's own
// listener after `/orrery-hello`).
import { createSocket } from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CheckCtx } from './check-ctx.ts';
import { agentLine, MiB, secs } from './check-util.ts';
import { openingLine, parseDatagram, socketState } from './events.ts';
import { head, tail } from './files.ts';
import { AGENT_LOG } from './logs.ts';
import { printable } from './wire.ts';

/** `/proc/net/udp`'s owner (uid) of the IPv4 socket bound on 127.0.0.1:`port`; null if none. */
export function udpOwner(table: string, port: number): number | null {
  const local = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  for (const line of table.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f[1] === local && f[7] !== undefined && /^\d+$/.test(f[7])) return Number(f[7]);
  }
  return null;
}

/** `p`, or null once `ms` passed first; the timer never outlives it. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * S4: Factorio's Lua UDP socket on 127.0.0.1:`factorioUdpPort`, its own (`/proc/net/udp`, this uid), logged as
 * Factorio's, and the mod's hello from it: as the running agent logs it (it holds `agentUdpPort`), or, with the
 * agent down, to the check's own listener there.
 */
export async function s4(k: CheckCtx): Promise<void> {
  const { factorioUdpPort: port } = k.c.server;
  const uid = process.getuid!();
  const owner = udpOwner((await readFile(join(k.p.proc, 'net', 'udp'), 'utf8').catch(() => '')), port);
  const text = await head(k.log, MiB, k.since);
  const state = text === null ? null : socketState(text, port);
  const logged = state === 'on';
  const opening = text !== null && text.split('\n').some((l) => openingLine(port).test(l.replace(/\r$/, '')));
  const socket = owner === null ? `nothing bound on 127.0.0.1:${port}` : `127.0.0.1:${port} bound by uid ${owner}`;
  const line = logged
    ? '"Opening socket" logged'
    : opening && state === 'off'
      ? '"Opening socket" logged, but the socket failed or closed (the port is taken?)'
      : opening
        ? '"Opening socket" logged, with nothing after it yet'
        : state === 'off'
          ? '"Opening Lua UDP Socket failed" logged'
          : 'no "Opening socket" line in factorio-current.log since the start';
  if (owner !== uid || !logged) return k.report.say('FAIL', `S4 ${socket}, ${line}: fallback, a write_file tail`);
  const hello = await modHello(k);
  const evidence = `${socket}, ${line}, ${hello.evidence}`;
  if (hello.ok) k.report.say('ok', `S4 Factorio's Lua UDP socket: ${evidence}`);
  else k.report.say('FAIL', `S4 ${evidence}: fallback, a write_file tail`);
}

/** The mod's hello since the last start: in agent.log while the agent holds its UDP port, else to the check itself. */
async function modHello(k: CheckCtx): Promise<{ ok: boolean; evidence: string }> {
  const { agentUdpPort, factorioUdpPort } = k.c.server;
  const socket = createSocket('udp4');
  const bound = await new Promise<boolean>((resolve) => {
    socket.once('error', () => resolve(false));
    socket.bind({ address: '127.0.0.1', port: agentUdpPort, exclusive: true }, () => resolve(true));
  });
  if (!bound) {
    try {
      socket.close();
    } catch {
      // never bound: nothing to close
    }
    return agentHello(k);
  }
  try {
    // Nothing holds the agent's port, so orrery-agent.service is down: the check asks for the hello itself.
    let came: (seq: number) => void = () => {};
    const hello = new Promise<number>((resolve) => (came = resolve));
    socket.on('message', (data, from) => {
      if (from.address !== '127.0.0.1' || from.port !== factorioUdpPort) return;
      const d = parseDatagram(data);
      if (typeof d !== 'string' && d.event === null) came(d.seq);
    });
    const reply = await k.run('/orrery-hello').catch((err: Error) => err);
    const where = `orrery-agent.service is down, so the check listened on 127.0.0.1:${agentUdpPort}`;
    if (reply instanceof Error) return { ok: false, evidence: `/orrery-hello failed: ${printable(reply.message)} (${where})` };
    const seq = await within(hello, k.w.hello);
    if (seq === null) return { ok: false, evidence: `no hello datagram from 127.0.0.1:${factorioUdpPort} within ${secs(k.w.hello)} (${where})` };
    return { ok: true, evidence: `the mod's hello came from it (seq ${seq}; ${where})` };
  } finally {
    socket.close();
  }
}

/** The running agent's word for this start, in its agent.log: the events gate on, and the mod's hello. */
async function agentHello(k: CheckCtx): Promise<{ ok: boolean; evidence: string }> {
  const file = join(k.c.root, AGENT_LOG);
  const until = performance.now() + k.w.events;
  for (;;) {
    let on = false;
    let seq: string | null = null;
    for (const raw of (await tail(file, 1000).catch(() => null)) ?? []) {
      const l = agentLine(raw);
      if (!l || l.at < k.since) continue;
      let m: RegExpExecArray | null;
      if (l.text.startsWith('[events] on: ')) on = true;
      else if ((m = /^\[events\] the mod's hello came: seq (\d+)$/.exec(l.text))) seq = m[1]!;
      else if (l.text.startsWith('[events] game events are off') || l.text.startsWith('[events] no hello datagram came')) {
        return { ok: false, evidence: `agent.log: ${printable(l.text)}` };
      }
    }
    if (on && seq !== null) return { ok: true, evidence: `the mod's hello came from it to orrery-agent.service (seq ${seq})` };
    if (performance.now() >= until) {
      return { ok: false, evidence: `agent.log has no ${on ? `"hello came"` : '"[events] on"'} line within ${secs(k.w.events)} of the start` };
    }
    await sleep(k.w.poll);
  }
}

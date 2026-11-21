// The Agent connection, for `HubClient` (what it keeps: `HubState`). It sends `agentHello` (with `node`, its Node's
// `process.version`, when `NODE_VERSION` matches it) and nothing else before `welcome` (`connect`); then (`welcomed`)
// a `ping` every 10 s and the state pushed on connect (`serviceState`, `saves`, `installed`, `events` and `settings`:
// `tellEvents` and `tellSettings`, `settings` never twice the same on one connection), then the `welcomed` hook (a
// game update's latest step and pending `updateDone`, a deploy's outcome not yet sent), and the game connection opens
// if RCON has answered. A `reply` by id to every request: a `Handlers` entry's result (a rejection's message as its
// `error`, `redact`ed and cut to 2 KiB), or `ok: false` for one that is invalid, of an unknown type or has no handler.
// Any close reconnects (`hub-retry.ts`: `backoff`, or for a hello the hub refused as `reconnecting too fast`,
// `tooFastWait`); state changes are logged once each, and that refusal is logged without `(rejected: `, which the
// first-boot check stops at. After each welcome it writes `<root>/connected`, `{"version":"agent-vX.Y.Z","time":<epoch
// ms>}`, atomically (temp file and rename; `writeAtomic`): exactly what `deploy-agent.sh`'s gate reads (`version`
// equal to the tag; the script removes the file right before each restart, so `time` is never compared). Its close
// closes the game connection too.

import { join } from 'node:path';
import type { AgentMsg, AgentRequest } from '../../hub/src/types.ts';
import { writeAtomic } from './hub-files.ts';
import { closeGame, openGame } from './hub-game.ts';
import { Link } from './hub-link.ts';
import { TOO_FAST, backoff, tooFastWait } from './hub-retry.ts';
import { connected, type HubState } from './hub-state.ts';
import { redact } from './logs.ts';
import { LIMITS, NODE_VERSION, PROTOCOL_VERSION, cut, printable, readAgentLine, type OutMsg } from './wire.ts';

export function tellEvents(st: HubState): void {
  const s = st.events;
  if (!s || !connected(st)) return;
  st.agent!.send(s.on ? { type: 'events', on: true } : { type: 'events', on: false, reason: cut(printable(s.reason), LIMITS.detail) });
}

export function tellSettings(st: HubState): void {
  const s = st.settings;
  if (!s || !connected(st)) return;
  const key = JSON.stringify(s);
  if (key === st.settingsSent) return;
  st.settingsSent = key;
  st.agent!.send({ type: 'settings', ...s });
}

/** The first-boot check quotes the latest of these from agent.log, and stops waiting at a `(rejected: …)` one. */
function log(s: HubState, state: string): void {
  if (state !== s.logged) console.log(`[hub] ${state}`);
  s.logged = state;
}

export function connect(s: HubState): void {
  const { host, port } = s.config.hub;
  const hello: OutMsg = {
    type: 'agentHello',
    protocol: PROTOCOL_VERSION,
    agentId: s.config.id,
    token: s.config.token,
    agentVersion: s.version,
    ...(NODE_VERSION.test(process.version) && { node: process.version }),
  };
  const link: Link = new Link(host, port, hello, (line) => agentLine(s, link, line), (why) => agentClosed(s, link, why), s.handshakeMs);
  s.agent = link;
}

function agentLine(s: HubState, link: Link, line: string): void {
  const r = readAgentLine(line);
  if (!link.welcomed) {
    if (r.msg?.type === 'welcome') return welcomed(s, link);
    if (r.msg?.type === 'reject' && r.msg.reason === TOO_FAST) {
      link.tooFast = true;
      return link.drop(TOO_FAST);
    }
    return link.drop(r.msg?.type === 'reject' ? `rejected: ${r.msg.reason}` : 'the hub answered the hello with something else');
  }
  if (r.msg === null) {
    if (r.id !== null) return link.send({ type: 'reply', id: r.id, ok: false, error: r.why });
    return console.error(`[hub] dropped a line from the hub: ${r.why}`);
  }
  if (r.msg.type !== 'welcome' && r.msg.type !== 'reject') void request(s, link, r.msg);
}

async function request(s: HubState, link: Link, req: AgentRequest): Promise<void> {
  const handler = s.handlers[req.type] as ((req: AgentRequest) => Promise<unknown>) | undefined;
  let reply: AgentMsg;
  if (!handler) reply = { type: 'reply', id: req.id, ok: false, error: `${req.type} is not supported by ${s.version}` };
  else {
    try {
      const data = await handler(req);
      reply = data === undefined ? { type: 'reply', id: req.id, ok: true } : { type: 'reply', id: req.id, ok: true, data };
    } catch (err) {
      // No URL query string in an error (docs/protocol.md), and within the hub's limit for one.
      reply = { type: 'reply', id: req.id, ok: false, error: cut(redact(String(err instanceof Error ? err.message : err)), LIMITS.detail) };
    }
  }
  if (s.agent === link) link.send(reply);
}

function welcomed(s: HubState, link: Link): void {
  link.welcome();
  s.failures = 0;
  s.welcomedAt = performance.now();
  log(s, `connected to the hub at ${s.config.hub.host}:${s.config.hub.port} as ${s.version}`);
  void writeConnected(s);
  s.ping = setInterval(() => link.send({ type: 'ping' }), s.pingMs);
  if (s.service) link.send({ type: 'serviceState', ...s.service });
  if (s.saves) link.send({ type: 'saves', ...s.saves });
  if (s.installed) link.send({ type: 'installed', ...s.installed });
  tellEvents(s);
  s.settingsSent = '';
  tellSettings(s);
  s.onWelcome();
  if (s.reading) openGame(s, s.reading.modVersion);
}

function agentClosed(s: HubState, link: Link, why: string): void {
  if (s.agent !== link) return;
  s.agent = null;
  clearInterval(s.ping);
  closeGame(s, 'the Agent connection closed', false);
  if (s.stopping) return;
  if (link.tooFast) {
    // Harmless: the hub welcomed this agent under 5 s ago (a quick reconnect). Not a failure, and not logged as a
    // rejection, which the first-boot check would take for a refused token.
    const since = s.welcomedAt === null ? null : performance.now() - s.welcomedAt;
    log(s, `the hub welcomed this agent under ${s.welcomeGapMs / 1000} s ago: connecting again once that has passed`);
    s.retry = setTimeout(() => connect(s), tooFastWait(since, s.welcomeGapMs));
    return;
  }
  log(s, `no connection to the hub at ${s.config.hub.host}:${s.config.hub.port} (${why}): retrying`);
  s.retry = setTimeout(() => connect(s), backoff(s.failures++, s.backoffMs, s.maxBackoffMs, s.random));
}

/** `<root>/connected`, written whole or not at all: the deploy's gate reads it. */
async function writeConnected(s: HubState): Promise<void> {
  const file = join(s.config.root, 'connected');
  try {
    await writeAtomic(file, JSON.stringify({ version: s.version, time: Date.now() }) + '\n');
  } catch (err) {
    console.error(`[hub] can't write ${file}: ${(err as Error).message}`);
  }
}

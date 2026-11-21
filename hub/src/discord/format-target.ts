// The alerts channel's posts for events about the host, a service, a check or a deploy (`formatTargetEvent`): each
// notice names what it is about, as the channel is shared; samples and service states are not posted. Host notices:
// memory and disk (a mount `inline()`: an Agent's sample names it), `agentLost`/`agentBack` and `eventsOff`/`eventsOn`
// (the Agent's reason `inline()`), `nodeUpdate` (what to do, `NODE_STEPS`, as the description); a check's URL as the
// description; deploy notices, the Agent's as "the agent on <id>", with `from` escaped (a Mod's or an Agent's hello
// names it). Embeds by `format.ts`'s rules. Unit-tested.

import { DESCRIPTION, embed, inline, SEVERITY_COLORS, title, type Post } from './format.ts';
import { truncate, type TargetEvent } from '../servers/servers.ts';
import { formatBytes } from '../units.ts';

function targetText(e: Extract<TargetEvent, { type: 'notice' }>): string {
  switch (e.kind) {
    case 'checkDown':
      return `❌ Check ${e.id} is down: ${e.error}`;
    case 'checkUp':
      return `✅ Check ${e.id} is back up (${e.ms} ms)`;
    case 'memoryHigh':
      return `⚠️ Host ${e.id}: memory at ${e.percent}% for ${e.minutes} min`;
    case 'memoryOk':
      return `✅ Host ${e.id}: memory back to ${e.percent}%`;
    case 'diskLow':
      return `⚠️ Host ${e.id}: low disk on ${inline(e.mount)}: ${formatBytes(e.free)} free (limit ${e.minFreeGB} GB)`; // an Agent's sample names it
    case 'diskOk':
      return `✅ Host ${e.id}: disk on ${inline(e.mount)} back to ${formatBytes(e.free)} free`;
    case 'serviceFailed':
      return `❌ Service ${e.id} failed (${e.unit})`;
    case 'agentLost':
      return `⚠️ Host ${e.id}: agent ${e.name} is not connected`;
    case 'agentBack':
      return `✅ Host ${e.id}: agent ${e.name} is connected again`;
    case 'eventsOff': // the Agent's words
      return `⚠️ Host ${e.id}: game events from agent ${e.name} are off: ${inline(e.reason)}`;
    case 'eventsOn':
      return `✅ Host ${e.id}: game events from agent ${e.name} are on again`;
    case 'nodeUpdate': // both versions checked `vX.Y.Z` (`NODE_VERSION`): nothing to escape
      return `⬆️ Host ${e.id}: Node ${e.node} on agent ${e.name} is behind ${e.newest}`;
    // `from` is what the part said it runs (a Mod's or an Agent's hello): escaped. `to` is a tag GitHub listed.
    case 'deployStarted':
      return `🚀 Deploying ${deployed(e)}: ${e.from === null ? 'unknown' : inline(e.from)} → ${e.to} (by ${e.by})`;
    case 'deployFinished':
      if (e.outcome === 'ok') return `✅ Deployed ${deployed(e)}: ${e.to}`;
      if (e.outcome === 'rolled back') return `❌ Deploying ${deployed(e)} ${e.to} failed: rolled back to ${e.from === null ? 'the previous release' : inline(e.from)}`;
      return `❌ Deploying ${deployed(e)} ${e.to} failed`;
  }
}

/** What to do about a `nodeUpdate`: docs/RELEASING.md, "Updating Node on an Agent's Host". */
export const NODE_STEPS =
  "Bump `NODE_VERSION` and `NODE_SHA256` in `deploy/setup-agent-host.sh`, cut an Agent patch release, then ask the friend to re-run setup from that tag (docs/RELEASING.md, \"Updating Node on an Agent's Host\").";

/** What a deploy was of, and where: "the hub on production", "the Mod on gtnh", "the agent on factorio-vm". */
const deployed = (e: { part: string; id: string }) => `${{ hub: 'the hub', web: 'the dashboard', mod: 'the Mod', agent: 'the agent' }[e.part]} on ${e.id}`;

/**
 * The alerts channel's post for an event about the host, a service or a check, naming what it is about (the channel
 * is shared); null for events that aren't announced.
 */
export function formatTargetEvent(e: TargetEvent): Post | null {
  if (e.type !== 'notice') return null; // samples and service states are for the dashboard
  const url = 'url' in e ? { description: truncate(e.url, DESCRIPTION) } : e.kind === 'nodeUpdate' ? { description: NODE_STEPS } : {};
  return embed({ title: title(targetText(e)), ...url, color: SEVERITY_COLORS[e.severity] });
}

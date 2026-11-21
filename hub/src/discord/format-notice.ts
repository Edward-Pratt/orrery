// A server notice's embed title (`noticeText`; null for one that isn't posted: `packUpdateStep`, `saveUpload`,
// `settings`, and `modUpdates`, which is its own embed): a lag notice names the slowest dimension only in TPS
// (Minecraft); a factorio server's `packUpdateStarted`/`packUpdateFinished` worded as a game update, its `from` (the
// version the Agent reported) and the Agent's pre-update save through `inline()`; its `modUpdates` text
// (`modUpdatesText`, for a "Portal mod updates" embed in its own channel: each update's name and versions through
// `inline()`, the first 10, then "and N more"); its `verificationOff`/`verificationOn` (the dashboard user's name
// only when a save made it) and `settingsRolledBack` (naming the game password and user verification as put back too);
// every other text an Agent controls in a title through `inline()` (a backup's `detail`, a `restartFailed` error,
// `backupOverdue`'s newest Backup name).

import { countdownText } from '../servers/restarts.ts';
import type { Notice } from '../servers/servers.ts';
import type { Game } from '../types.ts';
import { formatBytes, formatDuration } from '../units.ts';
import { inline } from './format-text.ts';

/** A countdown's words: a restart's, or a stop's (of a server's service). */
const COUNTDOWN = { restart: { in: '🔄 Restart in', now: '🔄 Restarting now' }, stop: { in: '🛑 Stop in', now: '🛑 Stopping now' } };

/** A notice's title; null for one that isn't posted. A factorio server's updates are game updates (it has no pack). */
export function noticeText(n: Notice, game: Game): string | null {
  if (game === 'factorio' && (n.kind === 'packUpdateStarted' || n.kind === 'packUpdateFinished')) return gameUpdateText(n);
  switch (n.kind) {
    case 'restartScheduled':
      return `${COUNTDOWN[n.stop ? 'stop' : 'restart'].in} ${countdownText(n.ms)} (by ${n.by})`;
    case 'restartNow':
      return COUNTDOWN[n.stop ? 'stop' : 'restart'].now;
    case 'restartCancelled':
      return `❎ Restart cancelled (by ${n.by})`;
    case 'restartCancelledDown':
      return '❎ Restart cancelled (server went down)';
    case 'restartFailed':
      return `❌ Restart failed: ${inline(n.error)}`; // a factorio server's: its Agent's refusal
    case 'lag': {
      // Only Minecraft has dimensions to name (Factorio's rate is UPS); an older Mod sends none.
      if (n.label === 'UPS') return `🐢 Lag: ${n.tps.toFixed(1)} ${n.label}`;
      const where = n.worst ? `${n.worst.name} (DIM ${n.worst.id}) ${Math.round(n.worst.ms)} ms/tick` : 'unknown';
      return `🐢 Lag: ${n.tps.toFixed(1)} ${n.label}; slowest: ${where}`;
    }
    case 'lagRecovered':
      return `✅ ${n.label} back to normal (${n.tps.toFixed(1)})`;
    case 'backupOverdue':
      return `⚠️ No new backup for ${n.hours} h (newest: ${inline(n.newest)})`;
    case 'backupsMissing':
      return '⚠️ No backups found';
    case 'lowDisk':
      return `⚠️ Low disk space for backups: ${formatBytes(n.free)} free (limit ${n.minFreeGB} GB)`;
    case 'backupFinished':
      return `✅ Backup finished (${inline(n.detail)})`; // an Agent's detail is its own text
    case 'backupFailed':
      return `❌ Backup failed: ${inline(n.detail)}`;
    case 'packUpdateStarted':
      return n.from === n.to ? `📦 Applying pack changes to ${n.to} (by ${n.by})` : `📦 Updating the pack: ${n.from} → ${n.to} (by ${n.by})`;
    case 'packUpdateStep': // progress for the dashboard
    case 'saveUpload': // the dashboard's upload progress
    case 'settings': // for the dashboard's Settings tab
    case 'modUpdates': // its own embed, in formatEvent
      return null;
    case 'verificationOff':
      return `⚠️ User verification is now off on ${n.name}${n.by === null ? '' : ` (by ${n.by})`}: player names aren't checked.`;
    case 'verificationOn':
      return `✅ User verification is on again on ${n.name}${n.by === null ? '' : ` (by ${n.by})`}: player names are checked.`;
    case 'settingsRolledBack':
      return `❌ ${n.name} didn't start with its new settings: the Agent put back the previous ones, its game password and user verification included.`;
    case 'packUpdateFinished':
      switch (n.outcome) {
        case 'ok':
          return n.from === n.to ? `✅ Pack changes applied to ${n.to} (${formatDuration(n.ms)})` : `✅ Pack updated to ${n.to} (${formatDuration(n.ms)})`;
        case 'rolled back':
          return `❌ Pack update to ${n.to} rolled back: ${n.from} is running again.${n.backup ? ` Pre-update backup: ${n.backup}` : ''}`;
        case 'failed':
          return `❌ Pack update to ${n.to} failed: the server didn't come back, even after a rollback`;
        case 'failed before swap':
          return `❌ Pack update to ${n.to} failed after the stop, before any file changed: ${n.from} is starting again`;
        case 'failed in staging':
          return `⚠️ Pack update to ${n.to} failed while preparing: the server wasn't touched`;
        case 'cancelled':
          return `❎ Pack update to ${n.to} cancelled: the server wasn't touched`;
      }
  }
}

/**
 * A game update's start and end. `from` names the Factorio version the Agent reported (`installed`) and the pre-update
 * save is named in the game's folder: both `inline()`, as they go mid-line in the embed title. `to` is the version the
 * admin picked, checked as `X.Y.Z`.
 */
function gameUpdateText(n: Extract<Notice, { kind: 'packUpdateStarted' | 'packUpdateFinished' }>): string {
  const from = inline(n.from);
  if (n.kind === 'packUpdateStarted') return `📦 Updating the game: ${from} → ${n.to} (by ${n.by})`;
  switch (n.outcome) {
    case 'ok':
      return `✅ Game updated to ${n.to} (${formatDuration(n.ms)})`;
    case 'rolled back':
      return `❌ Game update to ${n.to} rolled back: ${from} is running again.${n.backup ? ` Pre-update save: ${inline(n.backup)}` : ''}`;
    case 'failed':
      return `❌ Game update to ${n.to} failed: the server didn't come back, even after a rollback`;
    case 'failed before swap':
      return `❌ Game update to ${n.to} failed after the stop, before anything changed: ${from} is starting again`;
    case 'failed in staging':
      return `⚠️ Game update to ${n.to} failed while preparing: the server wasn't touched`;
    case 'cancelled':
      return `❎ Game update to ${n.to} cancelled before the swap: nothing was changed`;
  }
}

/** A `modUpdates` notice's text: each update by name (the portal's names and versions escaped), and how many more. */
export function modUpdatesText(n: Extract<Notice, { kind: 'modUpdates' }>): string {
  const what = n.count === 1 ? '1 portal mod update fits' : `${n.count} portal mod updates fit`;
  const list = n.mods.map((m) => `**${inline(m.name)}** ${inline(m.from)} → ${inline(m.to)}`).join(', ');
  const more = n.count > n.mods.length ? ` and ${n.count - n.mods.length} more` : '';
  return `${what} Factorio ${inline(n.factorio)}: ${list}${more}. Update them from the dashboard's Game tab.`;
}

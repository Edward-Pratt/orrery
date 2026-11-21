// Pure Discord output: `formatEvent(e, game)` (`lost` and `paused` not posted; a `milestone` per kind (research, a
// force's first rocket, platform and landing), its `text` capped at 200 and `text`, `player` and `force` escaped, the
// force named only when set; notices by `format-notice.ts`, chat-like events as plain text, cut to 2000 characters
// after escaping), quest batches and new links, `formatNotice`, `formatOutput` (command output in one code block),
// `formatLinkHint` (`/link`'s answer, naming each game that has a server: "In Minecraft, type `/discord link CODE`
// within 10 minutes.", or each game's sentence, then "The code works for 10 minutes."). The rest by family:
// `format-text.ts` (`Post`, the escaping every string from a game goes through: `md()`, `inline()`, and the limits),
// `format-notice.ts` (a server notice's title), `format-stats.ts` (the stats and Backup posts, the daily summary),
// `format-presence.ts` (presence and topics), and `format-target.ts` for the host's, services', checks' and deploys'
// notices. This file re-exports the names callers import from it. Unit-tested.

import { GAMES } from '../servers/lag.ts';
import { stripCodes, truncate, type Announcement, type GameMsg, type HubEvent } from '../servers/servers.ts';
import type { Game } from '../types.ts';
import { modUpdatesText, noticeText } from './format-notice.ts';
import { formatSummary } from './format-stats.ts';
import { COLORS, DESCRIPTION, embed, md, plain, SEVERITY_COLORS, title, type Post } from './format-text.ts';

export { formatPresence, formatTopic, TOPIC_MIN_GAP_MS, topicDue, type TopicEdit } from './format-presence.ts';
export {
  formatBackupList,
  formatBackupStatus,
  formatLastSeen,
  formatPlayers,
  formatPlaytime,
  formatStatus,
  formatSummary,
  formatTop,
  formatTps,
  TOP_PERIODS,
} from './format-stats.ts';
export { chatContent, COLORS, DESCRIPTION, embed, inline, md, SEVERITY_COLORS, title, type Post } from './format-text.ts';

/** The most of a milestone's text a post shows (the subject only: a research, a planet, a platform's name). */
const MILESTONE_TEXT = 200;

/** A milestone's line: the mod sends its subject (`text`), the player for a landing, and a force other than `player`. */
function milestoneText(m: Extract<GameMsg, { type: 'milestone' }>): string {
  const what = md(truncate(m.text, MILESTONE_TEXT));
  const force = m.force ? ` (${md(m.force)})` : '';
  switch (m.kind) {
    case 'research':
      return `🔬 Research finished: **${what}**${force}`;
    case 'rocket': // the planet it left, empty if unknown
      return `🚀 First rocket launched${what ? ` from **${what}**` : ''}${force}`;
    case 'platform':
      return `🛰️ First space platform in orbit: **${what}**${force}`;
    case 'landing':
      return `🪐 First landing on **${what}**${m.player ? ` by **${md(m.player)}**` : ''}${force}`;
  }
}

/** What `/link` answers: how to type the code in each game that has a server. */
export function formatLinkHint(code: string, games: Game[]): string {
  const how: Record<Game, string> = {
    minecraft: `In Minecraft, type \`/discord link ${code}\``,
    factorio: `In Factorio, type \`/orrery-link ${code}\``,
  };
  const lines = GAMES.filter((g) => games.includes(g)).map((g) => how[g]);
  if (lines.length > 1) return `${lines.map((l) => `${l}.`).join(' ')} The code works for 10 minutes.`;
  return `${lines[0] ?? how.minecraft} within 10 minutes.`; // no servers at all: Minecraft's, as before Factorio
}

/** The Discord post for a hub event, or null for events that aren't announced. `game`: the server's (it words updates). */
export function formatEvent(e: HubEvent, game: Game = 'minecraft'): Post | null {
  switch (e.type) {
    case 'chat':
      return plain(`**${md(e.player)}**: ${md(e.message)}`);
    case 'say': // chat sent into the game: Discord's own came from its channel
      return e.source === 'dashboard' ? plain(`**${md(e.author)}** (dashboard): ${md(e.message)}`) : null;
    case 'join':
      return plain(`➡️ **${md(e.player)}** joined`);
    case 'leave':
      return plain(`⬅️ **${md(e.player)}** left`);
    case 'death':
      return plain(`💀 ${md(e.message)}`);
    case 'achievement':
      return plain(`🏆 **${md(e.player)}** earned **${md(e.achievement)}**`);
    case 'milestone':
      return plain(milestoneText(e));
    case 'started':
      return embed({ title: '✅ Server started', color: COLORS.green });
    case 'stopped':
      return embed({ title: '🛑 Server stopped', color: COLORS.grey });
    case 'crashed':
      return embed({ title: '💥 Server went down unexpectedly', color: COLORS.red });
    case 'hung':
      return embed({ title: '⚠️ Server not responding', color: COLORS.orange });
    case 'recovered':
      return embed({ title: '✅ Server responding again', color: COLORS.green });
    case 'notice': {
      if (e.kind === 'modUpdates') return embed({ title: '🧩 Portal mod updates', description: truncate(modUpdatesText(e), DESCRIPTION), color: SEVERITY_COLORS[e.severity] });
      const text = noticeText(e, game);
      return text === null ? null : embed({ title: title(text), color: SEVERITY_COLORS[e.severity] });
    }
    case 'questBatch':
      return formatQuests(e);
    case 'linked':
      return formatLinked(e.player, e.discordId);
    case 'summary':
      return formatSummary(e.name, e.summary);
    case 'connected': // may just be a reconnect after a hub restart
    case 'offline': // hub-start bookkeeping for uptime, not news
    case 'lost': // its Agent left: a planned exit is not news, and a lost Agent is a host notice
    case 'quest': // the QuestAnnouncer turns it into questBatch announcements
    case 'link': // answered by Links, which announces a new link
    case 'unlink':
    case 'backup': // the BackupWatcher publishes it as a notice
    case 'console': // the /cmd reply shows it to whoever ran it
    case 'tps': // for the dashboard; /tps and lag notices cover Discord
    case 'paused': // for the dashboard's card
      return null;
  }
}

/** A short informational line as an embed (e.g. a command's "server is offline" reply). */
export function formatNotice(text: string): Post {
  return embed({ title: title(text), color: COLORS.blue });
}

/** Command output as a code block that always fits in one Discord message. */
export function formatOutput(lines: string[]): string {
  const max = 1900;
  let text = stripCodes(lines.join('\n')).replaceAll('```', "'''") || '(no output)';
  if (text.length > max) text = truncate(text, max) + '\n… (truncated)';
  return '```\n' + text + '\n```';
}

/** A quest post: the quests completed at once, or a batched roll-up (`count` > quests shown). */
export function formatQuests(b: Omit<Extract<Announcement, { type: 'questBatch' }>, 'type'>): Post {
  const who = `📜 **${md(b.player)}** completed`;
  if (b.count > b.quests.length) return { content: `${who} ${b.count} quests (latest: **${md(b.quests[0].name)}**)` };
  const names = b.quests.slice(0, 5).map((q) => `**${md(q.name)}**`);
  const more = b.quests.length > 5 ? ` and ${b.quests.length - 5} more` : '';
  return { content: truncate(`${who} ${names.join(', ')}${more}`, 2000) };
}

/** The mention renders as a name but doesn't ping (allowedMentions is off for everything the bot posts). */
export function formatLinked(player: string, discordId: string): Post {
  return { content: `🔗 **${md(player)}** linked to <@${discordId}>` };
}

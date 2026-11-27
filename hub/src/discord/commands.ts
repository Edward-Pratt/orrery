// The slash commands (`COMMANDS`) and their answers (`handleCommand`), worded for any game: `/status` `/list` `/tps`
// `/playtime` `/top` `/link` (how to type the code in each game that has a server) `/unlink` (every game's link), and
// the admin commands `/cmd` (late output as follow-ups) `/restart` `/backup` (`backupCommand`: the server's Backups, a
// factorio server's saves, and `start` through `ServerHub.backup`), allowed by `adminRefusal` (a linked User's grants
// on the channel's server, else the admin role). Every action goes to the audit as `discord:<username> (<id>)`.

import { MessageFlags, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import {
  formatBackupList,
  formatBackupStatus,
  formatLinkHint,
  formatNotice,
  formatOutput,
  formatPlayers,
  formatPlaytime,
  formatStatus,
  formatTop,
  formatTps,
} from './format.ts';
import { ADMIN_COMMANDS, adminRefusal, type DiscordUsers } from './admin.ts';
import type { DiscordConfig } from '../config.ts';
import type { Links } from '../servers/links.ts';
import type { RestartScheduler } from '../servers/restarts.ts';
import type { ServerHub } from '../servers/servers.ts';
import type { Period, Stats } from '../stats/stats.ts';

// Admin commands are hidden (default_member_permissions "0") until the admin role (or a member) is allowed under
// Server Settings → Integrations; `adminRefusal` still decides either way.
export const COMMANDS = [
  new SlashCommandBuilder().setName('status').setDescription('Server status, TPS/UPS and uptime'),
  new SlashCommandBuilder().setName('list').setDescription('Players online'),
  new SlashCommandBuilder().setName('tps').setDescription("TPS/UPS now, over the last hour and day, and a Minecraft server's slowest dimensions"),
  new SlashCommandBuilder()
    .setName('playtime')
    .setDescription("A player's playtime and when they were last seen")
    .addStringOption((o) => o.setName('player').setDescription('In-game name'))
    .addUserOption((o) => o.setName('user').setDescription('Or a Discord member who has linked their account')),
  new SlashCommandBuilder().setName('link').setDescription('Link your Discord account to your in-game name'),
  new SlashCommandBuilder().setName('unlink').setDescription('Remove the link to your in-game name'),
  new SlashCommandBuilder()
    .setName('top')
    .setDescription('Top players by playtime')
    .addStringOption((o) =>
      o
        .setName('period')
        .setDescription('Default: last 7 days')
        .addChoices(
          { name: 'last 24 hours', value: 'day' },
          { name: 'last 7 days', value: 'week' },
          { name: 'all time', value: 'all' },
        ),
    ),
  new SlashCommandBuilder()
    .setName('cmd')
    .setDescription('Run a server console command (admins only)')
    .setDefaultMemberPermissions(0)
    .addStringOption((o) => o.setName('command').setDescription('The command, as typed in the server console').setRequired(true)),
  new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restart the server with an in-game countdown (admins only)')
    .setDefaultMemberPermissions(0)
    .addSubcommand((s) =>
      s
        .setName('in')
        .setDescription('Schedule a restart')
        .addIntegerOption((o) =>
          o.setName('minutes').setDescription('Countdown length (0 = now)').setMinValue(0).setMaxValue(60).setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancel the scheduled restart')),
  new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Backups (admins only)')
    .setDefaultMemberPermissions(0)
    .addSubcommand((s) => s.setName('start').setDescription('Start a backup now and report when it finishes'))
    .addSubcommand((s) => s.setName('status').setDescription('Newest backup, count and total size'))
    .addSubcommand((s) => s.setName('list').setDescription('The 10 newest backups with sizes')),
].map((c) => c.toJSON());

/** The parts of a slash command's interaction `/backup` uses. */
export type BackupInteraction = Pick<ChatInputCommandInteraction, 'reply' | 'deferReply' | 'editReply'> & {
  options: Pick<ChatInputCommandInteraction['options'], 'getSubcommand'>;
};

/**
 * `/backup` in a server's channel (its admin check already passed): `status` and `list` of the server's Backups (a
 * factorio server's saves), or `start`, a Backup now through `ServerHub.backup` as `by`. The finished/failed notice
 * follows in the channel, from the game's backup event.
 */
export async function backupCommand(
  i: BackupInteraction,
  hub: Pick<ServerHub, 'get' | 'backup'>,
  stats: Pick<Stats, 'backups'>,
  serverId: string,
  by: string,
): Promise<void> {
  const b = (await stats.backups(serverId))!;
  if (!b.configured) {
    await i.reply({ content: 'Set "dir" (or "backupDir") for this server in config.json.', flags: MessageFlags.Ephemeral });
    return;
  }
  const sub = i.options.getSubcommand();
  if (sub === 'status') {
    await i.reply(formatBackupStatus(b.backups, Date.now(), b.free));
  } else if (sub === 'list') {
    await i.reply(formatBackupList(b.backups));
  } else {
    await i.deferReply();
    try {
      const output = await hub.backup(serverId, by);
      // A Mod answers with its command's output; an Agent's save has none.
      await i.editReply(hub.get(serverId)?.game === 'factorio' ? '💾 Saving: the notice follows here once the save is written.' : formatOutput(output));
    } catch (err) {
      await i.editReply(`❌ ${(err as Error).message}`);
    }
  }
}

/** What a slash command's answer reads: the bot's parts and its channel → server map (none of it changed here). */
export type CommandCtx = {
  hub: ServerHub;
  stats: Stats;
  restarts: RestartScheduler;
  links: Links;
  cfg: DiscordConfig;
  serverByChannel: Map<string, string>;
  /** The Users whose grants decide a linked member's admin commands; undefined while the web integration is off. */
  users?: DiscordUsers;
};

/** Answers a slash command in a server's channel; the admin commands only for whom `adminRefusal` allows. */
export async function handleCommand(ctx: CommandCtx, i: ChatInputCommandInteraction): Promise<void> {
  const { hub, stats, restarts, links, cfg, serverByChannel, users } = ctx;
  const serverId = serverByChannel.get(i.channelId);
  const state = serverId ? hub.get(serverId) : undefined;
  if (!serverId || !state) {
    await i.reply({ content: 'This channel is not linked to a server.', flags: MessageFlags.Ephemeral });
    return;
  }
  const now = Date.now();
  if (i.commandName === 'status') {
    const s = stats.status(serverId, now)!;
    await i.reply(formatStatus(s.state, s.uptimeDay, s.uptimeWeek));
    return;
  }
  if (i.commandName === 'list') {
    await i.reply(state.online ? formatPlayers(state.players) : formatNotice(`🔴 ${state.name} is offline`));
    return;
  }
  if (i.commandName === 'tps') {
    const t = stats.tps(serverId, now)!;
    await i.reply(formatTps(t.state, t.lastHour, t.hour, t.day));
    return;
  }
  if (i.commandName === 'link') {
    const code = links.issue(i.user.id, i.user.username);
    const games = [...new Set(hub.list().map((s) => s.game))];
    await i.reply({ content: formatLinkHint(code, games), flags: MessageFlags.Ephemeral });
    return;
  }
  if (i.commandName === 'unlink') {
    const removed = links.unlinkDiscord(i.user.id);
    await i.reply({ content: removed ? 'Unlinked.' : "You weren't linked.", flags: MessageFlags.Ephemeral });
    return;
  }
  if (i.commandName === 'playtime') {
    const user = i.options.getUser('user');
    const p = stats.playtime(serverId, user ? { discordId: user.id } : { player: i.options.getString('player') ?? undefined }, now)!;
    if (!p.found) {
      const content = user ? `${user.username} hasn't linked an in-game name here (use /link).` : 'Give a player name or a Discord user.';
      await i.reply({ content, flags: MessageFlags.Ephemeral });
      return;
    }
    await i.reply(formatPlaytime(p.player, p.totalMs, p.weekMs, p.lastSeen, now));
    return;
  }
  if (i.commandName === 'top') {
    const period = (i.options.getString('period') ?? 'week') as Period;
    await i.reply(formatTop(period, stats.top(serverId, period, now)!));
    return;
  }
  if (!ADMIN_COMMANDS.has(i.commandName)) return;
  const hasAdminRole = i.inCachedGuild() && i.member.roles.cache.has(cfg.adminRoleId);
  const refusal = adminRefusal(users, { discordId: i.user.id, hasAdminRole }, i.commandName, serverId);
  if (refusal) {
    await i.reply({ content: refusal, flags: MessageFlags.Ephemeral });
    return;
  }
  const audit = `discord:${i.user.username} (${i.user.id})`;
  if (i.commandName === 'cmd') {
    await i.deferReply(); // commands can take longer than Discord's 3 s reply window
    try {
      // Replies that arrive later (e.g. spark's profiler link) are posted as follow-ups.
      const onLate = (lines: string[]) => {
        i.followUp(formatOutput(lines)).catch((err) => console.error('[discord] late output follow-up failed:', err));
      };
      await i.editReply(formatOutput(await hub.runCommand(serverId, i.options.getString('command', true), audit, onLate)));
    } catch (err) {
      await i.editReply(`❌ ${(err as Error).message}`);
    }
  } else if (i.commandName === 'restart') {
    // The public announcement comes from the scheduler's notice; the reply is just for the admin.
    let reply: string;
    if (i.options.getSubcommand() === 'cancel') {
      reply = restarts.cancel(serverId, audit, i.user.username) ? 'Restart cancelled.' : 'No restart is scheduled.';
    } else {
      try {
        restarts.schedule(serverId, i.options.getInteger('minutes', true), audit, i.user.username);
        reply = 'Restart scheduled.';
      } catch (err) {
        reply = `❌ ${(err as Error).message}`;
      }
    }
    await i.reply({ content: reply, flags: MessageFlags.Ephemeral });
  } else if (i.commandName === 'backup') {
    await backupCommand(i, hub, stats, serverId, audit);
  }
}

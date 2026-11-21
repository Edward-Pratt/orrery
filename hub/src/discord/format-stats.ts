// The stats posts: `/status` (a server's rate named and scaled by `rateOf`), `/list`, `/playtime` (`formatLastSeen`),
// `/top` (`TOP_PERIODS`), `/tps` (a trend, and a Minecraft server's slowest dimensions), `/backup status` and `list`
// (Backup names escaped: with `md()` as the newest, without a backtick in the list's code spans, as an Agent's come
// from the game's folder), and the daily summary (`formatSummary`). Player names through `md()`.

import { growthPerDay, type Backup } from '../backups/backups.ts';
import { rateOf, sparkline } from '../servers/lag.ts';
import { truncate, type ServerState } from '../servers/servers.ts';
import type { Summary } from '../stats/summary.ts';
import { formatBytes, formatDuration } from '../units.ts';
import { COLORS, DESCRIPTION, embed, FIELD, md, title, type Post } from './format-text.ts';

const pct = (u: number | null) => (u === null ? 'n/a' : `${(u * 100).toFixed(1)}%`);

export function formatStatus(s: ServerState, day: number | null, week: number | null): Post {
  const [state, color] = !s.online
    ? ['🔴 Offline', COLORS.red]
    : s.hung
      ? ['🟠 Not responding', COLORS.orange]
      : ['🟢 Online', COLORS.green];
  const fields = [
    ...(s.online
      ? [
          { name: rateOf(s.game).label, value: s.tps === null ? 'n/a' : s.tps.toFixed(1), inline: true },
          { name: 'Players', value: String(s.players.length), inline: true },
        ]
      : []),
    { name: 'Uptime 24 h', value: pct(day), inline: true },
    { name: 'Uptime 7 d', value: pct(week), inline: true },
  ];
  if (s.online && s.players.length) fields.push({ name: 'Online now', value: truncate(s.players.map(md).join(', '), FIELD), inline: false });
  return embed({ title: title(`${s.name} — ${state}`), color, fields });
}

export function formatPlayers(players: string[]): Post {
  if (!players.length) return embed({ title: 'Nobody online', color: COLORS.blue });
  return embed({
    title: `Online (${players.length})`,
    description: truncate(players.map(md).join(', '), DESCRIPTION),
    color: COLORS.blue,
  });
}

export function formatLastSeen(seen: { online: true } | number | null, now: number): string {
  if (seen === null) return 'never';
  if (typeof seen === 'object') return 'online now';
  return `${formatDuration(now - seen)} ago`;
}

export function formatPlaytime(player: string, totalMs: number, weekMs: number, seen: { online: true } | number | null, now: number): Post {
  return embed({
    title: 'Playtime',
    color: COLORS.blue,
    fields: [
      { name: 'Player', value: md(player), inline: false },
      { name: 'Total', value: formatDuration(totalMs), inline: true },
      { name: 'Last 7 days', value: formatDuration(weekMs), inline: true },
      { name: 'Last seen', value: formatLastSeen(seen, now), inline: true },
    ],
  });
}

export const TOP_PERIODS = { day: 'last 24 hours', week: 'last 7 days', all: 'all time' } as const;

export function formatTop(period: keyof typeof TOP_PERIODS, rows: { player: string; ms: number }[]): Post {
  const lines = rows.map((r, i) => `${i + 1}. **${md(r.player)}**: ${formatDuration(r.ms)}`);
  return embed({
    title: `Top players (${TOP_PERIODS[period]})`,
    description: truncate(lines.join('\n'), DESCRIPTION) || 'No playtime recorded.',
    color: COLORS.blue,
  });
}

const totalSize = (backups: Backup[]) => formatBytes(backups.reduce((sum, b) => sum + b.size, 0));
const formatGrowth = (g: number) => `${g < 0 ? '−' : '+'}${formatBytes(Math.abs(g))}/day`;
const formatFree = (free: number | null) => (free === null ? 'n/a' : formatBytes(free));

export function formatBackupStatus(backups: Backup[], now: number, free: number | null): Post {
  const newest = backups[0];
  if (!newest) return embed({ title: 'Backups', description: 'No backups found.', color: COLORS.orange });
  const growth = growthPerDay(backups);
  return embed({
    title: 'Backups',
    color: COLORS.blue,
    fields: [
      { name: 'Newest', value: truncate(md(newest.name), FIELD), inline: false },
      { name: 'Age', value: `${formatDuration(now - newest.mtimeMs)}`, inline: true },
      { name: 'Size', value: formatBytes(newest.size), inline: true },
      { name: 'Count', value: String(backups.length), inline: true },
      { name: 'Total size', value: totalSize(backups), inline: true },
      { name: 'Free disk', value: formatFree(free), inline: true },
      ...(growth === null ? [] : [{ name: 'Growth', value: formatGrowth(growth), inline: true }]),
    ],
  });
}

export function formatBackupList(backups: Backup[]): Post {
  if (!backups.length) return embed({ title: 'Backups', description: 'No backups found.', color: COLORS.orange });
  // A name (an Agent's save's comes from the game's folder) can't end its code span early.
  const lines = backups.slice(0, 10).map((b) => `\`${b.name.replaceAll('`', "'")}\` ${formatBytes(b.size)}`);
  return embed({
    title: `Backups: ${backups.length}, ${totalSize(backups)} total`,
    description: truncate(lines.join('\n'), DESCRIPTION),
    color: COLORS.blue,
  });
}

export function formatSummary(serverName: string, s: Summary): Post {
  const top = s.top.map((p, i) => `${i + 1}. **${md(p.player)}**: ${formatDuration(p.ms)}`).join('\n') || 'Nobody played.';
  const b = s.backups;
  const backups = b && [`${b.count}`, `${formatBytes(b.total)} total`, `${formatFree(b.free)} free`, ...(b.growth === null ? [] : [formatGrowth(b.growth)])];
  return embed({
    title: title(`📊 ${serverName}: ${s.day}`),
    color: COLORS.blue,
    fields: [
      { name: 'Uptime', value: pct(s.uptime), inline: true },
      { name: 'Peak players', value: s.peak === null ? 'n/a' : String(s.peak), inline: true },
      { name: 'Unique players', value: String(s.unique), inline: true },
      { name: 'Total playtime', value: formatDuration(s.totalMs), inline: true },
      { name: 'Starts', value: String(s.starts), inline: true },
      { name: 'Crashes', value: String(s.crashes), inline: true },
      { name: 'Top players', value: truncate(top, FIELD), inline: false },
      ...(backups ? [{ name: 'Backups', value: backups.join(', '), inline: false }] : []),
    ],
  });
}

export function formatTps(
  s: ServerState,
  lastHour: { ts: number; tps: number }[],
  hour: { avg: number; min: number } | null,
  day: { avg: number; min: number } | null,
): Post {
  if (!s.online || s.tps === null) return embed({ title: title(`${s.name}: offline`), color: COLORS.red });
  const { label, max } = rateOf(s.game);
  // Bands as a share of full speed: 18 and 12 TPS of Minecraft's 20.
  const color = s.tps >= 0.9 * max ? COLORS.green : s.tps >= 0.6 * max ? COLORS.orange : COLORS.red;
  const stat = (x: { avg: number; min: number } | null, withMin: boolean) =>
    x === null ? 'n/a' : withMin ? `${x.avg.toFixed(1)} (min ${x.min.toFixed(1)})` : x.avg.toFixed(1);
  const fields = [
    { name: 'Last hour', value: stat(hour, true), inline: true },
    { name: 'Last 24 h', value: stat(day, false), inline: true },
  ];
  if (lastHour.length) fields.push({ name: 'Trend (1 sample/min)', value: sparkline(lastHour.slice(-60).map((x) => x.tps), max), inline: false });
  if (s.dims.length) {
    const dims = s.dims.map((d) => `${md(d.name)} (DIM ${d.id}): ${Math.round(d.ms)} ms/tick`).join('\n');
    fields.push({ name: 'Slowest dimensions', value: truncate(dims, FIELD), inline: false });
  }
  return embed({ title: title(`${s.name}: ${s.tps.toFixed(1)} ${label}`), color, fields });
}

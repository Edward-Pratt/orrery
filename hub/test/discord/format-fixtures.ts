// The format tests' shared pieces: `first` (a post's first embed) and `online` (a minecraft server's state with two
// players), for `format-stats.test.ts`, `format-presence.test.ts` and `format-notice.test.ts`.

import type { APIEmbed } from 'discord.js';
import type { Post } from '../../src/discord/format.ts';
import type { ServerState } from '../../src/servers/servers.ts';

export const first = (p: Post) => (p as { embeds: APIEmbed[] }).embeds[0];

export const online: ServerState = { id: 'gtnh', name: 'GTNH', game: 'minecraft', online: true, hung: false, paused: false, tps: 19.7, players: ['Steve', 'Alex'], dims: [] };

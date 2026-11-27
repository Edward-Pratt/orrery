# discord

The Discord integration, a frontend. `discord.ts` is the bot: the client and its intents, webhook chat, notices,
presence and topics, wired from its parts: `relay.ts` (the chat bridge's rules: `shouldRelay`, `relayAs`, `sendChat`),
`alerts.ts` (where an event is posted, `channelFor`, and the alerts channel's posts, an Agent's lost and back held to
one per 10 minutes), `commands.ts` (the slash commands, `/cmd` among them) and `admin.ts` (who may run the admin ones: a linked User's
grants, else the admin role). `format.ts` is pure Discord output,
every string from a game escaped: the event posts, with its families beside it: `format-text.ts` (`Post`, `md()`,
`inline()`, the limits), `format-notice.ts` (a server notice's title), `format-stats.ts` (the stats and Backup posts,
the daily summary), `format-presence.ts` (presence and topics) and `format-target.ts` for the alerts channel's notices
(the host, services, checks and deploys). `discord.ts` and `format.ts` re-export their parts' public names. Each
file's header is its contract. Tests: `test/discord/` (the format tests one file per family, sharing
`format-fixtures.ts`).

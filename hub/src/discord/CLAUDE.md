# discord

The Discord integration, a frontend. `discord.ts` is the bot: webhook chat, notices, `/cmd`; `format.ts` is pure
Discord output, every string from a game escaped, with `format-target.ts` for the alerts channel's notices (the host,
services, checks and deploys). Each file's header is its contract. Tests: `test/discord/`.

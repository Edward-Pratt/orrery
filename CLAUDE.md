# gtnh-discord

Discord bridge for GT: New Horizons (MC 1.7.10) servers. Two independent projects in one repo:

- `hub/` — Node/TypeScript Discord bot and the "brain". See `hub/CLAUDE.md`.
- `mod/` — server-side Forge 1.7.10 mod, a thin adapter. See `mod/CLAUDE.md`.
- `docs/superpowers/specs/` — design spec (authoritative); `docs/superpowers/plans/` — implementation plans.

Nothing builds at the root: run npm in `hub/`, Gradle in `mod/`.

## Architecture rules

- Mods connect **out** to the hub (TCP `127.0.0.1:25580`, newline-delimited JSON, protocol v1).
- The hub owns all state. Frontends (Discord now, web dashboard later) only call `ServerHub`'s public
  API in `hub/src/servers.ts`; they never talk to mods. Discord-specific config stays in `discord.ts`.
- The mod has no business logic and no Discord knowledge.

## Changing the wire protocol

Protocol lives in three places that must change together:
1. `hub/src/protocol.ts` (types + `SCHEMAS` validation),
2. the mod (`HubClient.java` hello, `GameEvents.java` messages),
3. the spec's Protocol section.
Bump `PROTOCOL_VERSION` (and the mod's hello `protocol`) for any incompatible change.

## Verify before claiming done

```bash
cd hub && npm test && npm run typecheck
cd mod && ./gradlew spotlessApply build   # runs JUnit tests too
```

Behaviour that needs a real server (event hooks, command capture) can only be checked by the manual
smoke test at the end of the plan — say so rather than claiming it works.

## Secrets

`hub/config.json` (server tokens, IDs) and `.env` (`DISCORD_TOKEN`) are git-ignored. Never commit them.

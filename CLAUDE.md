# gtnh-discord

Discord bridge for GT: New Horizons (MC 1.7.10) servers. Two independent projects in one repo:

- `hub/` — Node/TypeScript Discord bot and the "brain". See `hub/CLAUDE.md`.
- `mod/` — server-side Forge 1.7.10 mod, a thin adapter. See `mod/CLAUDE.md`.
- `deploy/` — systemd units for the production host (hub; GTNH server with a FIFO console, no tmux — SELinux-safe),
  and `restore-backup.sh` (puts a backup back over a stopped server's world; tested by `test-restore-backup.sh`).
- `docs/protocol.md` — the wire protocol (living, authoritative). Specs and tickets are GitHub issues
  (`/to-spec`, `/to-tickets`); `docs/archive/` holds the v1–v1.3 specs and plans (deprecated, history only).
- `docs/ROADMAP.md` — planned releases, linking each to its spec issue; update it when a release ships or scope moves.

Nothing builds at the root: run npm in `hub/`, Gradle in `mod/`.

## Architecture rules

- Mods connect **out** to the hub (TCP `127.0.0.1:25580`, newline-delimited JSON, protocol v1).
- The hub owns all state. Frontends (Discord now, web dashboard later) only call the public
  API of `ServerHub` (`hub/src/servers.ts`), `RestartScheduler` and `Stats` (`hub/src/stats.ts`); they
  never talk to mods. Discord-specific config stays in `discord.ts`.
- The mod has no business logic and no Discord knowledge.
- v2 is changing this: the hub becomes a platform with built-in integrations and a separate dashboard
  (`docs/adr/0002`, `CONTEXT.md`). The rules above describe the code as it is until that lands.

## Changing the wire protocol

Protocol lives in three places that must change together:
1. `hub/src/protocol.ts` (types + `SCHEMAS` validation),
2. the mod (`HubClient.java` hello, `GameEvents.java` messages),
3. `docs/protocol.md`.
Bump `PROTOCOL_VERSION` (and the mod's hello `protocol`) for any incompatible change.
The hub accepts `MIN_PROTOCOL..PROTOCOL_VERSION` (`protocol.ts`). Policy: keep the previous version supported, so
raise `MIN_PROTOCOL` only one release after a bump.

## Verify before claiming done

```bash
cd hub && npm test && npm run typecheck
cd mod && ./gradlew spotlessApply build   # runs JUnit tests too
bash deploy/test-restore-backup.sh        # needs zip and unzip
```

Behaviour that needs a real server (event hooks, command capture) can only be checked by the manual
smoke test in the release's tickets — say so rather than claiming it works.

## Releases

Hub and mod are versioned separately (`docs/adr/0001`). Tag `hub-vX.Y.Z` or `mod-vX.Y.Z` on `main` and push
the tag: `.github/workflows/release.yml` runs CI, then creates the GitHub release. Its notes are that part's
commits, and for the mod it attaches the jar. The hub is deployed with `git checkout hub-vX.Y.Z` on the server.

## Secrets

`hub/config.json` (server tokens, IDs) and `.env` (`DISCORD_TOKEN`) are git-ignored. Never commit them.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `Edward-Pratt/gtnh-discord` (via `gh`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

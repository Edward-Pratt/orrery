# hub

Node 26 + TypeScript + discord.js 14. Node runs `.ts` directly (type stripping) — there is no build step.

```bash
npm test            # node --test "test/*.test.ts"
npm run typecheck   # tsc, noEmit
npm start           # node src/index.ts; reads ./config.json (or argv[2]) and env DISCORD_TOKEN
```

## TypeScript constraints (type stripping)

- Erasable syntax only: no `enum`, `namespace`, or constructor parameter properties.
- Relative imports include the `.ts` extension; type-only imports use `import type` / `type X`.

## Modules

| File | Job |
|---|---|
| `src/protocol.ts` | Wire types + `parseModLine` validation. The contract with the mod. |
| `src/servers.ts` | `ServerHub`: TCP server, per-server state, liveness (crash/stop/hung), `say`, `runCommand`, `event` emitter. The API frontends use. |
| `src/db.ts` | SQLite (`node:sqlite`) up/down/unknown log and uptime math. |
| `src/discord.ts` | Discord frontend: relay, alerts, `/status` `/list` `/cmd`; pure `format*` helpers are unit-tested. |
| `src/index.ts` | Config loading and wiring only. |

A future web dashboard goes in `src/web/` and calls `ServerHub` — never the mod sockets.

## Dependencies

Runtime: `discord.js` only. Prefer Node built-ins (`node:net`, `node:readline`, `node:sqlite`,
`node:test`, `node:crypto`) over adding packages.

## Trust boundaries (do not weaken)

- Mod input: every line goes through `parseModLine` (checks `Object.hasOwn` on the type and field types).
  Tokens ≥16 chars, compared with `timingSafeEqual`. Hub binds `127.0.0.1`.
- Discord → MC: `ServerHub.say` cleans text with `mcText` (strips `§` codes/control chars, caps 256).
- MC → Discord: `md()` escapes markdown incl. headings/masked links; the Client uses
  `allowedMentions: { parse: [] }` so nothing the bot posts can ping.
- `/cmd`: admin role check + `deferReply`; `runCommand` logs who ran it.

## Tests

`test/servers.test.ts` drives a real socket with a fake mod (`fakeMod`, `online`, `until` helpers) — use it
for any hub behaviour change. Keep timing-sensitive tests on small `HubOptions` timeouts, not sleeps of seconds.

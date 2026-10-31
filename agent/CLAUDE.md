# agent (orrery-agent)

A Node service on a remote Host. It dials out to the hub with its token and runs that Host's Factorio server: RCON,
the Factorio mod's events, the server's unit, saves, host samples and updates. Node 24+ + TypeScript, run directly
(type stripping, no build step) like the hub. No runtime dependencies: Node built-ins only.

```bash
npm test            # node --test "test/*.test.ts"
npm run typecheck   # tsc, noEmit
```

## TypeScript constraints (type stripping)

- Erasable syntax only: no `enum`, `namespace`, or constructor parameter properties.
- Relative imports include the `.ts` extension; type-only imports use `import type` / `type X`.

## Modules

| File | Job |
|---|---|
| `src/rcon.ts` | `Rcon`: a Source RCON client for one connection. `Rcon.connect(host, port, password, timeoutMs)` authenticates (a refused password, id -1, rejects); `exec(command, timeoutMs)` resolves with the whole reply, one command in flight at a time, each followed by an empty command whose answer marks the reply's end (joined across packets before UTF-8 decoding). Ids are non-zero and rising; packets over `MAX_PACKET` (4 MiB) or malformed end the connection. A timeout ends it too; once authenticated, an end other than `close()` emits `close` once, so the caller reconnects with a new `Rcon`. `encode`/`decode` are the framing. |

## Trust boundaries (do not weaken)

- The agent never runs a path or argv it received from the hub. Every request maps to a fixed operation on its own
  configured unit, folders and file names, and a name is checked against the agent's own listing.

## Tests

`test/rcon.test.ts` drives a real socket with a fake RCON server (`fakeRcon` in `test/fake-rcon.ts`, Source-shaped:
an empty response before the auth answer, commands answered in order). Keep timing-sensitive tests on small timeouts,
not sleeps of seconds.

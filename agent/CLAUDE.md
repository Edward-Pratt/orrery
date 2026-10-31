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
| `src/rcon.ts` | `Rcon`: a Source RCON client for Factorio's RCON, one connection. `Rcon.connect(host, port, password, timeoutMs)` authenticates (a refused password, id -1, rejects); `exec(command, timeoutMs)` resolves with the reply, one command in flight at a time. Factorio answers each command with exactly one packet of any size carrying its id, so the reply is that packet's body with one trailing `\n` stripped; packets with any other id (or type) are dropped. No packet with an empty body is ever sent (Factorio never answers one), so an empty command is refused. Ids are non-zero and rising; a packet over `MAX_PACKET` (16 MiB) or malformed ends the connection, refused as soon as its length field is in. A timeout ends it too; once authenticated, an end other than `close()` emits `close` once, so the caller reconnects with a new `Rcon`. `encode`/`decode` are the framing. |

## Trust boundaries (do not weaken)

- The agent never runs a path or argv it received from the hub. Every request maps to a fixed operation on its own
  configured unit, folders and file names, and a name is checked against the agent's own listing.

## Tests

`test/rcon.test.ts` drives a real socket with a fake RCON server (`fakeRcon` in `test/fake-rcon.ts`, shaped like
Factorio 2.1 as checked on a real 2.1.24 server: one auth reply, -1 for a wrong password (else the request's id);
one reply packet per command, every printed line ending in `\n`; a packet with an empty body never answered;
commands answered in order; `writeSize` cuts each reply packet into small writes). Keep timing-sensitive tests on
small timeouts, not sleeps of seconds.

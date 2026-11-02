# services

Services and Checks (CONTEXT.md). `services.ts` is the listed systemd units, local or backed by an Agent, and what
the hub may do to them; `checks.ts` the standalone URL checks; `health.ts` the hub's own liveness ping and the GET
both use. Each file's header is its contract. Tests: `test/services/`.

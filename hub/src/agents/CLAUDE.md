# agents

Agents and Hosts (CONTEXT.md). `agents.ts` is the Agent port: the `Agents` class, with the tailnet listener, the
handshake and each Agent's two connections, its game connection handed to `ServerHub`; it re-exports the rest of the
folder's public names. `listener.ts` is the port's sockets (the address check, the line reader, `reject`), `budgets.ts`
the rate limits (the one table of the port's budgets), `dispatch.ts` what an Agent connection's lines do (pushes,
`events`, host samples, the request and reply bookkeeping) and a heartbeat's new players, `public.ts` the exported
types, `AgentRefused` and the Agent release floors. `host.ts` is every Host the hub knows, measured by its Agent or,
for the hub's own, by the hub. Each file's header is its contract. Tests: `test/agents/`.

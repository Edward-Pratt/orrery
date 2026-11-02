# agents

Agents and Hosts (CONTEXT.md). `agents.ts` is the Agent port: the tailnet listener, the handshake, the rate limits,
and each Agent's two connections, its game connection handed to `ServerHub`. `host.ts` is every Host the hub knows,
measured by its Agent or, for the hub's own, by the hub. Each file's header is its contract. Tests: `test/agents/`.

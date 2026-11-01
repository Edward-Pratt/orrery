# A remote Host runs its server through an Agent that dials out to the hub

The Factorio server runs on a friend's Oracle Linux 9 aarch64 VM, which also runs his own software and which the
owner never logs in to. The hub stays the owner of all state, on the owner's host (ADR 0002). Everything local to the
remote Host (RCON, the Factorio mod's events, `factorio.service`, saves, host samples) belongs to an **Agent**: a small
Node/TypeScript service (`agent/`) that runs natively there, dials out to the hub and carries out the hub's requests.
So do game updates and the Agent's own deploys (release 2, `docs/ROADMAP.md`): the hub picks the versions and the
release, the Agent carries them out. Release 1's Agent (`agent-v1.0.0`) had neither, so the friend re-runs the setup
once, at `agent-v1.1.0` or later; after that he re-runs it only for what it installs (the units, polkit file,
`factorio.container`, `deploy-agent.sh`, the image).

- **The Agent dials out**, like the Mod, to the hub's Agent port (25584, `integrations.agents.listen`), a listener of
  its own bound to the hub's tailnet address. The Mod port (25580) and the web API stay on loopback, so "the hub binds
  127.0.0.1" still holds for Minecraft, and the remote Host opens no port for the hub.
- **The network is the friend's Tailscale tailnet.** The hub host joins it as `tag:orrery-hub` (`--accept-dns=false`,
  Tailscale SSH off), and the friend's policy lets `tag:factorio` reach `tag:orrery-hub` on tcp:25584 only. He administers that
  policy, so the guard the owner controls is the hub host's firewalld zone `tailnet`: `tailscale0`, the default
  reject target, no open ports and one rich rule admitting only the remote Host's tailnet IP on 25584/tcp. Tailscale
  adds netfilter rules of its own, so a port scan from the remote Host has to prove the zone holds.
- **An Agent is known by its token and its peer address.** One token per Agent (at least 32 characters, compared in
  constant time) and its tailnet address, both in config. The address is checked when the connection is accepted,
  before any byte is read, for either first line; a mismatch closes the socket without a word.
- **No TLS inside the tailnet.** WireGuard already encrypts it.
- **No SSH from the hub.** The hub holds no credential for the remote Host; the friend runs every setup step himself
  (`deploy/setup-agent-host.sh`, as root). All the hub can cause there is one of the Agent's fixed operations on its
  own configured unit, folders and file names; the Agent never runs a path or argv from the hub.
- **One protocol version.** `agentHello.protocol` is the Mod's `PROTOCOL_VERSION`, accepted in the same range, and an
  Agent's game connection is a Mod connection to `ServerHub`. The Agent's additions are additive, so neither the
  version nor the Forge mod changes (`docs/protocol.md`, "Agent connection").
- **Factorio runs in Podman, the Agent natively.** Factorio 2.1's ARM64 headless build needs GLIBC_2.38; OL9 has
  2.34. So Factorio gets a container with a newer glibc and OL9 stays as it is: a rootful system Quadlet unit,
  `factorio.service`, runs a minimal image pinned by digest as `factorio`'s uid, with host networking and the game's
  files bind-mounted from the Host. Rootful, so the Agent controls it with plain `systemctl` through polkit; it never
  runs `podman`. Setup needs Podman 4.6 or newer and never changes Podman. The container is trusted less than the
  Agent (it faces the internet and runs third-party Lua), so the Agent keeps its state in `/srv/orrery-agent`, which
  the container never mounts.

The Agent port is hostile input. Anything the tailnet policy lets through can reach it, the Agent's end is another
person's machine, and the hub also runs the GTNH bridge, the Discord bot and the dashboard: one bad line must never
take it down. So, on top of the address check (details in `docs/protocol.md`, "Field limits" and "Agent connection"):

- **A line cap of 1 MiB.** One line is at most 1,048,576 bytes (`LIMITS.lineBytes`, its newline not counted), before
  and after the handshake; a longer line destroys the socket before more of it is kept. The design said 64 KiB, but
  its own field limits allow longer legal lines (a command's output is up to 500 lines of 1 KiB, a reply's data 256 KiB
  as JSON), so 64 KiB would have refused them. Claude set 1 MiB on 2026-10-31 while the owner was away: one constant
  to change. The Agent keeps every line it sends within it, dropping a command output's or a reply's oldest lines
  first and never cutting JSON.
- **Field limits.** Every field of every message has a maximum, on the Mod port and the Agent port alike.
- **Schema-only parsing.** The hub keeps only the fields a message's schema lists; unknown fields never reach events.
- **Budgets per connection and per message type** (`docs/protocol.md`, "Rate rules"). Lines over a connection's line
  budget are dropped, and 10 s over it closes the connection; a message over its type's budget is dropped and the
  connection stays. Both are kept across reconnects, so reconnecting never starts a fresh burst; each kind of
  connection is welcomed at most once per 5 s, and one address has at most 4 connections at once. Drops are logged at
  most once a minute, with a count.
- **One server per Agent.** An Agent speaks only for the one server listed under it, whose game connection is
  accepted only while that Agent's connection is up.

The remote Host is not an Environment, so ADR 0003's one root and "nothing assumes a distro" don't govern it: its
layout is `/opt/factorio`, `/srv/factorio` and `/srv/orrery-agent`, and its setup script targets one known OS on
purpose.

## Considered options

- **Opening the Mod port to the tailnet**: rejected. Its loopback bind is a documented trust boundary; a port of its
  own lets the bind address and firewalld apply to Agents alone, and leaves the Forge mod and `PROTOCOL_VERSION` as
  they are.
- **A Tailscale TCP forward to loopback**: rejected. It hides the peer address, which the hub checks.
- **A line cap of 64 KiB**: rejected. Legal messages under the field limits are longer.
- **A protocol version of the Agent's own**: rejected. Its game connection is the Mod's protocol, and its additions
  are all additive.
- **One multiplexed connection, with `up` and `down` messages for the game**: rejected. It would refactor
  `ServerHub`'s connections for the same outcome; with two connections, the game one is just a Mod connection.
- **Moving the remote Host to a newer OS, or replacing Podman**: rejected. The VM is the friend's and runs other
  software, so setup touches only its own user, folders, units and ports.
- **A rootless Quadlet user unit**: rejected. It needs lingering, subuid ranges, a user journal and
  `systemctl --user`. Rootful doesn't mean root in the container: Factorio still runs as `factorio`'s uid.
- **The Factorio mod's events through stdout `print`, a `write_file` tail, or RCON polling an outbox in `storage`**:
  rejected for `helpers.send_udp`, which acts only on the server. `print` runs on every peer and means parsing the
  journal; a tail means rotation and a disk write per event (it stays the fallback).
- **`Restart=always` with a console stop (the GTNH pattern)**: rejected. It would turn `/quit` into a surprise
  restart, so `factorio.service` restarts only on failure.

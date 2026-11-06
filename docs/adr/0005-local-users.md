# Dashboard logins are local Users with roles, not Discord OAuth

Supersedes the sentence of ADR 0002 that the dashboard logs in through Discord OAuth (`guilds.members.read`); the rest
of 0002 stands, the cookie sessions in SQLite among it. Design and build order: `docs/notes/users.md`.

Until now "may use the dashboard" meant "holds the admin role in the guild", and every logged-in person could do
everything. The owner wants a users database, a page to manage it, and role-based access. So a **User** is a row in
`hub.db` with a username and a password (scrypt from `node:crypto`, no new dependency); **Roles** are rows holding
**Permissions**, and the permission vocabulary is code (`hub/src/users/permissions.ts`); a **Grant** gives a user a
role for every server or for some; an **Invite** is a one-use link, 24 h, that sets a password, and is also how a
password is reset. The built-in `owner` role holds everything; the last owner can't be removed, and no one grants
or changes what they don't hold themself. The hub checks every write against a rules table before any route runs
(`hub/src/web/permit.ts`), with default deny; reads are open to every user but three (a server's logs, its game
settings, the audit log). The first owner, and a locked-out one, come from a CLI on the host (`npm run users --
invite <name>`): there is no email in the hub. The Discord bot keeps its own admin-role check for its slash commands.

One cut-over release: the hub release removes the Discord login, the dashboard release minutes later replaces the
login card. `integrations.web`'s `clientId`, `guildId` and `adminRoleId`, and `DISCORD_CLIENT_SECRET`, are ignored
with a warning for one release (the Rollback window), then removed.

## Considered options

- **Discord as the identity, roles on top**: every user would still need a Discord account and the guild (not every
  player of the friend's server has one), and each Environment needs its own OAuth app to keep up.
- **Passkeys (WebAuthn)**: a dependency (`@simplewebauthn/server`) and a registration flow per device; a later release
  can add them next to passwords. A second factor (TOTP) is the release after this one.
- **Four fixed roles in code, no Roles page**: a day less work and enough for three users, but the owner asked for RBAC.
- **A read permission per area**: would mean filtering the one event stream per user; reads stay open but for three.

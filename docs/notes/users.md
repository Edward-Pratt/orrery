# Users: local accounts, roles and permissions instead of the Discord login

Status: designed; build order step 1 (the hub's model, `hub/src/users/`) built 2026-11-05 on branch `users`. Date: 2026-11-05. Based on `main` at `16b27b1` (production: `hub-v2.21.0`,
`web-v0.20.0`, `agent-v1.4.0` cut and its deploy unchecked). File and line references are at that commit.

The owner asked to move the dashboard off Discord logins: a users database, a page to manage them, role-based
access, and what follows from those. Today a dashboard login is a Discord OAuth round trip (`hub/src/web/auth.ts`),
and "may use the dashboard" means "holds the admin role in the guild"; every logged-in person may do everything.
After this, a **User** is a row in `hub.db` with a username and a password, **Roles** hold **Permissions**, and the
hub refuses an action the user's roles don't cover. The Discord bot keeps its own admin-role check for its slash
commands (`hub/src/discord/discord.ts:440`): that is Discord's authorization, not the dashboard's, and stays.

Contents: [Resume here](#resume-here), [Decisions to confirm](#decisions-to-confirm), [Model](#model), [Hub](#hub), [Dashboard](#dashboard),
[Trust rules](#trust-rules), [Rollback](#rollback), [Tests to write](#tests-to-write), [Build order](#build-order),
[Release and deploy](#release-and-deploy), [Docs to update](#docs-to-update), [Out of scope](#out-of-scope),
[Appendix: permission for each route](#appendix-permission-for-each-route).

---

## Resume here

State on 2026-11-05, branch `users` from `main` at `16b27b1`, **not pushed**, three commits: `68b2a12` (this note,
the ROADMAP section, the Android note's login), `03ef75d` (the pure move of the session SQL into
`hub/src/users/store.ts`), `a649cc3` (the model). `npm test` 586 green, `npm run typecheck` and
`.github/check-file-length` clean. The decisions above are not yet confirmed by the owner: the model follows them.

**Built (build order step 1):** `hub/src/users/` with `test/users/`: `permissions.ts` (`can`, `canAnywhere`,
`isOwner`, `permissionsOf`, `OWNER_GRANTS`), `password.ts` (scrypt, `cost` for tests), `store.ts` (`db.users`: the
four tables, the sessions, `resolve`, `ownerCount`, `transaction`, `hashToken`), `roles.ts` (`Roles`, `RoleRefused`,
the seed Owner, Admin, Operator, Viewer), `users.ts` (`Users`, `UsersRefused`, `Actor`, `UserView`: `invite`, `reset`,
`acceptInvite`, `login`, `changePassword`, `setGrants`, `setDiscordId`, `disable`, `enable`, `remove`,
`endSessions`, `resolve`, `list`), `login-limit.ts` (`LoginLimit.locked/fail/clear`). Nothing uses them yet: the
Discord login still runs through `db.users.webSession` and friends.

**Next (build order step 2, the hub's API), in this order:**

1. Pure moves, each its own commit, so `web.ts` (663 lines) and `api.ts` (677) don't grow: the services routes
   (`GET /services`, the `VERBS` loop at `web.ts:282`, `GET /services/:id/logs`) into `hub/src/web/web-services.ts`;
   the new API types go in a new `hub/src/api-users.ts` as they are written.
2. `auth.ts` rewritten: the CSRF middleware first (so the login gets Origin and JSON), then `POST /api/login`
   (`{ username, password }`; `LoginLimit.locked` → 429 with `Retry-After`; `Users.login`; a failure counts and
   answers 401 "Wrong username or password"; a success clears the pair, writes `db.users.addWebSession` with the
   user's id and null avatar, sets the cookie), `GET` and `POST /api/invites/:token` (`Users.acceptInvite`, then the
   same session and cookie), the session middleware (`webSession` → `users.resolve` → a disabled or missing user is
   401 → `c.set('user', SessionUser)`: `Me` plus `discordId`), `GET /api/me` (`permissionsOf`, `isOwner`), `POST
   /api/logout`. The address is the last `X-Forwarded-For` entry, else the socket's. Gone: `/login` redirect,
   `/callback`, `recheck`, `seal`/`unseal`, `OAuth`, `discordOAuth`, the local `hash` (use `hashToken`).
3. `permit.ts`: the rules table from the [appendix](#appendix-permission-for-each-route), `permit(...permissions)`
   registered with `app.on(method, path, …)` before the routes, the default-deny middleware for POST, PUT and DELETE
   without a passed rule, 403 "Needs <permission> on <server>". A linked service is checked as its server:
   `Services` needs the inverse of `ofServer` (`hub/src/services/services.ts:121`), e.g. `serverOf(serviceId)`.
4. `web-users.ts`: the routes in the [Hub](#hub) table; `RoleRefused` and `UsersRefused` map to their `status`;
   role writes need `isOwner`; the invite link is `${web.publicUrl}/?invite=${token}`; the actor is
   `{ label: actor(user), userId: user.id, grants }`.
5. `Me` (`api.ts:83`) as in [Model](#model); `Env.Variables.user` (`web.ts:142`) becomes `SessionUser`; the chat
   route (`web.ts:582`) reads `discordId` and passes no avatar.
6. Wiring: `start.ts` builds `Roles`, `Users` (`knownServer` from `config.servers`, `db.audit`) and `LoginLimit`,
   drops the `oauth` dependency and its throw (`start.ts:70`, `:128`, `:366`); `index.ts` stops reading
   `DISCORD_CLIENT_SECRET`; `WebIntegration` (`config.ts:93`) loses `clientId`, `guildId`, `adminRoleId` and their
   defaulting (`config.ts:456`, `:504`); `web-config.ts` warns on the three for one release.
7. `hub/src/users-cli.ts` and `"users": "node src/users-cli.ts"` in `package.json`: `invite <username>` as in
   [Bootstrap](#bootstrap), opening the database with `{ timeout: 5000 }`, actor `cli:<os user>`.
8. Tests: `test/web/web-hub.ts` keeps `login`, `loginCookie` and `ADMIN`'s call surface (52 uses in
   `start.test.ts`) and inside creates the user through `Users` at a low cost and posts credentials; `fakeOAuth` and
   `PLAYER`'s role go; new `test/web/auth.test.ts`, `users-routes.test.ts`, `test/users-cli.test.ts`;
   `web-config.test.ts` and `start.test.ts`'s configs lose the three keys.
9. Docs in the same commits: `hub/CLAUDE.md` (the trust-boundaries paragraph), `hub/src/web/CLAUDE.md`, `README.md:53`,
   `hub/config.example.json`, `config.staging.example.json`, `deploy/orrery-hub-staging.service` step 3.

Then step 3, the dashboard, and the by-hand steps under [Release and deploy](#release-and-deploy).

## Decisions to confirm

Each line is the pick this note builds on, then the alternative. Flip one and the rest of the note changes as noted.

1. **Credential: username and password**, hashed with `scrypt` from `node:crypto` (no new dependency;
   `hub/CLAUDE.md` prefers built-ins). Alternative: passkeys (WebAuthn), which needs `@simplewebauthn/server` and a
   registration flow per device; a later release can add them next to passwords.
2. **A second factor later.** TOTP (RFC 6238, HMAC from `node:crypto`, optional per user) is a release of its own after
   this one, listed under [Out of scope](#out-of-scope) with its shape. Alternative: in this release, at the cost of
   an enrolment page and a QR code in the dashboard.
3. **Roles are rows, permissions are code.** The Users page creates and edits roles as sets of permissions; the
   permission vocabulary (fourteen names, [Model](#model)) lives in the hub. `owner` is built in, holds everything
   and can't be edited. Alternative: four fixed roles in code (owner, admin, operator, viewer) and no Roles tab,
   which is a day less work and enough for three users; the owner asked for RBAC, so roles are editable.
4. **Per-server scope, on the grant.** A user is given a role either for every server or for a list of servers (the
   friend who runs the Factorio Host gets `operator` on `factorio` alone). A scoped grant gives only the role's
   `servers.*` permissions, on those servers, and none of its other permissions. Alternative: no scope in this
   release (drop the `servers` column and the scope picker; the model otherwise stands).
5. **One cut-over release.** The hub release removes the Discord login; the dashboard release that follows minutes
   later replaces the login card. Between the two deploys the old card's "Log in with Discord" is a 404. The old
   config keys and `DISCORD_CLIENT_SECRET` are tolerated for one release (the Rollback window), then removed.
   Alternative: a release with both logins, which means keeping `auth.ts` as it is next to the new one and a
   dashboard card with two ways in.
6. **Reads are for everyone logged in, actions are permissioned.** Any user sees what the dashboard shows: servers,
   chat and console output on the event stream, host samples, services, deploys, the library. Three reads are the
   exception because of what they hold: a server's log files (player IPs: `servers.logs`), a factorio server's game
   settings (the game password: `servers.settings`) and the audit log (`audit`). Alternative: a read permission per
   area, which means filtering `GET /api/events` per user, since one stream carries everything.
7. **A user may carry a Discord id**, set on the Users page, so dashboard chat still goes into the game under the
   name that Discord user linked (`Stats.linkedPlayer`, `hub/src/web/web.ts:586`). Alternative: drop it, and dashboard
   chat is always posted under the username.
8. **Users before the App.** `docs/ROADMAP.md` has the App next, and `docs/notes/android-app.md`'s login is PKCE
   through the Discord login, which this removes. Building Users first means the App's login is written once, as a
   password post ([Docs to update](#docs-to-update)). Alternative: the App first on the Discord login, and its login
   rewritten when Users lands.

## Model

### Tables

Added to `hub.db` (tables are only ever added, never altered: `hub/src/stats/db.ts:131`), owned by a store of their
own, not by `Db` ([Hub](#hub)):

| Table | Columns | Notes |
|---|---|---|
| `users` | `id` (random, text), `username` (unique, case-insensitive), `password` (null until an invite is accepted), `discord_id` (null), `disabled` (0/1), `created`, `last_login` | A user without a password can't log in. |
| `roles` | `id` (random; `owner` for the built-in one), `name` (unique, case-insensitive), `permissions` (JSON list), `note` | `owner`'s permissions are not read: it has every permission by code. |
| `grants` | `user_id`, `role_id`, `servers` (JSON list of server ids, or null for every server); primary key (`user_id`, `role_id`) | A scoped `owner` grant is refused. |
| `invites` | `id` (the token's sha256, like a session), `user_id`, `expires`, `by` | One use; 24 h. Also how a password is reset. |

`web_sessions` stays as it is: `user_id` becomes the user's `id` (text already), `username` its copy, `avatar` always
null. `web_session_checks` (sealed Discord tokens and the 10-minute re-check) is written no more and never dropped.

### Permissions

The vocabulary, in `hub/src/users/permissions.ts`, with the label and the one-line description the Users page shows:

| Permission | Server-scoped | Allows |
|---|---|---|
| `servers.chat` | yes | sending chat into a server |
| `servers.console` | yes | running console commands (anything the server's console takes) |
| `servers.control` | yes | restart and cancel, backup on request, uploading a save |
| `servers.restore` | yes | putting a Backup back (destructive: the world is replaced) |
| `servers.logs` | yes | reading a server's log files (they can hold player IPs) |
| `servers.pack` | yes | pack updates, adopt, Extras, config edits, the runtime; game updates, the catalog, Import mod list |
| `servers.settings` | yes | reading and changing a factorio server's game settings (the game password is in them) |
| `servers.moderation` | yes | kick, ban, unban, promote and demote |
| `services.control` | linked | start, stop and restart of services |
| `services.logs` | linked | a service's journal |
| `deploys` | no | deploying hub, dashboard, Mod and Agent releases, and the GitHub check |
| `library` | no | the pack library, Java runtimes, New server, discarding a Pending server |
| `audit` | no | reading the audit log |
| `users` | no | the Users page: inviting, granting, disabling, resetting, roles |

Rules:

- `can(grants, permission, serverId?)`: some grant whose role holds the permission and is unscoped, or, for a scoped
  permission asked with a server, names that server. So a scoped grant gives none of its role's unscoped permissions,
  and a scoped permission asked with no server (an unlinked service) needs an unscoped grant.
  `canAnywhere(grants, permission)`: a scoped permission held on any server (an upload, which names none). An
  `owner` grant holds every permission. Built: `hub/src/users/permissions.ts`.
- A service linked to a server (`Services.ofServer`, `hub/src/services/services.ts:121`, and the inverse) is checked
  as that server: `services.control` and `services.logs` on `factorio.service` pass for a grant scoped to `factorio`,
  which is how the scoped operator starts a stopped server. An unlinked service (`caddy.service`) needs an unscoped
  grant.
- A seeded set on first start, only while `roles` is empty: Owner (id `owner`, fixed), Admin (everything but
  `users`), Operator (`servers.chat`, `servers.control`, `servers.moderation`, `services.control`, `services.logs`)
  and Viewer (nothing: reads only). All but Owner are ordinary rows, renamed or deleted at will.
- At least one enabled user with a password and an unscoped `owner` grant must remain: disabling, deleting or
  ungranting the last one is refused (409). A user can't disable or delete themself (409: another owner does it).
- Only an owner may grant or revoke `owner`, edit a user who holds `owner`, or create, edit and delete roles. A user
  with `users` but not `owner` manages users at or below their level only: a grant hands out only permissions they
  hold themself, unscoped, and a reset, a grant change, a disable, a delete or a log-out touches only a user whose
  every permission they hold (a reset of a higher user would be that account). No one reaches above their level.
- A role can't be deleted while granted. A permission name the hub doesn't know is refused (400) when a role is saved.

### What a user is to the dashboard

`Me` (`hub/src/api.ts:83`) becomes:

```ts
export type Me = {
  id: string;
  username: string;
  owner: boolean;
  /** Each permission the user holds, with the server ids it is scoped to, or null for every server. */
  permissions: { permission: Permission; servers: string[] | null }[];
};
```

The middleware sets `c.get('user')` to a `SessionUser`, `Me` plus `discordId` (`Env`, `web.ts:142`): the chat
route reads it for `linkedPlayer`, and `GET /api/me` answers the `Me` part only.

No avatar: the user menu shows initials (it already does without one, `web/src/app/app.ts:37`), and dashboard chat
posts without one (`hub.say`'s `avatar` left undefined: Discord shows the webhook's default). The dashboard hides
what the user can't do; the hub is the authority and answers 403 either way.

## Hub

### Modules

A new folder `hub/src/users/`, each file with its header contract, and a `CLAUDE.md`:

- `permissions.ts`: the vocabulary above (`PERMISSIONS`, `Permission`, `isPermission`) and `can`.
- `password.ts`: `hashPassword` and `verifyPassword` over `scrypt` (N 2^15, r 8, p 1, 32-byte key, 16-byte salt,
  stored as `scrypt:N:r:p:<salt>:<key>` so the cost can be raised later and a login re-hashes an old one),
  `timingSafeEqual`, and the rule: 12 to 256 characters, nothing else.
- `store.ts`: `UsersStore`, the SQL for the four tables **and for `web_sessions`**: the six session methods
  (`addWebSession` to `markWebSessionChecked`, `hub/src/stats/db.ts:469`) move here, since a session is a user's now,
  and `deleteSessionsOf(userId)` joins them. It takes the `DatabaseSync` handle `Db` holds (`db.ts:84`), creates its
  tables, and `Db` exposes it as `db.users`: `db.ts` is 802 lines, so the move pays for the two lines it gains.
  Writes throw (like `startDeploy`): a refused change must reach the route.
- `users.ts`: `Users`, hub core: `invite`, `acceptInvite`, `login` (the check and `last_login`), `setPassword`,
  `setGrants`, `disable`, `enable`, `remove`, `endSessions`, the invariants above, and every change audited.
- `roles.ts`: `Roles`: list, create, edit, delete, the seed, and the validation.
- `login-limit.ts`: the counters below, in memory.
- `hub/src/users-cli.ts`: `npm run users -- invite <username>` ([Bootstrap](#bootstrap)).
- `hub/src/api-users.ts`: the Users page's API types (users, roles, grants, invites, the permission list), as
  `api-game-extras.ts` holds its routes' types; `api.ts` (677 lines) keeps `Me` as one line referencing them.

In `hub/src/web/`:

- `auth.ts`, rewritten: `POST /api/login` (JSON `{ username, password }`; 204 and the `session` cookie; 401 "Wrong
  username or password" for an unknown name, a wrong password, a user without one and a disabled user alike; 429
  with a `Retry-After` while locked), the session middleware (the cookie's row, then the user: a disabled or deleted
  user is 401, as a missing row is), `GET /api/me`, `POST /api/logout`. The CSRF middleware moves **above** the login
  route: a login is a POST, so it gets the Origin and JSON checks too (today it runs after the session check,
  `auth.ts:126`).
- `permit.ts`: `permit(...permissions)` and the rules table. Registered before the routes with Hono's own router
  (`app.on(method, path, permit(...))`), so the table in the [appendix](#appendix-permission-for-each-route) is the
  code and no route handler changes. A rule passing sets a flag; a middleware after the rules and before the routes
  refuses any POST, PUT or DELETE without the flag (403): a write added later can't be used until it has a rule.
  GET and HEAD pass unless a rule says otherwise (the three reads above). 403's body names the permission
  ("Needs servers.console on gtnh"), for the dashboard's toast.
- `web-services.ts`: the services routes (`GET /services`, the `VERBS` loop at `web.ts:282`, the logs)
  move out first, so `web.ts` (663 lines) can take the three lines the users work adds (an import, `usersRoutes`,
  `permitRoutes`) and still shrink. `start.ts` (404 lines) gains `Users` and `Roles` next to `Db` and loses the
  `oauth` dependency and its check (`start.ts:70`, `:128`, `:366`): net zero or less, else its web wiring is
  extracted the same way.
- `web-users.ts`: `usersRoutes(app, deps)`, the Users page's API, like `web-game-extras.ts` is for its routes:

| Route | Does |
|---|---|
| `GET /api/invites/:token` | `{ username }`, or 404 (unknown, used, expired); no session needed, so it lives in `auth.ts` with the login |
| `POST /api/invites/:token` | `{ password }`: sets it, deletes the user's invites and sessions, logs them in (the cookie); in `auth.ts` too, after the CSRF check and before the session middleware, like `POST /api/login` |
| `GET /api/users` | every user: username, disabled, roles with scope, `last_login`, whether a password is set, `discord_id` |
| `POST /api/users` | `{ username, grants, discordId? }`: creates the user and answers `{ invite }`, the link, shown once |
| `PUT /api/users/:id` | `{ grants?, discordId?, disabled? }` |
| `POST /api/users/:id/reset` | a new invite link for an existing user (the old password keeps working until it is used) |
| `POST /api/users/:id/logout` | ends every session of that user |
| `DELETE /api/users/:id` | removes the user, their grants, invites and sessions |
| `GET /api/roles`, `POST /api/roles`, `PUT /api/roles/:id`, `DELETE /api/roles/:id` | the roles, owner only for writes |
| `GET /api/permissions` | the vocabulary with labels, for the Roles tab |
| `PUT /api/me/password` | `{ current, password }`: own password; ends the user's other sessions |
| `POST /api/me/logout-all` | ends every session of one's own |

Audit entries (actor as today, `web:<username> (<id>)`, `web.ts:222`; the CLI's is `cli:<os user>`): `user invited`,
`invite accepted`, `user changed` (grants, Discord id), `user disabled`, `user enabled`, `user deleted`, `password
reset` (an invite minted), `password changed`, `sessions ended`, `role created`, `role changed`, `role deleted`; target
`user:<username>` or `role:<name>`. Logins are not audited: a success is one console line and `last_login`; a failure
is one console line with the address.

### Login limits

In `login-limit.ts`, in memory (a restart clears them, which is fine):

- Per username and address pair (the name case-folded): 5 failures lock the pair for 15 minutes; a success clears
  it. Never the name alone: five wrong guesses at the owner's name from anywhere would lock the owner out, at will.
- Per address: 20 failures in 15 minutes lock the address for 15 minutes. The address is the **last** entry of
  `X-Forwarded-For` when the header is present (Caddy's `reverse_proxy` sets it, `deploy/Caddyfile:9`, and the hub
  binds loopback, so the header is always Caddy's), else the socket's address (local dev).
- Every attempt runs `scrypt`, against a fixed dummy hash when the user is unknown or has no password, so an answer's
  time says nothing about whether the name exists.

### Sessions

Permissions are read on every request (the session row, the user row, the grants joined to roles: three indexed
SQLite reads in process), so a changed grant takes effect on the user's next request with no session ended. Sessions
end when: the user logs out, the session expires (`sessionDays`, unchanged), the user is disabled or deleted, their
password changes (their other sessions), or "Log out everywhere". The `recheck` against Discord and
`web_session_checks` go.

### Bootstrap

There is no email in the hub, so no self-service reset. The first owner, and an owner locked out with no other owner
to help, come from a CLI on the host, like `check-config`:

```sh
npm run users -- invite <username>      # from the running release's hub/ folder, as the hub's OS user
```

It reads `config.json` for `dbPath` and `integrations.web.publicUrl`, opens the database with `DatabaseSync`'s
`timeout` (5 s, so it can write while the hub runs; checked on Node 26), creates the user with an unscoped `owner`
grant when the name is new (a CLI invite is always an owner: it is the break-glass tool, not a way to add users), or
mints a reset invite for an existing user, and prints the link: `<publicUrl>/?invite=<token>`. Staging has its own
`hub.db`, so the same command runs there.

### Config

`integrations.web` loses `clientId`, `guildId` and `adminRoleId`, keeping `listenPort`, `publicUrl`, `sessionDays`
and `status`. For one release `checkWeb` (`hub/src/web/web-config.ts`) accepts the three with a warning ("no longer
used: remove them after the Rollback window"), `index.ts` stops reading `DISCORD_CLIENT_SECRET`, and `startHub`'s
`oauth` dependency goes. The release after removes the tolerance.

## Dashboard

- `app/session.ts`: `Me` as above, and `can(permission, serverId?)` with the hub's rule. A 403 from the hub shows its
  text as a toast and asks `/api/me` again (a grant was taken away under the open page).
- `app/login.ts`: a form (username, password) posting `/api/login`; 401 and 429 shown as the hub's text; the `?login=`
  reasons go. With `?invite=<token>` in the address the card asks `GET /api/invites/:token` and shows "Set a password
  for <username>" instead, posting to the same token; an unknown token says the invite has expired. The link lands on
  the card without a route change, as `?login=` does today; the card takes the token out of the address at once
  (`history.replaceState`), so it stays out of history and bookmarks. It is in Caddy's access log once, bounded by
  one use and 24 h.
- `app/app.ts`: the user menu adds Account; the sidebar gets Users, matched only with the `users` permission
  (`canMatch`, next to `enabled()`, `app/integrations.ts:17`); initials stay as the avatar.
- Every action button, tab and sheet checks `can()`: hidden without it, so a viewer's server page is cards, chat read
  only, history and players. The Settings tab needs `servers.settings`; Logs `servers.logs`; the audit page `audit`.
- A new folder `app/users/` with its `CLAUDE.md`: `routes.ts`; `users.ts` (the list; Invite, a sheet with the username,
  the roles each with its scope, an optional Discord id, answering with the link to copy once; per user: edit grants,
  disable or enable, Reset password (a link, once), Log out everywhere, Delete, each behind the confirm tier the
  action's blast radius earns); `roles.ts` (the list; a sheet with name, note and the fourteen permissions as
  checkboxes with their descriptions; `owner` shown read-only; delete refused while granted, the hub's 409 shown);
  `account.ts` (change password with the current one, Log out everywhere).
- Local setup: no Discord redirect URL any more; `npm run users -- invite me` against the local hub's database.

## Trust rules

- Passwords: `scrypt` with a per-user salt, compared with `timingSafeEqual`; never logged, never in an API answer,
  never in the audit. The dummy hash for unknown names keeps the timing flat.
- Invites and sessions are stored as their sha256; a copy of the database logs nobody in and accepts no invite. An
  invite is one use, 24 h, and the link is shown once to the person who minted it.
- Login is rate-limited per name and per address, and the address comes from Caddy's header only because the hub binds
  loopback. If the hub ever listens elsewhere, the header must be ignored.
- Writes are default-deny: a route without a rule in `permit.ts` is 403. Reads are default-allow but for the three
  named. The dashboard hiding a button is never the check.
- Escalation: no grant hands out a permission the granter doesn't hold; `owner` is granted and revoked by owners only;
  the last owner can't be removed, disabled or demoted; roles are edited by owners only.
- CSRF stands: the login route is behind the Origin and JSON checks like every other POST; the cookie stays
  `HttpOnly; Secure; SameSite=Lax; Path=/api`.
- The CLI writes the live database as the hub's OS user, so a shell on the host as that user (or root) can mint an
  owner: that is the host's trust boundary already (`config.json`, the tokens, `/etc/orrery.env`).
- Usernames: 2 to 32 characters, letters, digits, `.`, `_` and `-`, unique without case; shown with `md()` escaping
  wherever they reach Discord (the audit actor in a post, if ever).

## Rollback

A rollback to `hub-v2.21.0` after this release: its config still holds the Discord keys and the env file its secret
(kept one release), so it starts; it reads `web_sessions` rows whose `user_id` is a local id and shows their
username on `/api/me`; a dashboard chat line builds a Discord avatar URL from that id (a dead image: Discord shows the
default) and finds no link for it (posted under the username); rows without a `web_session_checks` row run to their
expiry unchecked (its own comment, `auth.ts:117`). The new tables are ignored. Nothing is lost. A rollback of the
dashboard alone puts back "Log in with Discord" against a hub without it, so roll both back or neither.

## Tests to write

Hub (`test/users/`, `test/web/`):

- `password.test.ts`: hash and verify, a wrong password, re-hash when the stored cost is lower, the length rule.
- `permissions.test.ts`: `can` with unscoped, scoped, no-server and `owner` grants; a scoped grant gives no
  non-server permission.
- `users.test.ts`: invite, accept (single use, expiry, sessions and invites gone), the last-owner refusals, self
  disable refused, disable ends sessions, grants limited to the granter's permissions, `owner` by owners only, delete.
- `roles.test.ts`: the seed runs once, unknown permission refused, delete refused while granted, `owner` fixed.
- `login-limit.test.ts`: the two counters and their windows; a locked pair doesn't lock the name from elsewhere.
- `auth.test.ts`: login and logout, the one 401 text for every failure, 429 with `Retry-After`, CSRF on login, a
  disabled user's next request is 401, default deny for an unlisted write, the three gated reads, `Me`'s shape.
- `users-routes.test.ts`: every route in the table, 403 for a non-owner on roles, invite links shown once.
- `users-cli.test.ts`: against a temporary database: a new name becomes an owner with a link, an existing name gets a
  reset, with the hub holding the file open.
- `web-hub.ts`: `fakeOAuth` goes; `login`, `loginCookie` and `ADMIN` keep their call surface (`start.test.ts` uses
  them 52 times) and create the user in the store and post credentials inside. `PLAYER` becomes a user with no grants.
- `web-config.test.ts`: the three old keys warn, not fail; `start.test.ts`'s configs lose them.

Dashboard: the login form (401, 429, the invite form from `?invite=`), `can()` and the 403 refresh, the Users route
matched only with `users`, a server page with no permissions shows no action, the Users and Roles lists against the
fake backend.

## Build order

1. **Hub, the model**: `users/` (permissions, password, store, users, roles, login-limit) with its tests. Nothing
   wired yet; `npm test` green.
2. **Hub, the API**: `auth.ts` rewritten, `permit.ts` with the rules table and default deny, `web-users.ts`, `Me`,
   `web-hub.ts` and `start.test.ts` moved over, config tolerance, the CLI. `check-file-length` passes because the
   moves come first, each as its own commit: sessions into `store.ts`, services routes into `web-services.ts`, API
   types into `api-users.ts`.
3. **Dashboard**: `Session.can`, the login and invite card, nav gating, buttons behind `can()`, `app/users/`.
4. **Release and deploy** (below), then the by-hand steps.
5. **Cleanup release** (hub, a patch or minor later): the config tolerance goes, `config.example.json`'s keys are gone
   already, the OAuth apps are deleted in Discord's developer portal, `DISCORD_CLIENT_SECRET` leaves the env files.

Size: hub L (the model and the API, two days), dashboard M (a day or two).

## Release and deploy

Hub first, then the dashboard, as `docs/RELEASING.md` orders them, back to back: between the two deploys the live
card's "Log in with Discord" is a 404, and nobody is logged in during that window anyway (the hub restarts with no
Discord login to give). Then, on the host:

1. `npm run users -- invite <owner>` from the new release's `hub/` folder as the hub's user; open the link, set the
   password, see the Users page.
2. Invite the others from the Users page; the friend gets `operator` scoped to `factorio`.
3. Staging: the same command as `orrery-staging`.
4. Leave `clientId`, `guildId`, `adminRoleId` and `DISCORD_CLIENT_SECRET` in place until the cleanup release.

Smoke: a wrong password five times locks the name from that address (429, the card's text) and not from another; a viewer sees no buttons and the hub
refuses a hand-made POST (403 with the permission's name); a scoped operator can restart `factorio` and not `gtnh`;
Reset password gives a link that works once; Log out everywhere ends an open tab (its next request is 401, the card
says the session ended); the last owner can't be disabled.

## Docs to update

- `docs/adr/0005-local-users.md`: supersedes the sentence in `docs/adr/0002` that the dashboard logs in through
  Discord OAuth (`guilds.members.read`) with cookie sessions; the rest of 0002 stands. Considered: keeping Discord as
  the identity with roles on top (every user still needs the guild and a Discord account; the friend's players don't
  all have one; the OAuth app per Environment is upkeep), passkeys, fixed roles.
- `CONTEXT.md`: a **Users** section with **User**, **Role**, **Permission**, **Grant** (a role given to a user, for
  every server or some) and **Invite** (a one-use link that sets a password; also a reset); and **Admin** keeps
  saying it is not a dashboard user. Avoid: account, login (for the user), access level, ACL.
- `docs/notes/android-app.md`: done 2026-11-05. Its Login section is a `POST /api/app/session` with
  `{ username, password }` (and the TOTP code later) answering `{ token }`, the same `Users.login`; the
  bearer-session section stands; a lost phone is Log out everywhere; its ADR is 0006.
- `hub/CLAUDE.md` (modules, the trust boundaries: a Users paragraph), `hub/src/web/CLAUDE.md`, `hub/src/stats/CLAUDE.md`
  and `db.ts`'s header (`web_session_checks` unused; `db.users`), `hub/src/users/CLAUDE.md` (new), `web/CLAUDE.md`
  (files, local setup) and `web/src/app/users/CLAUDE.md` (new).
- `README.md:53` (`DISCORD_CLIENT_SECRET` gone; the CLI), `hub/config.example.json` and `config.staging.example.json`
  (the three keys gone), `deploy/orrery-hub-staging.service` (step 3's OAuth app becomes the CLI invite; the env
  file holds `GITHUB_TOKEN` only), `deploy/orrery-hub.service:37`.
- `docs/ROADMAP.md`: this section, then shipped.
- `docs/notes/public-status.md`'s trust rules still hold (the status read is before the session check).

## Out of scope

- **A second factor** (the next release): TOTP per user, enrolled from Account (the secret shown as an `otpauth://`
  URI and a QR drawn in the dashboard), checked at login as a third field, recovery codes, and "require a second
  factor" per role; the CLI reset clears it. Passkeys after that, if wanted.
- Self-service password reset (no email in the hub), social or OAuth logins, API tokens for scripts (the App's
  bearer sessions come with its own note), per-user avatars, a sessions list per user (there is Log out everywhere),
  an audit row per login, per-area read permissions, and changing a username.

## Appendix: permission for each route

The rules table in `permit.ts`, from the routes in `hub/src/web/web.ts` and `web-game-extras.ts` at `16b27b1`. A write
not listed is refused by the default-deny middleware; a read not listed needs only a session.

| Permission | Routes |
|---|---|
| `servers.chat` | `POST /servers/:id/chat` |
| `servers.console` | `POST /servers/:id/command` |
| `servers.control` | `POST /servers/:id/restart`, `POST /servers/:id/restart/cancel`, `POST /servers/:id/backup`, `POST /servers/:id/saves` |
| `servers.restore` | `POST /servers/:id/restore` |
| `servers.logs` | `GET /servers/:id/logs`, `GET /servers/:id/logs/:name` |
| `servers.pack` | `POST /servers/:id/pack/compare`, `…/pack/adopt`, `…/pack/update`, `…/pack/update/cancel`, `PUT …/pack/runtime`, `POST/PUT/DELETE …/pack/extras[/:extra]`, `POST …/pack/edits/preview`, `POST/PUT/DELETE …/pack/edits[/:edit]`, `POST /servers/:id/game/catalog`, `…/game/update`, `…/game/update/cancel`, `…/game/check` |
| `servers.settings` | `GET /servers/:id/settings`, `PUT /servers/:id/settings` |
| `servers.moderation` | `POST /servers/:id/moderation` |
| `services.control` | `POST /services/:id/<verb>` (each of `VERBS`, `web.ts:282`); a linked service is checked as its server |
| `services.logs` | `GET /services/:id/logs`; a linked service is checked as its server |
| `deploys` | `POST /deploys`, `POST /deploys/check` |
| `library` | `POST /library/packs`, `POST /library/cancel`, `DELETE /library/packs/:id`, `POST /library/runtimes`, `DELETE /library/runtimes/:name`, `POST /servers`, `DELETE /servers/pending/:id` |
| `library` or `servers.control` anywhere (`canAnywhere`) | `POST /uploads`, `GET /uploads/:upload`, `PUT /uploads/:upload` (a pack zip or a save; the save's `POST …/saves` checks its server) |
| `audit` | `GET /audit` |
| `users` | `GET /users`, `POST /users`, `PUT /users/:id`, `POST /users/:id/reset`, `POST /users/:id/logout`, `DELETE /users/:id`, `GET /roles`, `GET /permissions`; owner only: `POST /roles`, `PUT /roles/:id`, `DELETE /roles/:id` |
| a session, no permission | `GET /me`, `PUT /me/password`, `POST /me/logout-all`, `POST /logout`, `GET /integrations`, `GET /events`, `GET /servers`, `GET /servers/pending`, `GET /servers/:id`, `…/history`, `…/players/:name`, `GET …/pack`, `GET …/game`, `…/game/updates`, `…/game/mods`, `…/game/mods/:name/thumbnail`, `GET …/moderation`, `GET /services`, `GET /checks`, `GET /hosts`, `…/samples`, `GET /host`, `GET /deploys`, `GET /library`, `GET /library/packs/:id/scripts` |
| no session | `GET /environment`, `GET /public/status`, `POST /login`, `GET /invites/:token`, `POST /invites/:token` |

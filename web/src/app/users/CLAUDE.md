# users

Users, Roles and one's own Account (`docs/notes/users.md`). `routes.ts`: the Users page (`/users`, only with the
`users` permission): `UsersShell`, its title and the Users and Roles tabs. `users.ts`: the list (roles and where,
Invited, Disabled, last login), Invite… and per user Edit…, Reset password, Log out everywhere, Disable… or Enable and
Delete… (typed username); none of those but Edit, Reset and Log out on oneself, and no menu on an owner for a user who
isn't one; an invite link shown once with Copy. `user-sheet.ts`: `UserSheet`, inviting or editing a user's roles (each
for every server or the servers picked), and for an owner their Discord id (sent only when changed, so no one else's
edit clears it). `roles.ts`: the roles in words, owners alone get New role…, Edit… and Delete…; `role-sheet.ts`:
`RoleSheet`, a role's name, note and permissions. `account.ts`: the Account page (`/account`, from the user menu):
Change password and Log out everywhere. The hub is the check; its refusals are toasts (Account's inline). Each file's
header is its contract. Tests: the `*.spec.ts` beside them.

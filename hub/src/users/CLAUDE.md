# users

Who may use the dashboard, and what each may do (`docs/notes/users.md`). `permissions.ts` is the vocabulary and the
check (`can`); `password.ts` scrypt hashing; `store.ts` the SQL for users, roles, grants, invites and the login
sessions, held by `Db` as `db.users`; `roles.ts` the roles and their seed; `users.ts` invites, logins, grants and
the rules that keep an owner; `login-limit.ts` the login's counters. Each file's header is its contract. Tests:
`test/users/`.

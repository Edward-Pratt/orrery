// The HTTP API's types for Users (`docs/notes/users.md`), re-exported by `api.ts`: the logged-in user (`Me`, with the
// permissions they hold as `PermissionHeld`), the login and invite bodies (`LoginRequest`, `InviteInfo`,
// `PasswordRequest`, `PasswordChange`), the Users page's (`UserView`, `UserGrant`, `GrantRequest`, `NewUserRequest`,
// `UserChange`, `InviteAnswer`, `RoleView`, `RoleRequest`) and the vocabulary (`Permission`, `PermissionInfo`, from
// `users/permissions.ts`). Imports only that pure file, so it compiles without `@types/node`, as `api.ts` does.

import type { Permission } from './users/permissions.ts';

export type { Permission, PermissionInfo } from './users/permissions.ts';

/** A permission a user holds, with the server ids it is scoped to, or null for every server. */
export type PermissionHeld = { permission: Permission; servers: string[] | null };

/** `GET /api/me`: the logged-in user; `owner` holds every permission, and alone may edit roles and owners. */
export type Me = { id: string; username: string; owner: boolean; permissions: PermissionHeld[] };

/** `POST /api/login`: 204 and the session cookie; 401 for every failure alike; 429 with `Retry-After` while locked. */
export type LoginRequest = { username: string; password: string };
/** `GET /api/invites/:token`: whom the invite is for; 404 when it is unknown, used or expired. */
export type InviteInfo = { username: string };
/** `POST /api/invites/:token`: the password to set (12 to 256 characters); 204 and logged in. */
export type PasswordRequest = { password: string };
/** `PUT /api/me/password`: one's own, with the current one; the user's other sessions end. */
export type PasswordChange = { current: string; password: string };

/** A role given to a user, for every server (`servers` null) or for the servers listed. */
export type UserGrant = { roleId: string; role: string; servers: string[] | null };
/** `GET /api/users`: one user. `hasPassword` false: invited, the link not yet used. */
export type UserView = {
  id: string;
  username: string;
  disabled: boolean;
  discordId: string | null;
  lastLogin: number | null;
  hasPassword: boolean;
  grants: UserGrant[];
};

/** A grant in a request: a role, for every server (`servers` left out or null) or some. */
export type GrantRequest = { roleId: string; servers?: string[] | null };
/** `POST /api/users`; `discordId` (owners only) puts dashboard chat under the name that Discord user linked in game. */
export type NewUserRequest = { username: string; grants: GrantRequest[]; discordId?: string | null };
/** `PUT /api/users/:id`: each field present is changed, all or none; 204. */
export type UserChange = { grants?: GrantRequest[]; discordId?: string | null; disabled?: boolean };
/** `POST /api/users` and `POST /api/users/:id/reset`: the invite link (one use, 24 h), shown this once. */
export type InviteAnswer = { id: string; username: string; invite: string };

/** `GET /api/roles`: one role. `owner` is built in: it holds every permission (its list is empty) and can't be changed. */
export type RoleView = { id: string; name: string; permissions: Permission[]; note: string };
/** `POST /api/roles` and `PUT /api/roles/:id` (owners only), answering the `RoleView`. */
export type RoleRequest = { name: string; permissions: Permission[]; note?: string };

// `UsersStore`, held by `Db` as `db.users` on the same handle: the SQL behind Users, Roles, Grants and Invites
// (`users`, `roles` (`permissions` as JSON, unknown names dropped on read), `grants` (`servers` as JSON, null for
// every server), `invites` (stored as `hashToken` of the link's token, like a session)), and the dashboard's login
// sessions (`web_sessions`, stored hashed, and `web_session_checks`, each one's sealed Discord access token and when
// its admin role was last checked), moved from `Db`, which still prunes expired sessions nightly. Session writes never
// throw: a database error is logged (`#write`), as `Db`'s are; the users tables' writes throw, as `startDeploy` does,
// since a refused change must reach the route. `setGrants`, `deleteUser` and `transaction(fn)` are transactions. `resolve(userId)` is
// the per-request read: the user and their grants as `Grant`s; `ownerCount` and `isOwnerUser` serve the last-owner
// rule (an enabled user with a password and an unscoped `owner` grant). Tables are only added, never altered. Hub core.

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isPermission, type Grant, type Permission } from './permissions.ts';

export type UserRow = { id: string; username: string; password: string | null; discordId: string | null; disabled: boolean; created: number; lastLogin: number | null };
export type RoleRow = { id: string; name: string; permissions: Permission[]; note: string };
export type GrantRow = { roleId: string; servers: string[] | null };
export type InviteRow = { id: string; userId: string; expires: number; by: string };

/** Sessions and invites are stored as the sha256 of their token, so a copy of the database logs nobody in. */
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const USER = 'id, username, password, discord_id AS discordId, disabled, created, last_login AS lastLogin';
const toUser = (r: Record<string, unknown>): UserRow => ({ ...(r as UserRow), disabled: r.disabled === 1 });
const toRole = (r: { id: string; name: string; permissions: string; note: string }): RoleRow => ({
  ...r,
  permissions: (JSON.parse(r.permissions) as unknown[]).filter(isPermission),
});
const servers = (json: string | null): string[] | null => (json === null ? null : (JSON.parse(json) as string[]));

export class UsersStore {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL, password TEXT, discord_id TEXT, disabled INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, last_login INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users (username COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, permissions TEXT NOT NULL, note TEXT NOT NULL DEFAULT '');
      CREATE UNIQUE INDEX IF NOT EXISTS roles_name ON roles (name COLLATE NOCASE);
      CREATE TABLE IF NOT EXISTS grants (user_id TEXT NOT NULL, role_id TEXT NOT NULL, servers TEXT, PRIMARY KEY (user_id, role_id));
      CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL, by TEXT NOT NULL);
    `);
  }

  #inTransaction = false;

  /** Runs `fn`'s writes as one: all or none. Inside one already, `fn` joins it. */
  transaction(fn: () => void): void {
    if (this.#inTransaction) return fn();
    this.#db.exec('BEGIN');
    this.#inTransaction = true;
    try {
      fn();
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    } finally {
      this.#inTransaction = false;
    }
  }

  // Users

  users(): UserRow[] {
    return (this.#db.prepare(`SELECT ${USER} FROM users ORDER BY username COLLATE NOCASE`).all() as Record<string, unknown>[]).map(toUser);
  }

  user(id: string): UserRow | undefined {
    const row = this.#db.prepare(`SELECT ${USER} FROM users WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row && toUser(row);
  }

  userByName(username: string): UserRow | undefined {
    const row = this.#db.prepare(`SELECT ${USER} FROM users WHERE username = ? COLLATE NOCASE`).get(username) as Record<string, unknown> | undefined;
    return row && toUser(row);
  }

  addUser(u: { id: string; username: string; discordId: string | null; created: number }): void {
    this.#db.prepare('INSERT INTO users (id, username, discord_id, created) VALUES (?, ?, ?, ?)').run(u.id, u.username, u.discordId, u.created);
  }

  setPassword(id: string, hash: string | null): void {
    this.#db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hash, id);
  }

  setDisabled(id: string, disabled: boolean): void {
    this.#db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
  }

  setDiscordId(id: string, discordId: string | null): void {
    this.#db.prepare('UPDATE users SET discord_id = ? WHERE id = ?').run(discordId, id);
  }

  setLastLogin(id: string, at: number): void {
    this.#db.prepare('UPDATE users SET last_login = ? WHERE id = ?').run(at, id);
  }

  /** The user with their grants, invites and sessions. */
  deleteUser(id: string): void {
    this.transaction(() => {
      this.#db.prepare('DELETE FROM grants WHERE user_id = ?').run(id);
      this.#db.prepare('DELETE FROM invites WHERE user_id = ?').run(id);
      this.deleteSessionsOf(id);
      this.#db.prepare('DELETE FROM users WHERE id = ?').run(id);
    });
  }

  // Roles

  roles(): RoleRow[] {
    return (this.#db.prepare('SELECT id, name, permissions, note FROM roles ORDER BY name COLLATE NOCASE').all() as Parameters<typeof toRole>[0][]).map(toRole);
  }

  role(id: string): RoleRow | undefined {
    const row = this.#db.prepare('SELECT id, name, permissions, note FROM roles WHERE id = ?').get(id) as Parameters<typeof toRole>[0] | undefined;
    return row && toRole(row);
  }

  roleByName(name: string): RoleRow | undefined {
    const row = this.#db.prepare('SELECT id, name, permissions, note FROM roles WHERE name = ? COLLATE NOCASE').get(name) as Parameters<typeof toRole>[0] | undefined;
    return row && toRole(row);
  }

  addRole(r: RoleRow): void {
    this.#db.prepare('INSERT INTO roles (id, name, permissions, note) VALUES (?, ?, ?, ?)').run(r.id, r.name, JSON.stringify(r.permissions), r.note);
  }

  setRole(r: RoleRow): void {
    this.#db.prepare('UPDATE roles SET name = ?, permissions = ?, note = ? WHERE id = ?').run(r.name, JSON.stringify(r.permissions), r.note, r.id);
  }

  deleteRole(id: string): void {
    this.#db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  }

  // Grants

  grantsOf(userId: string): GrantRow[] {
    const rows = this.#db.prepare('SELECT role_id AS roleId, servers FROM grants WHERE user_id = ?').all(userId) as { roleId: string; servers: string | null }[];
    return rows.map((r) => ({ roleId: r.roleId, servers: servers(r.servers) }));
  }

  /** How many users hold the role. */
  grantedCount(roleId: string): number {
    return (this.#db.prepare('SELECT COUNT(*) AS n FROM grants WHERE role_id = ?').get(roleId) as { n: number }).n;
  }

  /** Replaces a user's grants. */
  setGrants(userId: string, grants: GrantRow[]): void {
    this.transaction(() => {
      this.#db.prepare('DELETE FROM grants WHERE user_id = ?').run(userId);
      const add = this.#db.prepare('INSERT INTO grants (user_id, role_id, servers) VALUES (?, ?, ?)');
      for (const g of grants) add.run(userId, g.roleId, g.servers === null ? null : JSON.stringify(g.servers));
    });
  }

  /** The user and their grants as the check reads them; undefined for an unknown id. */
  resolve(userId: string): { user: UserRow; grants: Grant[] } | undefined {
    const user = this.user(userId);
    if (!user) return undefined;
    const rows = this.#db
      .prepare('SELECT r.id AS roleId, r.permissions, g.servers FROM grants g JOIN roles r ON r.id = g.role_id WHERE g.user_id = ?')
      .all(userId) as { roleId: string; permissions: string; servers: string | null }[];
    const grants = rows.map((r) => ({ owner: r.roleId === 'owner', permissions: toRole({ id: r.roleId, name: '', permissions: r.permissions, note: '' }).permissions, servers: servers(r.servers) }));
    return { user, grants };
  }

  /** Enabled users with a password and an unscoped `owner` grant: the ones the hub can't lose the last of. */
  ownerCount(): number {
    return (this.#db.prepare(`SELECT COUNT(*) AS n FROM users u JOIN grants g ON g.user_id = u.id WHERE ${OWNER}`).get() as { n: number }).n;
  }

  isOwnerUser(userId: string): boolean {
    return (this.#db.prepare(`SELECT COUNT(*) AS n FROM users u JOIN grants g ON g.user_id = u.id WHERE ${OWNER} AND u.id = ?`).get(userId) as { n: number }).n > 0;
  }

  // Invites

  addInvite(i: InviteRow): void {
    this.#db.prepare('INSERT INTO invites (id, user_id, expires, by) VALUES (?, ?, ?, ?)').run(i.id, i.userId, i.expires, i.by);
  }

  /** An unexpired invite by its hashed token. */
  invite(id: string, now: number): InviteRow | undefined {
    const row = this.#db.prepare('SELECT id, user_id AS userId, expires, by FROM invites WHERE id = ? AND expires > ?').get(id, now) as InviteRow | undefined;
    return row && { ...row };
  }

  deleteInvitesOf(userId: string): void {
    this.#db.prepare('DELETE FROM invites WHERE user_id = ?').run(userId);
  }

  // Sessions

  /** Every session of a user but `keep` (a hashed session id): a password change keeps the one it was made from. */
  deleteSessionsOf(userId: string, keep = ''): void {
    this.#db.prepare('DELETE FROM web_session_checks WHERE id IN (SELECT id FROM web_sessions WHERE user_id = ? AND id <> ?)').run(userId, keep);
    this.#db.prepare('DELETE FROM web_sessions WHERE user_id = ? AND id <> ?').run(userId, keep);
  }

  /** Session writes never throw: a database error (disk full, locked) is logged instead of taking the hub down. */
  #write(label: string, sql: string, ...params: (string | number | null)[]): void {
    try {
      this.#db.prepare(sql).run(...params);
    } catch (err) {
      console.error(`[db] ${label} failed:`, (err as Error).message);
    }
  }

  /** A dashboard login; `id` is the hash of the cookie's session id, never the id itself. */
  addWebSession(id: string, userId: string, username: string, avatar: string | null, expires: number): void {
    this.#write(
      'add web session',
      'INSERT INTO web_sessions (id, user_id, username, avatar, expires) VALUES (?, ?, ?, ?, ?)',
      id,
      userId,
      username,
      avatar,
      expires,
    );
  }

  /** The logged-in Discord user of an unexpired session. */
  webSession(id: string, now = Date.now()): { id: string; username: string; avatar: string | null } | undefined {
    const row = this.#db
      .prepare('SELECT user_id AS id, username, avatar FROM web_sessions WHERE id = ? AND expires > ?')
      .get(id, now) as { id: string; username: string; avatar: string | null } | undefined;
    return row && { ...row };
  }

  deleteWebSession(id: string): void {
    this.#write('delete web session', 'DELETE FROM web_sessions WHERE id = ?', id);
    this.#write('delete web session check', 'DELETE FROM web_session_checks WHERE id = ?', id);
  }

  /**
   * A session's Discord access token (sealed: only the session's cookie opens it) and when its admin role was last
   * checked; undefined for a session from before checks.
   */
  webSessionCheck(id: string): { token: string; checked: number } | undefined {
    const row = this.#db.prepare('SELECT token, checked FROM web_session_checks WHERE id = ?').get(id) as { token: string; checked: number } | undefined;
    return row && { ...row };
  }

  setWebSessionCheck(id: string, token: string, checked: number): void {
    this.#write('web session check', 'INSERT OR REPLACE INTO web_session_checks (id, token, checked) VALUES (?, ?, ?)', id, token, checked);
  }

  markWebSessionChecked(id: string, checked: number): void {
    this.#write('web session checked', 'UPDATE web_session_checks SET checked = ? WHERE id = ?', checked, id);
  }
}

const OWNER = "g.role_id = 'owner' AND g.servers IS NULL AND u.disabled = 0 AND u.password IS NOT NULL";

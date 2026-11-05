// `UsersStore`: the SQL behind the dashboard's login sessions (`web_sessions`, stored hashed, and `web_session_checks`,
// each one's sealed Discord access token and when its admin role was last checked), moved out of `Db`, which holds it
// as `db.users` and still prunes expired sessions nightly. Session writes never throw: a database error is logged
// (`#write`), as `Db`'s are. Hub core.

import type { DatabaseSync } from 'node:sqlite';

export class UsersStore {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
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

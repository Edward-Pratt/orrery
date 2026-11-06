// npm run users -- invite <username> [config path]: the break-glass invite, run on the host as the hub's OS user from
// the running release's hub/ folder (`config.json` by default). There is no email in the hub, so this is how the first
// owner, and an owner locked out with no other owner to help, get in: a new name becomes a user with an unscoped
// `owner` grant (never anything less: adding users is the Users page's job); an existing one gets a reset, at the
// level they hold. Either way it prints the invite link (`<publicUrl>/?invite=<token>`: one use, 24 h). The
// database is opened with a 5 s busy timeout, so it writes while the hub runs. Audited as `cli:<OS user>`.

import { userInfo } from 'node:os';
import { loadConfig } from './config.ts';
import { Db } from './stats/db.ts';
import { OWNER_GRANTS } from './users/permissions.ts';
import { OWNER_ROLE, Roles } from './users/roles.ts';
import { inviteLink, Users } from './users/users.ts';

const BUSY_MS = 5_000;

/** Invites `username` as an owner, or resets the existing user of that name; answers the link. Throws why not. */
export function cliInvite(configPath: string, username: string, by = `cli:${userInfo().username}`): string {
  const config = loadConfig(configPath);
  const web = config.integrations.web;
  if (!web) throw new Error('integrations.web is off: there is no dashboard to invite to');
  const db = new Db(config.dbPath, BUSY_MS);
  try {
    const audit = db.audit.bind(db);
    const users = new Users(db.users, new Roles(db.users, audit), audit, { knownServer: (id) => config.servers.some((s) => s.id === id) });
    const actor = { label: by, userId: null, grants: OWNER_GRANTS };
    const existing = users.list().find((u) => u.username.toLowerCase() === username.trim().toLowerCase());
    const { token } = existing ? users.reset(existing.id, actor) : users.invite({ username, grants: [{ roleId: OWNER_ROLE }] }, actor);
    return inviteLink(web.publicUrl, token);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [verb, username, path = 'config.json'] = process.argv.slice(2);
  if (verb !== 'invite' || !username) {
    console.error('Usage: npm run users -- invite <username> [config path]');
    process.exitCode = 2;
  } else {
    try {
      console.log(cliInvite(path, username));
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  }
}

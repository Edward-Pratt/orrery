// Who may run the bot's admin commands (`adminRefusal`), each mapped to the permission the dashboard checks for the
// same action (`ADMIN_COMMANDS`: `/cmd` needs `servers.console`, `/restart` and `/backup` need `servers.control`, on
// the channel's server). A Discord member linked to a User (the Users page's Discord id, set by owners only) is decided
// by that User's grants alone, so a User scoped to one server gets only that server here too, the admin role or not;
// a disabled User gets nothing. A member linked to no User falls back to the admin role (`adminRoleId`) until the
// Users cleanup release; while the web integration is off (no `Users`) the role is the only check, and stays. Grants
// are read on every command, so a change on the Users page applies to the next one.

import { can, type Permission } from '../users/permissions.ts';
import type { Users } from '../users/users.ts';

export const ADMIN_COMMANDS: ReadonlyMap<string, Permission> = new Map([
  ['cmd', 'servers.console'],
  ['restart', 'servers.control'],
  ['backup', 'servers.control'],
]);

/** What the bot reads of `Users`: a Discord id's User and their grants. */
export type DiscordUsers = Pick<Users, 'byDiscordId'>;

/** The member running an admin command: their Discord id, and whether they hold the admin role. */
export type Invoker = { discordId: string; hasAdminRole: boolean };

/** Why `who` may not run `command` (one of `ADMIN_COMMANDS`) on `serverId`, as the reply; undefined when they may. */
export function adminRefusal(users: DiscordUsers | undefined, who: Invoker, command: string, serverId: string): string | undefined {
  const permission = ADMIN_COMMANDS.get(command);
  if (!permission) return 'Not an admin command.';
  const linked = users?.byDiscordId(who.discordId);
  if (!linked) return who.hasAdminRole ? undefined : 'You need the admin role for this.';
  if (linked.user.disabled) return 'Your dashboard user is disabled.';
  return can(linked.grants, permission, serverId) ? undefined : `Your dashboard user needs ${permission} on ${serverId} for this.`;
}

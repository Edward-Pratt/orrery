// The permission vocabulary (`PERMISSIONS`: name, whether it is scoped to servers, and the label and one-line
// description the Users page shows), `Permission`, `isPermission`, and the check over a user's grants (`Grant`: a
// role's permissions, whether that role is `owner`, and the server ids it is scoped to, or null for every server):
// `can(grants, permission, serverId?)` passes for a grant that holds the permission (`owner` holds every one) and is
// unscoped, or, for a scoped permission asked with a server, names that server; so a scoped grant gives none of its
// role's unscoped permissions, and a scoped permission asked with no server (an unlinked service) needs an unscoped
// grant. `canAnywhere(grants, permission)` passes for a scoped permission held on any server (an upload names no
// server). A linked service is its server to the check: that mapping is the caller's. `isOwner`: an unscoped `owner`
// grant. `permissionsOf(grants)` is the dashboard's view (`Me.permissions`): each held permission with the servers it
// is scoped to, or null. Hub core, pure.

export const PERMISSIONS = [
  { name: 'servers.chat', scoped: true, label: 'Chat', description: 'send chat into a server' },
  { name: 'servers.console', scoped: true, label: 'Console', description: "run console commands (anything the server's console takes)" },
  { name: 'servers.control', scoped: true, label: 'Control', description: 'restart and cancel, back up on request, upload a save' },
  { name: 'servers.restore', scoped: true, label: 'Restore', description: 'put a Backup back (the world is replaced)' },
  { name: 'servers.logs', scoped: true, label: 'Logs', description: "read a server's log files (they can hold player IPs)" },
  { name: 'servers.pack', scoped: true, label: 'Pack and game updates', description: 'pack updates, adopt, Extras, config edits, the runtime; game updates, the catalog, Import mod list' },
  { name: 'servers.settings', scoped: true, label: 'Game settings', description: "read and change a factorio server's game settings (the game password is in them)" },
  { name: 'servers.moderation', scoped: true, label: 'Moderation', description: 'kick, ban, unban, promote and demote' },
  { name: 'services.control', scoped: true, label: 'Services', description: 'start, stop and restart services (a linked service counts as its server)' },
  { name: 'services.logs', scoped: true, label: 'Service logs', description: "a service's journal (a linked service counts as its server)" },
  { name: 'deploys', scoped: false, label: 'Deploys', description: 'deploy hub, dashboard, Mod and Agent releases, and the GitHub check' },
  { name: 'library', scoped: false, label: 'Library', description: 'the pack library, Java runtimes, New server, discarding a Pending server' },
  { name: 'audit', scoped: false, label: 'Audit log', description: 'read the audit log' },
  { name: 'users', scoped: false, label: 'Users', description: 'invite, grant, disable and reset users (roles are for owners alone)' },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['name'];
export type PermissionInfo = (typeof PERMISSIONS)[number];

const BY_NAME = new Map<string, PermissionInfo>(PERMISSIONS.map((p) => [p.name, p]));

export const isPermission = (name: unknown): name is Permission => typeof name === 'string' && BY_NAME.has(name);
export const isScoped = (permission: Permission): boolean => BY_NAME.get(permission)!.scoped;

/** A role given to a user: its permissions, whether it is `owner`, and the servers it is scoped to (null: every server). */
export type Grant = { owner: boolean; permissions: readonly Permission[]; servers: readonly string[] | null };

/** The CLI's grants: an owner, everywhere. */
export const OWNER_GRANTS: readonly Grant[] = [{ owner: true, permissions: [], servers: null }];

const holds = (g: Grant, permission: Permission) => g.owner || g.permissions.includes(permission);

/** Whether the grants allow `permission`, on `serverId` when given (see the header for the scope rules). */
export function can(grants: readonly Grant[], permission: Permission, serverId?: string): boolean {
  return grants.some((g) => holds(g, permission) && (g.servers === null || (serverId !== undefined && isScoped(permission) && g.servers.includes(serverId))));
}

/** Whether a scoped permission is held on any server at all. */
export function canAnywhere(grants: readonly Grant[], permission: Permission): boolean {
  return grants.some((g) => holds(g, permission) && (g.servers === null || isScoped(permission)));
}

export const isOwner = (grants: readonly Grant[]): boolean => grants.some((g) => g.owner && g.servers === null);

/** The dashboard's view: each permission held, with the servers it is scoped to (null: every server), in `PERMISSIONS` order. */
export function permissionsOf(grants: readonly Grant[]): { permission: Permission; servers: string[] | null }[] {
  const out: { permission: Permission; servers: string[] | null }[] = [];
  for (const { name, scoped } of PERMISSIONS) {
    const holding = grants.filter((g) => holds(g, name));
    if (holding.some((g) => g.servers === null)) out.push({ permission: name, servers: null });
    else if (scoped && holding.length) out.push({ permission: name, servers: [...new Set(holding.flatMap((g) => g.servers!))] });
  }
  return out;
}

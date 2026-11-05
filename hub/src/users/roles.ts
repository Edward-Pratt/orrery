// `Roles`: the roles users are granted, each a name, a note and a set of permissions. `owner` (id `owner`, "Owner")
// is built in: it holds every permission by code (`permissions.ts`), its stored list is empty and never read, and it
// is never changed or deleted. The seed, only while the table is empty (first start): Owner, Admin (everything but
// `users`), Operator (chat, control, moderation, services and their logs) and Viewer (reads only), all but Owner
// ordinary rows. `create` and `update` take untrusted input (`RoleRefused`, 400 naming the field: a name of 1 to 32
// characters once trimmed, unique without case (409), known permissions, a note of at most 200); `remove` refuses a
// granted role (409). Who may call them (owners) is the route's check. Every change is audited (`role created`,
// `role changed`, `role deleted`; target `role:<name>`). Hub core.

import { randomBytes } from 'node:crypto';
import type { AuditEntry } from '../types.ts';
import { isPermission, PERMISSIONS, type Permission } from './permissions.ts';
import type { RoleRow, UsersStore } from './store.ts';

export class RoleRefused extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

export const OWNER_ROLE = 'owner';
const NAME_MAX = 32;
const NOTE_MAX = 200;

const SEED: Omit<RoleRow, 'id'>[] = [
  { name: 'Admin', permissions: PERMISSIONS.filter((p) => p.name !== 'users').map((p) => p.name), note: 'Everything but the Users page.' },
  { name: 'Operator', permissions: ['servers.chat', 'servers.control', 'servers.moderation', 'services.control', 'services.logs'], note: 'Day-to-day running: restarts, backups, moderation, services.' },
  { name: 'Viewer', permissions: [], note: 'Reads only.' },
];

export class Roles {
  #store: UsersStore;
  #audit: (e: AuditEntry) => void;

  constructor(store: UsersStore, audit: (e: AuditEntry) => void) {
    this.#store = store;
    this.#audit = audit;
    if (store.roles().length) return;
    store.addRole({ id: OWNER_ROLE, name: 'Owner', permissions: [], note: "Everything, everywhere. Built in: can't be changed." });
    for (const r of SEED) store.addRole({ id: randomBytes(8).toString('base64url'), ...r });
  }

  list(): RoleRow[] {
    return this.#store.roles();
  }

  get(id: string): RoleRow | undefined {
    return this.#store.role(id);
  }

  create(input: Record<string, unknown>, by: string): RoleRow {
    const role = { id: randomBytes(8).toString('base64url'), ...this.#check(input) };
    this.#store.addRole(role);
    this.#audit({ actor: by, action: 'role created', target: `role:${role.name}`, details: role.permissions.join(', ') || 'no permissions' });
    return role;
  }

  update(id: string, input: Record<string, unknown>, by: string): RoleRow {
    const before = this.#editable(id);
    const role = { id, ...this.#check(input, id) };
    this.#store.setRole(role);
    const changes = [
      before.name !== role.name && `renamed from ${before.name}`,
      before.permissions.join() !== role.permissions.join() && `permissions: ${role.permissions.join(', ') || 'none'}`,
      before.note !== role.note && 'note',
    ].filter(Boolean);
    if (changes.length) this.#audit({ actor: by, action: 'role changed', target: `role:${role.name}`, details: changes.join('; ') });
    return role;
  }

  remove(id: string, by: string): void {
    const role = this.#editable(id);
    const holders = this.#store.grantedCount(id);
    if (holders) throw new RoleRefused(409, `${holders === 1 ? 'A user holds' : `${holders} users hold`} ${role.name}: take it away first`);
    this.#store.deleteRole(id);
    this.#audit({ actor: by, action: 'role deleted', target: `role:${role.name}`, details: '' });
  }

  #editable(id: string): RoleRow {
    const role = this.#store.role(id);
    if (!role) throw new RoleRefused(404, 'No such role');
    if (id === OWNER_ROLE) throw new RoleRefused(409, "Owner is built in and can't be changed");
    return role;
  }

  /** The fields of a role from untrusted input; `self` is the id being updated, which may keep its own name. */
  #check(input: Record<string, unknown>, self?: string): Omit<RoleRow, 'id'> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > NAME_MAX) throw new RoleRefused(400, `Give a name of 1 to ${NAME_MAX} characters`);
    const taken = this.#store.roleByName(name);
    if (taken && taken.id !== self) throw new RoleRefused(409, `A role named ${taken.name} exists`);
    if (!Array.isArray(input.permissions)) throw new RoleRefused(400, 'Give permissions as a list');
    const unknown = input.permissions.find((p) => !isPermission(p));
    if (unknown !== undefined) throw new RoleRefused(400, `Unknown permission: ${String(unknown)}`);
    const wanted = new Set(input.permissions as Permission[]);
    const permissions = PERMISSIONS.map((p) => p.name).filter((p) => wanted.has(p));
    const note = input.note === undefined ? '' : input.note;
    if (typeof note !== 'string' || note.length > NOTE_MAX) throw new RoleRefused(400, `A note is text of at most ${NOTE_MAX} characters`);
    return { name, permissions, note: note.trim() };
  }
}

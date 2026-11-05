// `Users`: who may use the dashboard. A user is invited (`invite`: a username of 2 to 32 letters, digits, dots,
// dashes or underscores, unique without case; grants; an optional Discord id, 17 to 20 digits, unique, set by owners
// only, for dashboard chat under their linked name) and gets in by an Invite, a one-use link token (`INVITE_MS`,
// 24 h; stored as `hashToken`; used up before the password is hashed, so two takers can't both get in) that
// `acceptInvite` turns into a password and a login; `reset` mints one for an existing user (the old password works
// until it is used). A grant change ends the user's open invites: a link minted for a lesser user must not open a
// greater one. `login` is timing-flat: an unknown, passwordless or disabled name is verified against a
// dummy hash before it is refused; a success re-hashes a password made at a lower cost and sets `last_login`.
// `changePassword` needs the current one and ends the user's other sessions and open invites. `setGrants`, `setDiscordId`, `disable`,
// `enable`, `remove` and `endSessions` take an `Actor` (the audit label, their user id, their grants) and refuse
// (`UsersRefused`, with its status): a user who holds `owner` is changed by owners only, and only an owner grants
// `owner`, never scoped; an actor changes (resets, demotes, disables, deletes, logs out) only a user whose every
// permission they hold unscoped themself, and a grant hands out only such permissions (an owner holds all), so no
// one reaches above their level; the last owner (`UsersStore.ownerCount`) is never demoted, disabled or deleted;
// nobody disables or deletes themself. A
// disabled user's sessions and invites end at once. Every change is audited (target `user:<username>`). Hub core.

import { randomBytes } from 'node:crypto';
import type { AuditEntry } from '../types.ts';
import { can, isOwner, type Grant } from './permissions.ts';
import { checkPassword, COST, dummyHash, hashPassword, verifyPassword, type Cost } from './password.ts';
import { OWNER_ROLE, type Roles } from './roles.ts';
import { hashToken, type GrantRow, type UserRow, type UsersStore } from './store.ts';

export class UsersRefused extends Error {
  readonly status: 400 | 403 | 404 | 409;
  constructor(status: 400 | 403 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/** Who asks: their audit label, their user id (null for the CLI) and their grants. */
export type Actor = { label: string; userId: string | null; grants: readonly Grant[] };

/** A user as the Users page lists them. */
export type UserView = {
  id: string;
  username: string;
  disabled: boolean;
  discordId: string | null;
  lastLogin: number | null;
  hasPassword: boolean;
  grants: { roleId: string; role: string; servers: string[] | null }[];
};

export const INVITE_MS = 24 * 60 * 60_000;
const USERNAME = /^[A-Za-z0-9._-]{2,32}$/;
const DISCORD_ID = /^\d{17,20}$/;
const NO_INVITE = 'That invite is no longer valid';

export type UsersOptions = { knownServer: (id: string) => boolean; cost?: Cost; now?: () => number };

export class Users {
  #store: UsersStore;
  #roles: Roles;
  #audit: (e: AuditEntry) => void;
  #known: (id: string) => boolean;
  #cost: Cost;
  #now: () => number;
  #dummy?: Promise<string>;

  constructor(store: UsersStore, roles: Roles, audit: (e: AuditEntry) => void, opts: UsersOptions) {
    this.#store = store;
    this.#roles = roles;
    this.#audit = audit;
    this.#known = opts.knownServer;
    this.#cost = opts.cost ?? COST;
    this.#now = opts.now ?? Date.now;
  }

  list(): UserView[] {
    return this.#store.users().map((u) => ({
      id: u.id,
      username: u.username,
      disabled: u.disabled,
      discordId: u.discordId,
      lastLogin: u.lastLogin,
      hasPassword: u.password !== null,
      grants: this.#store.grantsOf(u.id).map((g) => ({ roleId: g.roleId, role: this.#roles.get(g.roleId)?.name ?? g.roleId, servers: g.servers })),
    }));
  }

  /** The per-request read: the user and their grants; undefined for an unknown id. */
  resolve(userId: string): { user: UserRow; grants: Grant[] } | undefined {
    return this.#store.resolve(userId);
  }

  /** A new user with their grants and an invite token; `input` is untrusted. */
  invite(input: Record<string, unknown>, actor: Actor): { id: string; username: string; token: string } {
    const username = typeof input.username === 'string' ? input.username.trim() : '';
    if (!USERNAME.test(username)) throw new UsersRefused(400, 'A username is 2 to 32 letters, digits, dots, dashes or underscores');
    const taken = this.#store.userByName(username);
    if (taken) throw new UsersRefused(409, `A user named ${taken.username} exists`);
    const discordId = this.#checkDiscordId(input.discordId, actor);
    const grants = this.#checkGrants(actor, input.grants);
    const id = randomBytes(12).toString('base64url');
    let token = '';
    this.#store.transaction(() => {
      this.#store.addUser({ id, username, discordId, created: this.#now() });
      this.#store.setGrants(id, grants);
      token = this.#mint(id, actor.label);
    });
    this.#audit({ actor: actor.label, action: 'user invited', target: `user:${username}`, details: this.#describe(grants) });
    return { id, username, token };
  }

  /** A new invite token for an existing user: how a password is reset. */
  reset(userId: string, actor: Actor): { token: string } {
    const user = this.#target(userId, actor);
    const token = this.#mint(user.id, actor.label);
    this.#audit({ actor: actor.label, action: 'password reset', target: `user:${user.username}`, details: 'an invite link was made' });
    return { token };
  }

  /** The invite's user, now with this password and logged in: their invites and earlier sessions are gone. */
  async acceptInvite(token: unknown, password: unknown): Promise<UserRow> {
    const found = typeof token === 'string' ? this.#store.invite(hashToken(token), this.#now()) : undefined;
    if (!found || this.#store.user(found.userId)?.disabled !== false) throw new UsersRefused(404, NO_INVITE);
    const reason = checkPassword(password);
    if (reason) throw new UsersRefused(400, reason); // checked before the link is used up: a typo doesn't burn it
    const invite = this.#store.takeInvite(found.id, this.#now());
    const user = invite && this.#store.user(invite.userId);
    if (!user || user.disabled) throw new UsersRefused(404, NO_INVITE);
    this.#store.setPassword(user.id, await hashPassword(password as string, this.#cost));
    this.#store.deleteInvitesOf(user.id);
    this.#store.deleteSessionsOf(user.id);
    this.#store.setLastLogin(user.id, this.#now());
    this.#audit({ actor: self(user), action: 'invite accepted', target: `user:${user.username}`, details: `invited by ${invite!.by}` });
    return this.#store.user(user.id)!;
  }

  /** The user behind the credentials, or undefined for any failure, in the same time. */
  async login(username: unknown, password: unknown): Promise<UserRow | undefined> {
    if (typeof username !== 'string' || typeof password !== 'string') return undefined;
    const user = this.#store.userByName(username);
    const stored = user?.password ?? (await (this.#dummy ??= dummyHash(this.#cost)));
    const { ok, rehash } = await verifyPassword(password, stored, this.#cost);
    if (!user?.password || user.disabled || !ok) return undefined;
    if (rehash) this.#store.setPassword(user.id, rehash);
    this.#store.setLastLogin(user.id, this.#now());
    return user;
  }

  /** The user's own change; `keepSession` (hashed) survives, every other session of theirs ends. */
  async changePassword(userId: string, current: unknown, next: unknown, keepSession?: string): Promise<void> {
    const user = this.#store.user(userId);
    if (!user) throw new UsersRefused(404, 'No such user');
    const ok = typeof current === 'string' && user.password !== null && (await verifyPassword(current, user.password, this.#cost)).ok;
    if (!ok) throw new UsersRefused(403, 'Wrong password');
    const reason = checkPassword(next);
    if (reason) throw new UsersRefused(400, reason);
    this.#store.setPassword(user.id, await hashPassword(next as string, this.#cost));
    this.#store.deleteInvitesOf(user.id); // a reset link from before is no longer theirs to want
    this.#store.deleteSessionsOf(user.id, keepSession);
    this.#audit({ actor: self(user), action: 'password changed', target: `user:${user.username}`, details: '' });
  }

  setGrants(userId: string, input: unknown, actor: Actor): void {
    const user = this.#target(userId, actor);
    const grants = this.#checkGrants(actor, input);
    if (!grants.some((g) => g.roleId === OWNER_ROLE)) this.#notLastOwner(userId, 'demoted');
    this.#store.transaction(() => {
      this.#store.setGrants(userId, grants);
      this.#store.deleteInvitesOf(userId);
    });
    this.#audit({ actor: actor.label, action: 'user changed', target: `user:${user.username}`, details: `${this.#describe(grants)}; open invite links ended` });
  }

  setDiscordId(userId: string, discordId: unknown, actor: Actor): void {
    const user = this.#target(userId, actor);
    const id = this.#checkDiscordId(discordId, actor, userId);
    this.#store.setDiscordId(userId, id);
    this.#audit({ actor: actor.label, action: 'user changed', target: `user:${user.username}`, details: id ? `Discord id ${id}` : 'Discord id removed' });
  }

  disable(userId: string, actor: Actor): void {
    if (userId === actor.userId) throw new UsersRefused(409, "You can't disable yourself");
    const user = this.#target(userId, actor);
    this.#notLastOwner(userId, 'disabled');
    this.#store.setDisabled(userId, true);
    this.#store.deleteSessionsOf(userId);
    this.#store.deleteInvitesOf(userId); // enabling later doesn't revive an old link
    this.#audit({ actor: actor.label, action: 'user disabled', target: `user:${user.username}`, details: '' });
  }

  enable(userId: string, actor: Actor): void {
    const user = this.#target(userId, actor);
    this.#store.setDisabled(userId, false);
    this.#audit({ actor: actor.label, action: 'user enabled', target: `user:${user.username}`, details: '' });
  }

  remove(userId: string, actor: Actor): void {
    if (userId === actor.userId) throw new UsersRefused(409, "You can't delete yourself");
    const user = this.#target(userId, actor);
    this.#notLastOwner(userId, 'deleted');
    this.#store.deleteUser(userId);
    this.#audit({ actor: actor.label, action: 'user deleted', target: `user:${user.username}`, details: '' });
  }

  endSessions(userId: string, actor: Actor): void {
    const user = this.#target(userId, actor);
    this.#store.deleteSessionsOf(userId);
    this.#audit({ actor: actor.label, action: 'sessions ended', target: `user:${user.username}`, details: '' });
  }

  #mint(userId: string, by: string): string {
    const token = randomBytes(32).toString('base64url');
    this.#store.addInvite({ id: hashToken(token), userId, expires: this.#now() + INVITE_MS, by });
    return token;
  }

  /** The user an actor may change: a holder of `owner` only by an owner, anyone else only by an actor who holds all they hold. */
  #target(userId: string, actor: Actor): UserRow {
    const resolved = this.#store.resolve(userId);
    if (!resolved) throw new UsersRefused(404, 'No such user');
    if (!isOwner(actor.grants)) {
      if (resolved.grants.some((g) => g.owner)) throw new UsersRefused(403, 'Only an owner may change an owner');
      const above = resolved.grants.flatMap((g) => g.permissions).find((p) => !can(actor.grants, p));
      if (above) throw new UsersRefused(403, `You can't change ${resolved.user.username}: they hold ${above}, which you don't hold`);
    }
    return resolved.user;
  }

  #notLastOwner(userId: string, what: string): void {
    if (this.#store.isOwnerUser(userId) && this.#store.ownerCount() === 1) throw new UsersRefused(409, `The last owner can't be ${what}`);
  }

  /** Grants from untrusted input, within what the actor may hand out. */
  #checkGrants(actor: Actor, input: unknown): GrantRow[] {
    if (!Array.isArray(input)) throw new UsersRefused(400, 'Give grants as a list');
    const out: GrantRow[] = [];
    for (const raw of input as Record<string, unknown>[]) {
      const role = typeof raw?.roleId === 'string' ? this.#roles.get(raw.roleId) : undefined;
      if (!role) throw new UsersRefused(400, 'Unknown role');
      if (out.some((g) => g.roleId === role.id)) throw new UsersRefused(400, `${role.name} is granted twice`);
      const servers = this.#checkServers(raw.servers);
      if (role.id === OWNER_ROLE) {
        if (servers) throw new UsersRefused(400, 'Owner is for every server');
        if (!isOwner(actor.grants)) throw new UsersRefused(403, 'Only an owner may grant Owner');
      } else if (!isOwner(actor.grants)) {
        const missing = role.permissions.find((p) => !can(actor.grants, p));
        if (missing) throw new UsersRefused(403, `You can't grant ${role.name}: it has ${missing}, which you don't hold`);
      }
      out.push({ roleId: role.id, servers });
    }
    return out;
  }

  #checkServers(input: unknown): string[] | null {
    if (input === undefined || input === null) return null;
    if (!Array.isArray(input) || !input.length) throw new UsersRefused(400, 'Pick at least one server, or every server');
    const servers = [...new Set(input as unknown[])];
    const unknown = servers.find((s) => typeof s !== 'string' || !this.#known(s));
    if (unknown !== undefined) throw new UsersRefused(400, `Unknown server: ${String(unknown)}`);
    return servers as string[];
  }

  /** A Discord id, 17 to 20 digits or none; owners set them (a chat line goes out under the linked name), and no two users share one. */
  #checkDiscordId(input: unknown, actor: Actor, self?: string): string | null {
    if (input === undefined || input === null || input === '') return null;
    if (typeof input !== 'string' || !DISCORD_ID.test(input)) throw new UsersRefused(400, 'A Discord id is 17 to 20 digits');
    if (!isOwner(actor.grants)) throw new UsersRefused(403, 'Only an owner may set a Discord id');
    const holder = this.#store.userByDiscordId(input);
    if (holder && holder.id !== self) throw new UsersRefused(409, `${holder.username} has that Discord id`);
    return input;
  }

  #describe(grants: GrantRow[]): string {
    if (!grants.length) return 'no roles';
    return grants.map((g) => `${this.#roles.get(g.roleId)?.name ?? g.roleId}${g.servers ? ` on ${g.servers.join(', ')}` : ''}`).join('; ');
  }
}

/** The audit actor for what a user does to their own account, as the web routes name them. */
const self = (u: UserRow) => `web:${u.username} (${u.id})`;

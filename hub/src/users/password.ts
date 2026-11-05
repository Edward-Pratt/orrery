// Passwords: `checkPassword` (12 to 256 characters, nothing else: the reason one is refused, or undefined);
// `hashPassword` (scrypt at `COST`, N 2^15, r 8, p 1, which needs `maxmem` above Node's 32 MiB default; a random
// 16-byte salt; a 32-byte key; stored as `scrypt:N:r:p:<salt>:<key>` in base64url, so the cost can be raised later);
// `verifyPassword` (constant-time; `rehash` is a fresh hash to store when the stored cost is below the current one);
// `dummyHash`, a hash to verify against when there is no user, so an answer's time says nothing. All async: a hash
// takes about 40 ms and must not block the hub. A `cost` parameter lets tests run at a low N. Hub core, pure.

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export type Cost = { N: number; r: number; p: number };
export const COST: Cost = { N: 2 ** 15, r: 8, p: 1 };
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 256;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

export function checkPassword(password: unknown): string | undefined {
  if (typeof password !== 'string') return 'Give a password';
  if (password.length < PASSWORD_MIN) return `A password is at least ${PASSWORD_MIN} characters`;
  if (password.length > PASSWORD_MAX) return `A password is at most ${PASSWORD_MAX} characters`;
  return undefined;
}

/** scrypt needs 128 * N * r bytes; twice that is given so it never refuses the cost. */
const derive = (password: string, salt: Buffer, cost: Cost) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { ...cost, maxmem: 256 * cost.N * cost.r }, (err, key) => (err ? reject(err) : resolve(key)));
  });

export async function hashPassword(password: string, cost = COST): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, cost);
  return ['scrypt', cost.N, cost.r, cost.p, salt.toString('base64url'), key.toString('base64url')].join(':');
}

function parse(stored: string): { cost: Cost; salt: Buffer; key: Buffer } | undefined {
  const [kind, N, r, p, salt, key] = stored.split(':');
  if (kind !== 'scrypt' || !N || !r || !p || !salt || !key) return undefined;
  const cost = { N: Number(N), r: Number(r), p: Number(p) };
  if (![cost.N, cost.r, cost.p].every((n) => Number.isInteger(n) && n > 0)) return undefined;
  return { cost, salt: Buffer.from(salt, 'base64url'), key: Buffer.from(key, 'base64url') };
}

/** Whether `password` is the one behind `stored`; `rehash` when it is and `stored` was made at a lower cost than `cost`. */
export async function verifyPassword(password: string, stored: string, cost = COST): Promise<{ ok: boolean; rehash?: string }> {
  const parsed = parse(stored);
  if (!parsed) return { ok: false };
  const key = await derive(password, parsed.salt, parsed.cost);
  if (key.length !== parsed.key.length || !timingSafeEqual(key, parsed.key)) return { ok: false };
  const below = parsed.cost.N < cost.N || parsed.cost.r < cost.r || parsed.cost.p < cost.p;
  return below ? { ok: true, rehash: await hashPassword(password, cost) } : { ok: true };
}

/** A hash of a random password at `cost`, to verify unknown names against at the same speed as known ones. */
export const dummyHash = (cost = COST): Promise<string> => hashPassword(randomBytes(SALT_BYTES).toString('base64url'), cost);

// The checks on what crosses a game connection's trust boundary, as pure functions: untrusted text made safe for one
// line of Minecraft chat (`mcText`: `§` codes and control characters out, cut without half an emoji), a configured
// token compared with one a connection sent in constant time (`tokenMatches`), and why a hello's protocol version is
// refused (`protocolRefusal`, the same range for a Mod's hello and an Agent's). `servers.ts` re-exports them all.
// Hub core.

import { timingSafeEqual } from 'node:crypto';
import { MIN_PROTOCOL, PROTOCOL_VERSION } from '../protocol.ts';

/** Removes Minecraft § formatting codes. */
export function stripCodes(s: string): string {
  return s.replace(/§.?/gs, '');
}

/** Cuts s to at most max UTF-16 units without leaving half an emoji (a lone high surrogate) at the end. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Makes untrusted text safe for a single line of Minecraft chat. */
export function mcText(s: string, max: number): string {
  return truncate(
    stripCodes(s)
      .replace(/[\u0000-\u001f\u007f\s]+/g, ' ')
      .trim(),
    max,
  );
}

/** Compares a configured token with one a connection sent, in constant time. */
export function tokenMatches(expected: string, got: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Why a hello's protocol version is refused (the same range for a Mod's hello and an Agent's), or null. */
export function protocolRefusal(p: number): string | null {
  if (Number.isInteger(p) && p >= MIN_PROTOCOL && p <= PROTOCOL_VERSION) return null;
  const speaks = MIN_PROTOCOL === PROTOCOL_VERSION ? `${PROTOCOL_VERSION}` : `${MIN_PROTOCOL}–${PROTOCOL_VERSION}`;
  return `protocol ${p} not supported (hub speaks ${speaks})`;
}

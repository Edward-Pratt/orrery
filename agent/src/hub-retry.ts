// When the Agent connection (`hub-agent.ts`) says its hello again after a close. Any close reconnects after `backoff`
// (1 s doubling to 60 s, jittered into the upper half, reset by a welcome). A hello the hub refuses as
// `reconnecting too fast` (`TOO_FAST`: under 5 s after its last welcome, `HUB_WELCOME_GAP_MS`) counts no failure: the
// next hello waits what is left of those 5 s since the last welcome it saw (all of them before its first), and a
// twentieth more (`tooFastWait`).

/**
 * The hub's `HANDSHAKE_MS`: it refuses an Agent connection's hello under 5 s after it last welcomed one for this
 * agent (`reject` with `TOO_FAST`), and keeps the connection that welcome opened, if it is still up.
 */
export const HUB_WELCOME_GAP_MS = 5_000;
export const TOO_FAST = 'reconnecting too fast';

/**
 * The wait before the next hello after the hub refused one as `TOO_FAST`: what is left of `gap` since the last welcome
 * this agent saw (`sinceWelcome` ms ago; null: none since it started, so all of it), and a twentieth of `gap` more,
 * since the hub stamped that welcome a little before it arrived here.
 */
export function tooFastWait(sinceWelcome: number | null, gap: number): number {
  return Math.max(0, gap - (sinceWelcome ?? 0)) + gap / 20;
}

/** The wait before reconnecting after `failures` closes since the last welcome: base × 2^failures up to `max`, jittered into its upper half. */
export function backoff(failures: number, base: number, max: number, random: () => number): number {
  const full = Math.min(max, base * 2 ** failures);
  return full / 2 + (full / 2) * random();
}

// The chat bridge's rules: which Discord messages go into the game (`shouldRelay`: people's own only), and how a game
// or dashboard line goes out through a channel's relay webhook: under the name `relayAs` gives (dashboard lines as
// `<name> (dashboard)`, a factorio player's as `<name> (Factorio)`, and one with whitespace or parentheses posted as
// the bot, so a game's line never passes for a dashboard one or the bot, and one with `discord` or `clyde` in it (any
// case), which Discord refuses as a webhook name, posted as the bot at once; player skins as chat avatars on minecraft
// servers only); `sendChat`: content escaped and cut to 2000, and a name remembered as refused only when Discord's
// error is about the username (`usernameRefused`), never for the content, the newest `REFUSED_KEPT` (1000) kept, the
// oldest dropped; then posted as the bot. `errorCode` and Discord's error codes for `discord.ts`.

import type { Message, Webhook } from 'discord.js';
import { chatContent } from './format-text.ts';
import type { HubEvent } from '../servers/servers.ts';
import type { Game } from '../types.ts';

// Discord API error codes.
export const UNKNOWN_WEBHOOK = 10015;
export const MISSING_PERMISSIONS = 50013;
const INVALID_FORM_BODY = 50035; // a field Discord won't take: a webhook username containing "discord", content too long

/** Only people's own messages go into the game: not bots, webhooks (including our relay), or system notices. */
export function shouldRelay(m: Pick<Message, 'author' | 'webhookId' | 'system'>): boolean {
  return !m.author.bot && !m.webhookId && !m.system;
}

/**
 * Who a chat line is posted as through the relay webhook, or null to post it as the bot (`formatEvent`, the name
 * escaped). A dashboard line: `<user> (dashboard)`, the webhook's own avatar. A minecraft player: their name with their skin.
 * A factorio player: `<name> (Factorio)`, so a line can never pass for a dashboard one or the bot, and only for a name
 * with no whitespace or parentheses: any text can come as a name from the game's mods or the Agent, and `Edward
 * (dashboard)` would look like the owner's line. A factorio name with "discord" or "clyde" in it, which Discord refuses
 * as a webhook username, is posted as the bot at once: no doomed webhook call, and nothing for `refusedNames` to keep.
 */
export function relayAs(e: Extract<HubEvent, { type: 'chat' | 'say' }>, game: Game | undefined): { username: string; avatarURL?: string } | null {
  if (e.type === 'say') return { username: `${e.author} (dashboard)` };
  if (game === 'factorio') return /[\s()]|discord|clyde/i.test(e.player) ? null : { username: `${e.player} (Factorio)` };
  return { username: e.player, avatarURL: game === 'minecraft' ? `https://mc-heads.net/avatar/${encodeURIComponent(e.player)}/64` : undefined };
}

/** The most names `refusedNames` keeps: past it, the oldest is dropped (it is only tried once more). */
export const REFUSED_KEPT = 1000;

export const errorCode = (err: unknown) => (err as { code?: number }).code;

/** Whether Discord refused a webhook send for its username (one containing "discord", say), not for anything else. */
export function usernameRefused(err: unknown): boolean {
  const errors = (err as { rawError?: { errors?: unknown } }).rawError?.errors;
  return errorCode(err) === INVALID_FORM_BODY && typeof errors === 'object' && errors !== null && Object.hasOwn(errors, 'username');
}

/**
 * Posts a chat line through a channel's relay webhook under `username`, escaped and cut to Discord's 2000 characters.
 * Throws what Discord answered; a name it refused is remembered in `refusedNames` (the newest `REFUSED_KEPT`), so it
 * isn't tried again, while any other error (the content, a deleted webhook) leaves the name alone.
 */
export async function sendChat(
  hook: Pick<Webhook, 'send'>,
  refusedNames: Set<string>,
  username: string,
  avatarURL: string | undefined,
  message: string,
): Promise<void> {
  try {
    await hook.send({ username, avatarURL, content: chatContent(message), allowedMentions: { parse: [] } });
  } catch (err) {
    if (usernameRefused(err)) {
      refusedNames.add(username);
      if (refusedNames.size > REFUSED_KEPT) refusedNames.delete(refusedNames.values().next().value!); // a Set keeps insertion order
    }
    throw err;
  }
}

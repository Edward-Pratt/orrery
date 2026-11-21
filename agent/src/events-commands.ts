// The hub's say, notice and linkResult out, as the Factorio mod's RCON commands (factorio/CLAUDE.md, "Agent to mod").
//
// `toCommand`: `say`, `notice`, `linkResult` as `/orrery-say {author, message, source}`, `/orrery-notice {message}`,
// `/orrery-reply {player, ok, message}`, the argument `commandJson` (`JSON.stringify`, plus `\u` escapes for DEL, the
// C1 controls and U+2028/9): one line, never Lua. `toGame` runs one and logs a failure or a reply that is not
// `{"ok":true, …}` (`answeredOk`, which `GameEvents` also asks of `/orrery-hello`'s reply).
import { isObject } from './events-datagram.ts';
import { printable, type ToGame } from './wire.ts';

/** Whether a mod command's reply is `{"ok": true, …}` (JSON from `table_to_json`, its keys in any order). */
export function answeredOk(reply: string): boolean {
  try {
    const r: unknown = JSON.parse(reply);
    return isObject(r) && r.ok === true;
  } catch {
    return false;
  }
}

/**
 * JSON for an RCON command's argument: `JSON.stringify` (control characters escaped, so never a newline), with the
 * characters it leaves as they are but that a console line shouldn't carry escaped too (DEL, the C1 controls, the
 * line and paragraph separators). Plain JSON either way, which `helpers.json_to_table` reads.
 */
export function commandJson(value: object): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * The mod's RCON command for a message from the hub (factorio/CLAUDE.md, "Agent to mod"): `say` is `/orrery-say
 * {author, message, source}`, `notice` `/orrery-notice {message}`, `linkResult` `/orrery-reply {player, ok, message}`.
 * One line with a JSON argument: never Lua, never `/c` or `/sc` (the mod makes the text safe to print).
 */
export function toCommand(msg: ToGame): string {
  switch (msg.type) {
    case 'say':
      return `/orrery-say ${commandJson({ author: msg.author, message: msg.message, source: msg.source })}`;
    case 'notice':
      return `/orrery-notice ${commandJson({ message: msg.message })}`;
    case 'linkResult':
      return `/orrery-reply ${commandJson({ player: msg.player, ok: msg.ok, message: msg.message })}`;
  }
}

/** Carries out a message from the hub in game over RCON; a failure or an answer other than `{"ok":true}` is logged. */
export async function toGame(run: (command: string) => Promise<string>, msg: ToGame): Promise<void> {
  try {
    const reply = await run(toCommand(msg));
    if (!answeredOk(reply)) console.error(`[game] ${msg.type} was not shown: ${printable(JSON.stringify(reply.slice(0, 200)))}`);
  } catch (err) {
    console.error(`[game] ${msg.type} was not shown: ${(err as Error).message}`);
  }
}

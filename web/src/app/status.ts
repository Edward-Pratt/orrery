// `Status`: the shared state display, Armil's Status (`ar-status`: a dot in the state's colour plus its word);
// `serverState` for a server's card and `publicServerState` for the Status page.

import { Component, input } from '@angular/core';
import type { PublicState, ServerCard } from '@hub/api';

export type Health = 'ok' | 'warn' | 'down';

/** The one way a state is shown: a coloured dot plus a word, so colour is never the only signal. */
@Component({
  selector: 'app-status',
  template: `<span class="ar-status" [class]="tone[health()]">{{ label() }}</span>`,
})
export class Status {
  readonly health = input.required<Health>();
  readonly label = input.required<string>();
  protected readonly tone = { ok: 'ar-status--ok', warn: 'ar-status--warn', down: 'ar-status--danger' };
}

/** How a server's card is shown, on its row and its page. */
export const serverState = (c: ServerCard): { health: Health; label: string } => ({
  health: !c.online || c.hung ? 'down' : c.lagging ? 'warn' : 'ok',
  label: c.hung ? 'Not responding' : !c.online ? 'Offline' : c.lagging ? 'Lagging' : 'Online',
});

/** How a server shows on the Status page: its state's word, "Not responding" as on its card. */
export const publicServerState = (state: PublicState): { health: Health; label: string } => PUBLIC_STATES[state];
const PUBLIC_STATES: Record<PublicState, { health: Health; label: string }> = {
  up: { health: 'ok', label: 'Up' },
  paused: { health: 'ok', label: 'Up · paused' },
  hung: { health: 'down', label: 'Not responding' },
  down: { health: 'down', label: 'Down' },
};

import { Component, input } from '@angular/core';

export type Health = 'ok' | 'warn' | 'down';

/** The one way a state is shown: a coloured dot plus a word, so colour is never the only signal. */
@Component({
  selector: 'app-status',
  template: `
    <span class="inline-flex items-center gap-1.5">
      <span class="size-2.5 shrink-0 rounded-full" [class]="dot[health()]" aria-hidden="true"></span>
      <span [class]="text[health()]">{{ label() }}</span>
    </span>
  `,
})
export class Status {
  readonly health = input.required<Health>();
  readonly label = input.required<string>();
  protected readonly dot = { ok: 'bg-status-ok', warn: 'bg-status-warn', down: 'bg-status-down' };
  protected readonly text = { ok: '', warn: 'text-status-warn', down: 'text-status-down' };
}

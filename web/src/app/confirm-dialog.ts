import { Component, signal } from '@angular/core';
import { HlmAlertDialogImports } from '@spartan-ng/helm/alert-dialog';
import { HlmInput } from '@spartan-ng/helm/input';
import type { ConfirmOptions } from './feedback';

/** `Feedback.confirm`'s dialog, in its own chunk: it and what it needs (the alert dialog, the input and its forms) stay out of the first load. */
@Component({
  selector: 'app-confirm-dialog',
  imports: [HlmAlertDialogImports, HlmInput],
  template: `
    <hlm-alert-dialog state="open" (closed)="done(false)">
      <hlm-alert-dialog-content *hlmAlertDialogPortal="let ctx">
        <hlm-alert-dialog-header>
          <h2 hlmAlertDialogTitle>{{ o.title }}</h2>
          @if (o.description) {
            <p hlmAlertDialogDescription>{{ o.description }}</p>
          }
        </hlm-alert-dialog-header>
        @if (o.typeName) {
          <label class="text-sm">
            Type <b>{{ o.typeName }}</b> to confirm
            <input hlmInput class="mt-1 w-full" autocomplete="off" data-confirm-typed (input)="typed.set($any($event.target).value)" />
          </label>
        }
        <hlm-alert-dialog-footer>
          <button hlmAlertDialogCancel data-confirm-cancel>Cancel</button>
          <button
            hlmAlertDialogAction
            [variant]="o.destructive ? 'destructive' : 'default'"
            [disabled]="!!o.typeName && typed() !== o.typeName"
            (click)="done(true)"
            data-confirm-ok
          >
            {{ o.verb }}
          </button>
        </hlm-alert-dialog-footer>
      </hlm-alert-dialog-content>
    </hlm-alert-dialog>
  `,
})
export default class ConfirmDialog {
  o!: ConfirmOptions;
  done!: (ok: boolean) => void;
  protected readonly typed = signal('');
}

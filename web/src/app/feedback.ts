import { HttpErrorResponse } from '@angular/common/http';
import { ApplicationRef, Component, EnvironmentInjector, Injectable, createComponent, inject, signal } from '@angular/core';
import { toast } from '@spartan-ng/brain/sonner';
import { HlmAlertDialogImports } from '@spartan-ng/helm/alert-dialog';
import { HlmInput } from '@spartan-ng/helm/input';

/** What a confirmation says: the title names the target and the consequence, the red button carries the verb. */
export type ConfirmOptions = {
  title: string;
  verb: string;
  description?: string;
  /** Red button, for what can't be undone. */
  destructive?: boolean;
  /** Ask for this to be typed exactly before the button enables. */
  typeName?: string;
};

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
class ConfirmDialog {
  o!: ConfirmOptions;
  done!: (ok: boolean) => void;
  protected readonly typed = signal('');
}

/** The one place the dashboard asks "are you sure?", and reports the outcome of its own requests as toasts. */
@Injectable({ providedIn: 'root' })
export class Feedback {
  readonly #app = inject(ApplicationRef);
  readonly #env = inject(EnvironmentInjector);

  /** Resolves true once confirmed; harmless or undoable actions don't ask at all. */
  confirm(o: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      const ref = createComponent(ConfirmDialog, { environmentInjector: this.#env });
      let over = false;
      ref.instance.o = o;
      ref.instance.done = (ok) => {
        if (over) return;
        over = true;
        resolve(ok);
        // After the dialog's close animation has had its turn.
        setTimeout(() => ref.destroy(), 300);
      };
      this.#app.attachView(ref.hostView);
      ref.changeDetectorRef.detectChanges();
    });
  }

  /** A brief toast for the outcome of this browser's own request. */
  ok(message: string): void {
    toast.success(message);
  }

  /** A toast that stays until dismissed, with the hub's message. */
  failed(what: string, err: HttpErrorResponse): void {
    const why = typeof err.error === 'string' && err.error ? err.error : `HTTP ${err.status}`;
    toast.error(`${what} failed: ${why}`, { duration: Infinity, closeButton: true });
  }
}

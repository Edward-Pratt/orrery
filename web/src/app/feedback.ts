import { HttpErrorResponse } from '@angular/common/http';
import { ApplicationRef, EnvironmentInjector, Injectable, createComponent, inject } from '@angular/core';
import { toast } from '@spartan-ng/brain/sonner';

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

/** The one place the dashboard asks "are you sure?", and reports the outcome of its own requests as toasts. */
@Injectable({ providedIn: 'root' })
export class Feedback {
  readonly #app = inject(ApplicationRef);
  readonly #env = inject(EnvironmentInjector);

  /**
   * The dialog's chunk, fetched once the page is idle so a confirmation opens at once, and so it's in hand before a
   * dashboard deploy can replace the build under the open page.
   */
  readonly #dialog = new Promise<void>((r) => (globalThis.requestIdleCallback ?? setTimeout)(() => r())).then(() => import('./confirm-dialog'));

  /** Resolves true once confirmed; harmless or undoable actions don't ask at all. */
  async confirm(o: ConfirmOptions): Promise<boolean> {
    const { default: ConfirmDialog } = await this.#dialog;
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

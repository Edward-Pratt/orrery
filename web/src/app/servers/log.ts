import { DestroyRef, Directive, ElementRef, inject } from '@angular/core';

/** A scrolling log that stays at the bottom as lines arrive, unless the reader has scrolled up. */
@Directive({ selector: '[appStickBottom]', host: { class: 'overflow-y-auto', role: 'log', '(scroll)': 'track()' } })
export class StickBottom {
  readonly #el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  #pinned = true;

  constructor() {
    const watch = new MutationObserver(() => {
      if (this.#pinned) this.#el.scrollTop = this.#el.scrollHeight;
    });
    watch.observe(this.#el, { childList: true, subtree: true });
    inject(DestroyRef).onDestroy(() => watch.disconnect());
  }

  protected track(): void {
    this.#pinned = this.#el.scrollHeight - this.#el.scrollTop - this.#el.clientHeight < 24;
  }
}

import { Component, input } from '@angular/core';
import type { PackState } from '@hub/api';

/**
 * The Pack tab's Kept paths: never deleted or overwritten by an update, this server's own (`config.json`'s `keep`)
 * first as chips, then the built-in ones muted.
 */
@Component({
  selector: 'app-pack-kept',
  host: { class: 'contents' },
  template: `
    @let p = state();
    <section data-kept>
      <h2 class="ar-t-heading-sm">Kept paths</h2>
      <p class="mb-2 text-sm text-muted-foreground">
        Never deleted or overwritten by an update. This server's own are set in <span class="font-mono text-xs">config.json</span> (<span
          class="font-mono text-xs"
          >keep</span
        >).
      </p>
      <div class="flex flex-wrap gap-1.5">
        @for (k of p.kept.server; track k) {
          <span class="rounded-md border px-2 py-0.5 font-mono text-xs" data-kept-server>{{ k }}</span>
        }
        @for (k of p.kept.builtIn; track k) {
          <span class="rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground" data-kept-builtin>{{ k }}</span>
        }
      </div>
    </section>
  `,
})
export class PackKept {
  readonly state = input.required<PackState>();
}

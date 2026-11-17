import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmSkeleton],hlm-skeleton',
  host: {
    'data-slot': 'skeleton',
  },
})
export class HlmSkeleton {
  constructor() {
    // Armil's skeleton (a still `raised` block, breathing with its `ar-wait`), at the size the caller gives it:
    // `ar-skeleton` itself is one 12px line.
    classes(() => 'bg-muted rounded-xs block motion-safe:animate-[ar-wait_1.6s_ease-in-out_infinite]');
  }
}

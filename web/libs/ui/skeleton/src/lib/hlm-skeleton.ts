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
    // Armil's skeleton, a still `raised` block that breathes (and stops under reduced motion), at the size the caller
    // gives it: the caller's h-* wins over `ar-skeleton`'s 12px line, as the utilities come after armil.css. A stand-in
    // for a card or a chart adds `ar-skeleton--block` (its radius-lg) and keeps its h-*.
    classes(() => 'ar-skeleton');
  }
}

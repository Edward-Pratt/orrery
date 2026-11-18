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
    // gives it: the caller's h-* wins over `ar-skeleton`'s one 12px line, as the utilities come after armil.css.
    classes(() => 'ar-skeleton');
  }
}

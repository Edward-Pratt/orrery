import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

/** Armil's Loading spinner (`ar-spinner`): a planet going round its ring, still under reduced motion. */
@Component({
  selector: 'hlm-spinner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-slot': 'spinner',
    role: 'status',
    '[attr.aria-label]': 'ariaLabel()',
  },
  template: ``,
})
export class HlmSpinner {
  /** Aria label for the spinner for accessibility. */
  public readonly ariaLabel = input<string>('Loading', { alias: 'aria-label' });

  constructor() {
    classes(() => 'ar-spinner');
  }
}

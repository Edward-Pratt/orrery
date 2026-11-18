import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmAlertDialogHeader],hlm-alert-dialog-header',
  host: { 'data-slot': 'alert-dialog-header' },
})
export class HlmAlertDialogHeader {
  constructor() {
    classes(
      () =>
        'grid has-data-[slot=alert-dialog-media]:grid-cols-[auto_1fr] has-data-[slot=alert-dialog-media]:gap-x-4',
    );
  }
}

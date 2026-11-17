import { Directive } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';

@Directive({
  selector: '[hlmAlertDialogFooter],hlm-alert-dialog-footer',
  host: { 'data-slot': 'alert-dialog-footer' },
})
export class HlmAlertDialogFooter {
  constructor() {
    classes(
      () =>
        'flex flex-wrap justify-end gap-2',
    );
  }
}

// `ThemeSwitch`: Armil's ThemeSwitch, the one control that changes the theme (`Theme`): "Use Paper" with the sun while
// dark, "Use Dark" with the moon in Paper, never icon-only. It takes the type of what it sits in; below 768px
// armil.css makes it the touch height, as it sits in the phone top bar there.

import { Component, inject } from '@angular/core';
import { Theme } from './theme';

@Component({
  selector: 'app-theme-switch',
  template: `
    <button type="button" class="ar-themeswitch" (click)="theme.toggle()" data-theme-switch>
      <i class="ar-icon" [class]="theme.dark() ? 'ar-icon--sun' : 'ar-icon--moon'"></i><span>{{ theme.dark() ? 'Use Paper' : 'Use Dark' }}</span>
    </button>
  `,
})
export class ThemeSwitch {
  protected readonly theme = inject(Theme);
}

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { BrnAvatar } from '@spartan-ng/brain/avatar';
import { classes } from '@spartan-ng/helm/utils';

@Component({
  selector: 'hlm-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  hostDirectives: [BrnAvatar],
  host: {
    'data-slot': 'avatar',
    '[attr.data-size]': 'size()',
  },
  template: `
    <ng-content select="[hlmAvatarImage],[brnAvatarImage]" />
    <ng-content select="[hlmAvatarFallback],[brnAvatarFallback]" />
    <ng-content />
  `,
})
export class HlmAvatar {
  public readonly size = input<'default' | 'sm' | 'lg'>('default');

  constructor() {
    classes(
      () =>
        // Armil's Mark with the user's initials: verdigris-wash, 26px (20px small).
        ['ar-mark group/avatar relative select-none', this.size() !== 'sm' && 'ar-mark--lg'],
    );
  }
}

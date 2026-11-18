import { type BooleanInput } from '@angular/cdk/coercion';
import { CdkMenuItem } from '@angular/cdk/menu';
import { booleanAttribute, Directive, HOST_TAG_NAME, inject, input } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';
import { HlmDropdownMenuFocusOnHover } from './hlm-dropdown-menu-focus-on-hover';

@Directive({
  selector: '[hlmDropdownMenuItem],hlm-dropdown-menu-item',
  hostDirectives: [
    {
      directive: CdkMenuItem,
      inputs: ['cdkMenuItemDisabled: disabled'],
      outputs: ['cdkMenuItemTriggered: triggered'],
    },
    HlmDropdownMenuFocusOnHover,
  ],
  host: {
    'data-slot': 'dropdown-menu-item',
    '[attr.disabled]': '_isButton && disabled() ? "" : null',
    '[attr.data-disabled]': 'disabled() ? "" : null',
    '[attr.data-variant]': 'variant()',
    '[attr.data-inset]': 'inset() ? "" : null',
  },
})
export class HlmDropdownMenuItem {
  protected readonly _isButton = inject(HOST_TAG_NAME) === 'button';

  public readonly disabled = input<boolean, BooleanInput>(false, { transform: booleanAttribute });

  public readonly variant = input<'default' | 'destructive'>('default');

  public readonly inset = input<boolean, BooleanInput>(false, {
    transform: booleanAttribute,
  });

  constructor() {
    classes(() => [
      // Armil's Menu item; the destructive one is in danger.
      "ar-menu__item group/dropdown-menu-item relative cursor-default select-none data-inset:ps-8 data-disabled:pointer-events-none data-disabled:opacity-45 [&_ng-icon:not([class*='text-'])]:text-[length:--spacing(4)] [&_ng-icon]:pointer-events-none [&_ng-icon]:shrink-0",
      this.variant() === 'destructive' && 'ar-menu__item--danger',
    ]);
  }
}

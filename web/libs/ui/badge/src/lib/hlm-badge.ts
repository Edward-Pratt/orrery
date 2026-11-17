import { Directive, input } from '@angular/core';
import { classes } from '@spartan-ng/helm/utils';
import { type VariantProps, cva } from 'class-variance-authority';

// Armil's Tag: plain by default, outlined in the accent for the one tag that matters, danger on its wash.
const badgeVariants = cva('ar-tag w-fit shrink-0 overflow-hidden [&>ng-icon]:pointer-events-none [&>ng-icon]:text-[length:--spacing(3)]', {
  variants: {
    variant: {
      default: 'ar-tag--accent',
      secondary: '',
      destructive: 'ar-tag--danger',
      outline: '',
      ghost: '',
      link: '',
    },
  },
  defaultVariants: {
    variant: 'default',
  },
});

export type BadgeVariants = VariantProps<typeof badgeVariants>;

@Directive({
  selector: '[hlmBadge],hlm-badge',
  host: {
    'data-slot': 'badge',
    '[attr.data-variant]': 'variant()',
  },
})
export class HlmBadge {
  public readonly variant = input<BadgeVariants['variant']>('default');

  constructor() {
    classes(() => badgeVariants({ variant: this.variant() }));
  }
}

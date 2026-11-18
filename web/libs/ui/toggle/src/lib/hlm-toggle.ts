import { Directive, input } from '@angular/core';
import { BrnToggle } from '@spartan-ng/brain/toggle';
import { classes } from '@spartan-ng/helm/utils';
import { cva, type VariantProps } from 'class-variance-authority';

// The look is Armil's Segmented (`ar-seg` on the group: the pressed item is verdigris-wash); a toggle alone keeps
// only its layout and disabled state.
export const toggleVariants = cva(
  "group/toggle inline-flex items-center justify-center gap-1 whitespace-nowrap disabled:pointer-events-none disabled:opacity-45 [&_ng-icon:not([class*='text-'])]:text-[length:--spacing(4)] [&_ng-icon]:pointer-events-none [&_ng-icon]:shrink-0",
  {
    variants: {
      variant: {
        default: '',
        outline: '',
      },
      size: {
        default: '',
        sm: '',
        lg: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);
export type ToggleVariants = VariantProps<typeof toggleVariants>;

@Directive({
  selector: 'button[hlmToggle]',
  hostDirectives: [
    {
      directive: BrnToggle,
      inputs: ['id', 'value', 'disabled', 'state', 'aria-label', 'type'],
      outputs: ['stateChange'],
    },
  ],
  host: {
    'data-slot': 'toggle',
  },
})
export class HlmToggle {
  public readonly variant = input<ToggleVariants['variant']>('default');
  public readonly size = input<ToggleVariants['size']>('default');
  constructor() {
    classes(() =>
      toggleVariants({
        variant: this.variant(),
        size: this.size(),
      }),
    );
  }
}

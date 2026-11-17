import { Directive, input, signal } from '@angular/core';
import { BrnButton } from '@spartan-ng/brain/button';
import { classes } from '@spartan-ng/helm/utils';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ClassValue } from 'clsx';
import { injectBrnButtonConfig } from './hlm-button.token';

// Armil's Button: default is the primary (the accent), outline the quiet button, ghost for Cancel and toolbars,
// destructive outlined in danger (never filled), link an inline link. The focus ring, hover and the 44px height
// below 768px come from the `ar-btn` classes in armil.css.
export const buttonVariants = cva(
  "group/button shrink-0 data-disabled:pointer-events-none data-disabled:opacity-45 [&_ng-icon:not([class*='text-'])]:text-[length:--spacing(4)] [&_ng-icon]:pointer-events-none [&_ng-icon]:shrink-0",
  {
    variants: {
      variant: {
        default: 'ar-btn ar-btn--primary',
        outline: 'ar-btn',
        secondary: 'ar-btn',
        ghost: 'ar-btn ar-btn--ghost',
        destructive: 'ar-btn ar-btn--danger',
        link: 'ar-link inline-flex cursor-pointer items-center gap-1.5',
      },
      size: {
        default: '',
        xs: 'ar-btn--sm',
        sm: 'ar-btn--sm',
        lg: '',
        icon: 'ar-btn--icon',
        'icon-xs': 'ar-btn--icon ar-btn--sm',
        'icon-sm': 'ar-btn--icon ar-btn--sm',
        'icon-lg': 'ar-btn--icon',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export type ButtonVariants = VariantProps<typeof buttonVariants>;

@Directive({
  selector: 'button[hlmBtn], a[hlmBtn]',
  exportAs: 'hlmBtn',
  hostDirectives: [{ directive: BrnButton, inputs: ['disabled'] }],
  host: { 'data-slot': 'button' },
})
export class HlmButton {
  private readonly _config = injectBrnButtonConfig();

  private readonly _additionalClasses = signal<ClassValue>('');

  public readonly variant = input<ButtonVariants['variant']>(this._config.variant);

  public readonly size = input<ButtonVariants['size']>(this._config.size);

  constructor() {
    classes(() => [
      // a link has no button size
      buttonVariants({ variant: this.variant(), size: this.variant() === 'link' ? null : this.size() }),
      this._additionalClasses(),
    ]);
  }

  setClass(classes: string): void {
    this._additionalClasses.set(classes);
  }
}

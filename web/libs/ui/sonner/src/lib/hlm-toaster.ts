import type { BooleanInput, NumberInput } from '@angular/cdk/coercion';
import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
  numberAttribute,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { arAlert, arCircleCheck, arInfo, arOctagonX } from '@armil/icons';
import { BrnSonnerImports, type ToasterProps } from '@spartan-ng/brain/sonner';
import { HlmButtonImports } from '@spartan-ng/helm/button';
import { hlm } from '@spartan-ng/helm/utils';
import type { ClassValue } from 'clsx';

@Component({
  selector: 'hlm-toaster',
  imports: [BrnSonnerImports, HlmButtonImports, NgIcon],
  providers: [
    provideIcons({ arCircleCheck, arInfo, arAlert, arOctagonX }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <brn-sonner-toaster
      [class]="_computedClass()"
      [invert]="invert()"
      [theme]="theme()"
      [position]="position()"
      [hotKey]="hotKey()"
      [richColors]="richColors()"
      [expand]="expand()"
      [duration]="duration()"
      [visibleToasts]="visibleToasts()"
      [closeButton]="closeButton()"
      [toastOptions]="_computedToastOptions()"
      [offset]="offset()"
      [style]="userStyle()"
    >
      <ng-template #loadingIcon>
        <span class="ar-spinner"></span>
      </ng-template>
      <ng-template #successIcon>
        <ng-icon name="arCircleCheck" class="overflow-visible! text-base" />
      </ng-template>
      <ng-template #errorIcon>
        <ng-icon name="arOctagonX" class="overflow-visible! text-base" />
      </ng-template>
      <ng-template #infoIcon>
        <ng-icon name="arInfo" class="overflow-visible! text-base" />
      </ng-template>
      <ng-template #warningIcon>
        <ng-icon name="arAlert" class="overflow-visible! text-base" />
      </ng-template>
      <button
        *brnToastAction="let action; let toast = toast"
        [style]="toast.actionButtonStyle"
        hlmBtn
        size="sm"
        (click)="action.onClick($event)"
      >
        {{ action.label }}
      </button>
      <button
        *brnToastCancelAction="let cancel; let toast = toast"
        [style]="toast.cancelButtonStyle"
        hlmBtn
        size="sm"
        variant="ghost"
        (click)="cancel.onClick($event)"
      >
        {{ cancel.label }}
      </button>
    </brn-sonner-toaster>
  `,
})
export class HlmToaster {
  public readonly invert = input<ToasterProps['invert'], BooleanInput>(false, {
    transform: booleanAttribute,
  });
  public readonly theme = input<ToasterProps['theme']>('light');
  // Armil's Notice: one at a time, bottom centre, solid raised with a line-strong edge, no colour by type.
  public readonly position = input<ToasterProps['position']>('bottom-center');
  public readonly hotKey = input<ToasterProps['hotkey']>(['altKey', 'KeyT']);
  public readonly richColors = input<ToasterProps['richColors'], BooleanInput>(false, {
    transform: booleanAttribute,
  });
  public readonly expand = input<ToasterProps['expand'], BooleanInput>(false, {
    transform: booleanAttribute,
  });
  public readonly duration = input<ToasterProps['duration'], NumberInput>(4000, {
    transform: numberAttribute,
  });
  public readonly visibleToasts = input<ToasterProps['visibleToasts'], NumberInput>(1, {
    transform: numberAttribute,
  });
  public readonly closeButton = input<ToasterProps['closeButton'], BooleanInput>(false, {
    transform: booleanAttribute,
  });
  public readonly toastOptions = input<ToasterProps['toastOptions']>({});

  protected readonly _computedToastOptions = computed(() => {
    const options = this.toastOptions();
    return {
      ...options,
      classes: {
        ...options?.classes,
        toast: hlm('ar-t-ui shadow-[var(--shadow-glass)]!', options?.classes?.toast),
        // Armil's Notice: the dismiss button is a small ghost close button at the line's end, not a disc on its corner.
        closeButton: hlm(
          'static! order-last! ms-auto! size-7! shrink-0 transform-none! rounded-md! border-0! bg-[var(--clear)]! text-[var(--ink-soft)]! hover:bg-[var(--raised)]! hover:text-[var(--ink)]!',
          options?.classes?.closeButton,
        ),
      },
    };
  });
  public readonly offset = input<ToasterProps['offset']>(null);
  public readonly userClass = input<ClassValue>('', { alias: 'class' });
  public readonly userStyle = input<Record<string, string>>(
    {
      '--normal-bg': 'var(--raised)',
      '--normal-text': 'var(--ink)',
      '--normal-border': 'var(--line-strong)',
      '--border-radius': 'var(--radius-lg)',
    },
    { alias: 'style' },
  );

  protected readonly _computedClass = computed(() => hlm('toaster group', this.userClass()));
}

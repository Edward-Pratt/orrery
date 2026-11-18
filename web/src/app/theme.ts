// `Theme`: Armil's two themes, dark (the default, whatever the system prefers) and light (Paper), applied as
// `data-theme` on `<html>` and kept under Armil's `armil-theme` key in `localStorage` (blocked storage is fine: the
// choice lasts until the page closes). Another tab's choice is followed through the `storage` event. `index.html`
// applies a stored Paper before the first paint; `ThemeSwitch` (`theme-switch.ts`) is the control.

import { DOCUMENT } from '@angular/common';
import { computed, DestroyRef, effect, inject, Injectable, signal } from '@angular/core';

export type Mode = 'light' | 'dark';
/** Armil's storage key (its ThemeSwitch), shared with every Armil page on the same address. */
export const THEME_KEY = 'armil-theme';

/** Anything but `light` is dark: no stored value, an old one, or one from elsewhere. */
const modeOf = (value: string | null): Mode => (value === 'light' ? 'light' : 'dark');

/** Dark unless this browser chose Paper; applied as `data-theme` on <html>. */
@Injectable({ providedIn: 'root' })
export class Theme {
  readonly #doc = inject(DOCUMENT);
  readonly mode = signal<Mode>(this.#stored());
  readonly dark = computed(() => this.mode() === 'dark');

  constructor() {
    effect(() => this.#doc.documentElement.setAttribute('data-theme', this.mode()));
    const view = this.#doc.defaultView;
    const follow = (e: StorageEvent) => e.key === THEME_KEY && this.mode.set(modeOf(e.newValue));
    view?.addEventListener('storage', follow);
    inject(DestroyRef).onDestroy(() => view?.removeEventListener('storage', follow));
  }

  set(mode: Mode): void {
    this.mode.set(mode);
    try {
      localStorage.setItem(THEME_KEY, mode);
    } catch {
      // storage blocked: the choice lasts until the page closes
    }
  }

  /** Paper from dark, dark from Paper. */
  toggle(): void {
    this.set(this.dark() ? 'light' : 'dark');
  }

  #stored(): Mode {
    try {
      return modeOf(localStorage.getItem(THEME_KEY));
    } catch {
      return 'dark';
    }
  }
}

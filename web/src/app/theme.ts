import { DOCUMENT } from '@angular/common';
import { effect, inject, Injectable, signal } from '@angular/core';

export type Mode = 'light' | 'system' | 'dark';
export const MODES: Mode[] = ['light', 'system', 'dark'];
const KEY = 'theme';

/** Light, system (the default) or dark, remembered per browser; applied as the `dark` class on <html>. */
@Injectable({ providedIn: 'root' })
export class Theme {
  readonly #doc = inject(DOCUMENT);
  readonly mode = signal<Mode>(this.#stored());

  constructor() {
    const dark = this.#doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
    const systemDark = signal(dark?.matches ?? false);
    dark?.addEventListener('change', (e) => systemDark.set(e.matches));
    effect(() => this.#doc.documentElement.classList.toggle('dark', this.mode() === 'dark' || (this.mode() === 'system' && systemDark())));
  }

  set(mode: Mode): void {
    this.mode.set(mode);
    try {
      localStorage.setItem(KEY, mode);
    } catch {
      // storage blocked: the choice lasts until the page closes
    }
  }

  #stored(): Mode {
    try {
      const v = localStorage.getItem(KEY);
      return MODES.includes(v as Mode) ? (v as Mode) : 'system';
    } catch {
      return 'system';
    }
  }
}

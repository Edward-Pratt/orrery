// `Theme`: light / system / dark, kept in `localStorage` (blocked storage is fine), applied as Armil's `data-theme`
// (`dark` or `light`, Paper) on `<html>`; dark when the system can't say.

import { DOCUMENT } from '@angular/common';
import { computed, effect, inject, Injectable, signal } from '@angular/core';

export type Mode = 'light' | 'system' | 'dark';
export const MODES: Mode[] = ['light', 'system', 'dark'];
const KEY = 'theme';

/** Light, system (the default) or dark, remembered per browser; applied as `data-theme` on <html>. */
@Injectable({ providedIn: 'root' })
export class Theme {
  readonly #doc = inject(DOCUMENT);
  readonly mode = signal<Mode>(this.#stored());
  readonly #systemDark = signal(true);
  /** Whether the page is dark now: the mode, or for `system` the system's (dark when it can't say). */
  readonly dark = computed(() => this.mode() === 'dark' || (this.mode() === 'system' && this.#systemDark()));

  constructor() {
    const dark = this.#doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)');
    this.#systemDark.set(dark?.matches ?? true);
    dark?.addEventListener('change', (e) => this.#systemDark.set(e.matches));
    effect(() => this.#doc.documentElement.setAttribute('data-theme', this.dark() ? 'dark' : 'light'));
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

/**
 * The Browse view's rules, pure: the sorts it offers, its number formats, the hub's refusal in words (a 404 names the
 * hub release it needs), the game's own mods, and what a mod on the portal is to the update being picked, said on its
 * button. The view itself is `mod-browser.ts`.
 */
import type { HttpErrorResponse } from '@angular/common/http';
import type { PortalSort } from '@hub/api';

/** The mods that come with Factorio itself: the portal doesn't list them, and they are never picked. */
export const GAME_MODS = new Set(['base', 'elevated-rails', 'quality', 'recycler', 'space-age']);
export const SORTS: { id: PortalSort; label: string }[] = [
  { id: 'downloads', label: 'Most downloaded' },
  { id: 'updated', label: 'Recently updated' },
  { id: 'name', label: 'Name' },
];
export const compact = new Intl.NumberFormat(undefined, { notation: 'compact' });
export const whole = new Intl.NumberFormat();
const HUB_RELEASE = 'This hub has no mod browser yet: deploy hub-v2.16.0 or later.';
export const why = (err: HttpErrorResponse) => (err.status === 404 ? HUB_RELEASE : typeof err.error === 'string' && err.error ? err.error : `The hub didn't answer (HTTP ${err.status}).`);

/** What a mod on the portal is to the update being picked, said in words on its button. */
export type Standing = { kind: 'installed' | 'added' | 'required' | 'removed' | 'add'; by?: string };

export const addable = (s: Standing) => s.kind === 'add' || s.kind === 'removed';
export const label = (s: Standing) =>
  ({ add: 'Add', removed: 'Add back', installed: 'Installed', added: 'Added', required: `Required by ${s.by}` })[s.kind];

/** What the mod is to the update, in the order the rows' buttons say it. */
export function standing(name: string, picks: ReadonlySet<string>, installed: ReadonlySet<string>, required: ReadonlyMap<string, string>): Standing {
  const picked = picks.has(name);
  const isInstalled = installed.has(name);
  if (picked && isInstalled) return { kind: 'installed' };
  if (picked) return { kind: 'added' };
  const by = required.get(name);
  if (by !== undefined) return { kind: 'required', by };
  if (isInstalled) return { kind: 'removed' };
  return { kind: 'add' };
}

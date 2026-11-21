// The mod browser's thumbnails for `FactorioCatalog.thumbnail` (`factorio.ts`), pure: `thumbPathOf(text, name)` (the
// path from a mod's short page, `mods.factorio.com/api/mods/<name>`, which must name the mod and match
// `^/assets/[0-9a-f]{40}\.thumb\.png$` (`THUMB_PATH`), else null), `checkPng(body, who)` (the PNG signature, else
// 502), `THUMBS` (`https://assets-mod.factorio.com`, the image read's own pin, not in `PUBLIC_HOSTS`) and the limits:
// at most 10,000 paths kept by name (cleared when full), the 100 last used images by their sha1, at most 4 of these
// portal reads at once. The catalog holds the caches and the slots, and reads the image following no redirect,
// `image/png` only. Hub core.

import { GameRefused } from './factorio-fetch.ts';

/**
 * Where the portal's thumbnails are: the image read's own one-host pin, never a public read's (`PUBLIC_HOSTS` stays
 * the JSON allowlist), and it follows no redirect.
 */
export const THUMBS = 'https://assets-mod.factorio.com';
/** Thumbnails: their paths kept by name (cleared when full), the images by sha1, and the portal reads at once. */
export const THUMB_NAMES = 10_000;
export const THUMB_IMAGES = 100;
export const THUMB_READS = 4;
export const THUMB_PATH = /^\/assets\/([0-9a-f]{40})\.thumb\.png$/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A mod's thumbnail path from its short page's text; null for none (another mod's, not JSON, none or a malformed one). */
export function thumbPathOf(text: string, name: string): string | null {
  let data: Record<string, unknown> | null;
  try {
    data = JSON.parse(text) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || data.name !== name || typeof data.thumbnail !== 'string') return null;
  return THUMB_PATH.test(data.thumbnail) ? data.thumbnail : null;
}

/** A thumbnail's bytes, if they start with the PNG signature; 502 naming `who` otherwise. */
export function checkPng(body: Buffer<ArrayBuffer>, who: string): Buffer<ArrayBuffer> {
  if (body.byteLength < PNG.byteLength || !body.subarray(0, PNG.byteLength).equals(PNG)) throw new GameRefused(502, `${who} isn't a PNG.`);
  return body;
}

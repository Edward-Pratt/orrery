// A mod release's signed download link, for `FactorioCatalog.link` (`factorio.ts`): `signedLink(fetch, account,
// downloadUrl)` (with the account, `mods.factorio.com<download_url>?username&token`, `redirect: 'manual'`: only a 3xx
// to `https://dl-mod.factorio.com/…` whose only query key is `secure`, holding no credential, at most `LIMITS.url`, is
// returned; 409 without the account, 502 otherwise; no error ever holds the request's URL), and `FactorioAccount`. Hub
// core.

import { LIMITS } from '../protocol.ts';
import { failure, GameRefused, PORTAL, TIMEOUT_MS, type PortalFetch } from './factorio-fetch.ts';

/** The owner's factorio.com account (`FACTORIO_USERNAME`, `FACTORIO_TOKEN`): only for mod download links. */
export type FactorioAccount = { username: string; token: string };

/** Where the portal's signed download links point (S11). */
const MOD_CDN = 'dl-mod.factorio.com';

/**
 * A mod release's signed download link, asked right before an update with the owner's account
 * (`mods.factorio.com<download_url>?username&token`, no redirect followed): only a redirect to
 * `https://dl-mod.factorio.com/…` whose only query key is `secure`, and which holds no credential, is passed on.
 * Rejects (409) without the account, (502) for anything else; its errors never hold the request's URL.
 */
export async function signedLink(fetch: PortalFetch, account: FactorioAccount | undefined, downloadUrl: string): Promise<string> {
  if (!account) {
    throw new GameRefused(409, "FACTORIO_USERNAME and FACTORIO_TOKEN aren't set on the hub (/etc/orrery-factorio-account.env), so it can't get the mods' download links.");
  }
  const url = new URL(downloadUrl, PORTAL);
  if (url.origin !== PORTAL || !url.pathname.startsWith('/download/') || url.search) throw new GameRefused(502, 'The mod portal names a download outside it.');
  url.searchParams.set('username', account.username);
  url.searchParams.set('token', account.token);
  let res: Response;
  try {
    res = await fetch(url.href, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new GameRefused(502, `The mod portal didn't give a download link: ${failure(err)}.`);
  }
  await res.body?.cancel().catch(() => {});
  if (res.status < 300 || res.status > 399) {
    const hint = res.status === 401 || res.status === 403 ? ': check FACTORIO_USERNAME and FACTORIO_TOKEN' : '';
    throw new GameRefused(502, `The mod portal answered a download link with HTTP ${res.status}${hint}.`);
  }
  let to: URL;
  try {
    to = new URL(res.headers.get('location') ?? '', PORTAL);
  } catch {
    throw new GameRefused(502, "The mod portal's download link isn't a URL.");
  }
  const keys = [...to.searchParams.keys()];
  const signed = to.protocol === 'https:' && to.hostname === MOD_CDN && !to.port && !to.username && !to.password && keys.length === 1 && keys[0] === 'secure';
  const leaks = [account.token, encodeURIComponent(account.token)].some((t) => to.href.includes(t));
  if (!signed || leaks) throw new GameRefused(502, `The mod portal's download link isn't a signed ${MOD_CDN} one, so it isn't passed on.`);
  if (to.href.length > LIMITS.url) throw new GameRefused(502, `The mod portal's download link is over ${LIMITS.url} characters.`);
  return to.href;
}

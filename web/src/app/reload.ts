import { inject, InjectionToken } from '@angular/core';
import type { NavigationError } from '@angular/router';

/** Opens a URL as a whole new page; a test passes a fake. */
export const RELOAD = new InjectionToken<(url: string) => void>('reload', { factory: () => (url) => location.assign(url) });

/** Chrome's, Firefox's and Safari's words for an `import()` that failed. */
const IMPORT_FAILED = /dynamically imported module|importing a module script failed/i;

/**
 * A page that was left open across a dashboard deploy: `install-web.sh` replaced the build, so its lazy pages' chunks
 * are gone (Caddy answers index.html for them) and every link to one silently does nothing. Loads the link's URL as a
 * whole page instead, which gets the new build. Not on the first navigation: that page is the new build already, so
 * a reload would only fail the same way again.
 */
export function reloadOnStaleBuild(e: NavigationError): void {
  if (e.id > 1 && e.error instanceof TypeError && IMPORT_FAILED.test(e.error.message)) inject(RELOAD)(e.url);
}

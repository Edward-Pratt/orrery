// The stop's poll that pack updates (`pack-job.ts`) and game updates (`game-job.ts`) share: `untilStopped` reads a
// unit (`Services.read`) every `pollMs` until it is inactive or failed, and throws once `stopMs` has passed. It
// resolves early, without reading again, once `over` says the wait no longer matters (the hub closing, the update
// ended), so a closing hub leaves no poll running for the rest of `stopMs`. Hub core.

import { formatDuration } from '../units.ts';
import type { Services } from './services.ts';

export async function untilStopped(
  services: Pick<Services, 'read'>,
  serviceId: string,
  { stopMs, pollMs }: { stopMs: number; pollMs: number },
  over: () => boolean,
): Promise<void> {
  const end = Date.now() + stopMs;
  for (;;) {
    if (over()) return;
    const state = (await services.read(serviceId))?.state;
    if (state === 'inactive' || state === 'failed') return;
    if (Date.now() > end) throw new Error(`The service didn't stop within ${formatDuration(stopMs)}.`);
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

import type { Lifecycle, LiveEvent } from '@hub/api';

/** Events that change a card beyond its TPS: it is fetched again (and a server page's detail). */
const CARD_EVENTS: LiveEvent['type'][] = ['connected', 'started', 'stopped', 'crashed', 'hung', 'recovered', 'offline', 'join', 'leave'] satisfies (Lifecycle | 'join' | 'leave')[];
export const changesCard = (e: LiveEvent) =>
  'serverId' in e &&
  (CARD_EVENTS.includes(e.type) ||
    (e.type === 'notice' &&
      (e.kind.startsWith('restart') || e.kind === 'lag' || e.kind === 'lagRecovered' || e.kind === 'packUpdateStarted' || e.kind === 'packUpdateFinished')));

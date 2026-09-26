/** The HTTP API's types, for the dashboard to import type-only. */
import type { HubEvent } from './servers.ts';

export type { HubEvent, Lifecycle, Notice, Severity } from './servers.ts';

/** The `data` of each `GET /api/events` message (JSON); the message's SSE `id` is its event id. */
export type LiveEvent = HubEvent;

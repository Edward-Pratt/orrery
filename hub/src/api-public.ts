// The HTTP API's types for the reads without a session (`web/web-public.ts`), re-exported by `api.ts`. Imports
// nothing, so it compiles wherever `api.ts` does.

/** `GET /api/environment`, read without a session: which Environment this hub is, for the dashboard's badge. */
export type EnvironmentInfo = { environment: 'production' | 'staging' };

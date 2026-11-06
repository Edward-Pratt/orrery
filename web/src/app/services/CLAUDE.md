# services

The Services page (`services.ts`; titled "Checks", with only standalone checks, when systemd is off): a row per unit
(id, unit, state as `Status`) with its checks as chips ("grafana ✓ 42 ms", "api ✗ timeout"; each replaced by its live
`checked` result), then a "Standalone checks" section for checks no listed service shows; each source is fetched only
with its integration on (server cards with minecraft or agents), services and server cards again on service and card
events. Start (primary) when stopped, Restart (outline) when active, ⋯ with Stop and View logs (a `sheet` on the
right, full screen on a phone: monospace lines and Refresh). A service that runs a server (found through the server
cards) shows "runs Creative →" and the server's own `ServerActions` (`full`) instead, so the two views never disagree.
An unlinked service's Start, Restart and Stop need `services.control` and View logs `services.logs`, both for every
server; without them its row has no actions. `actions.ts`: `ServiceControl` (one start/stop/restart request at a time; Stop and Restart ask through
`Feedback.confirm`; used by the page, `ServerActions` and the attention strip).

# host

The host page: one Host at a time from `GET /api/hosts`, the hub's own first, with a picker (a toggle group) only when
there is more than one; stat tiles (CPU, load, memory, a disk each) from its latest sample, replaced by each live
`sample` event (every host's kept, so switching back is current), with a bar amber/red past a threshold (CPU 80/95%
used, memory 85/95%, a disk under 20/10% free; load has none), skeletons while loading, and before a host's first
sample a line saying when it comes (the hub's own a minute after it starts, an Agent's once it is connected); graphs
of the chosen period (1 h, 24 h, 7 d, 90 d; `GET /api/hosts/:id/samples?hours=`, averaged by the hub past 25 hours,
fetched afresh for another host), each live `sample` of the host shown appended. It needs a hub that serves
`/api/hosts`: release and deploy that hub first. With GitHub on, for a user with `deploys`, `releases.ts`'s Releases
section (`#releases`): a row
each for the hub, the dashboard, every minecraft server's Mod and every Host's Agent (`agent:<host>`, its Deploy
posting the `host`; release 1's `hub-v2.14.0` sends `agent.hosts` empty, so it shows no Agent row) (`release-rows.ts`:
running, latest, "newer available" only when the running one is an older listed release, so never for `dev`; an older
hub's answer with no `agent` part has no Agent rows, the one guard for an older hub's API, so a hub rolled back below
`hub-v2.14.0` can still be rolled forward, or the dashboard back, from here), Deploy (a `<select>` picker, latest
preselected, `(older)` below the running one, then `Feedback.confirm` naming the change, "older release" when going
back), a spinner on the row while its deploy runs (no Deploy anywhere meanwhile; none for the hub while a pack or game
update runs, nor for a Mod or an Agent onto the server it runs on (`packing`; a countdown or a restore there is the
hub's 409), with the reason, refetched on pack notices, which game updates send too), the history with each log in a
`<details>`, and Check now; fetched again on each `deploy` notice from the stream. ponytail: the Host page needs the
host integration, so Releases do too.

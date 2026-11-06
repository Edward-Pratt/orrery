# The App: orrery on Android

Status: designed, not built. Date: 2026-11-05. Based on `main` at `81a05f8` (production: `hub-v2.19.1`,
`web-v0.17.0`, `agent-v1.3.0`; cut and not deployed: `hub-v2.20.0`, `web-v0.18.0`, `agent-v1.4.0`, `web-v0.19.0`).
File and line references are at that commit. The Login section, and what hangs off it, were rewritten on 2026-11-05 to
follow `docs/notes/users.md`: the App logs in with the hub's own Users, which land first, not through Discord.

The owner wants to watch the servers and start and stop things from their phone, and be told when something breaks.
Owner decisions (2026-11-05):

- **A native Android app**, not a web app or a wrapped dashboard. Android only.
- **Push through Firebase Cloud Messaging (FCM).** The owner creates a free Firebase project.
- **Installed as an APK from GitHub releases**: a new part `android/` with its own `android-vX.Y.Z` tags. No Play Store.

Contents: [What the App does](#what-the-app-does), [Stack](#stack), [Login](#login),
[Bearer sessions in the hub](#bearer-sessions-in-the-hub), [Push](#push), [The API types in Kotlin](#the-api-types-in-kotlin),
[A new part: android](#a-new-part-android), [Trust rules](#trust-rules), [Tests to write](#tests-to-write),
[Build order](#build-order), [Release and deploy](#release-and-deploy), [Docs and ADRs](#docs-and-adrs),
[Out of scope](#out-of-scope).

---

## What the App does

Version 1 is a pocket control room. It covers what you'd reach for away from a desk, and nothing that needs a
keyboard:

| Screen | Shows | Actions |
|---|---|---|
| **Login** | the logo, username and password | Log in |
| **Overview** (home) | every server (state, players online, TPS/UPS, a pending restart), then the services, the checks and each Host's CPU, memory and disk; the attention strip's problems at the top | pull to refresh |
| **Server** | state, players online, uptime today, the pending restart, the linked service and its state | Restart (with the countdown, as the dashboard), Cancel restart, Back up now, Start / Stop / Restart the linked service |
| **Services** | each service and its state, its check if linked | Start / Stop / Restart |
| **Settings** | who is logged in, notifications on or off for this phone, the hub's address | Log out |

- Stop and Restart ask first, in a dialog naming the server and how many players are on.
- While a screen is open the App follows the live event stream (`GET /api/events`, `Last-Event-ID` on reconnect),
  exactly as the dashboard does, so states change in place. In the background it holds no connection: push does that.
- A 401 anywhere means logged out (the session ended, or the user was disabled or logged out everywhere): back to Login.
- The launcher icon is the orrery mark (`web/public/favicon.svg`) as an adaptive icon, its vector converted to a
  vector drawable.

## Stack

- Kotlin, Jetpack Compose with Material 3 (dynamic colour off: the App uses the dashboard's teal `--brand` and the
  status colours), one Activity, Navigation Compose.
- OkHttp with `okhttp-sse` for the event stream; kotlinx.serialization for JSON. No Retrofit: the API is a dozen
  calls.
- Firebase Messaging for push (the one Google dependency, chosen by the owner).
- The session token in `EncryptedSharedPreferences` (keys in the Android Keystore).
- Gradle with the Kotlin DSL and a version catalog; `minSdk` 29 (Android 10), `targetSdk` the newest at build time.
- Building needs JDK 21 (the Android Gradle Plugin may not run on this machine's JDK 25; a Gradle toolchain pins 21)
  and the Android SDK command-line tools, neither installed here today. CI installs both itself.

## Login

The App logs in with the same account as the dashboard: a User in the hub (`docs/notes/users.md`), with the same
username and password, the same permissions and the same login limits. What differs is how the session is carried:
the dashboard holds a cookie, the App a bearer token.

1. The Login screen posts `{ username, password }` to `POST /api/app/session` (JSON, over HTTPS; nothing but the hub
   ever sees the password). The hub runs the check `POST /api/login` runs (`hub/src/web/auth.ts`: `Users.login`, the
   per-name-and-address and per-address limits, the one 401 text for every failure, 429 with `Retry-After` while
   locked) and, instead of setting a cookie, answers `{ token }`: a new row in `web_sessions`, stored hashed,
   expiring after `sessionDays`, the same as a cookie session.
2. The App keeps the token in `EncryptedSharedPreferences` (see Stack) and sends it as `Authorization: Bearer
   <token>` on every request. It never keeps the password.
3. A failed login shows the hub's text; a 429 says how long to wait. When the second factor lands (the release after
   Users), the screen gains a code field and the post a `code`.

A lost phone: Log out everywhere, on Account by the user or on the Users page by someone with `users`, ends its
session with every other; disabling the user does too. The App's next request is 401, and it goes back to Login.

## Bearer sessions in the hub

- The session middleware (`hub/src/web/auth.ts`, as `docs/notes/users.md` rewrites it) takes **either** the `session`
  cookie **or** `Authorization: Bearer <token>`. When the header is present, the cookie is ignored, so one request
  can never mix the two.
- The CSRF check exists because a browser sends the cookie on its own. A bearer token is never sent by a browser on
  its own, so a request authenticated **by the header** skips the Origin check. It still must be JSON (one rule
  fewer to special-case), and the upload chunk exception stays as it is.
- `/api/me`, the permissions read on every request (`permit.ts`'s rules apply to the App's requests as they do to
  the dashboard's), expiry and pruning are unchanged: an app session is a web session that arrived another way.
  `POST /api/logout` with the header deletes that session.
- `POST /api/app/session` sits before the session middleware (it is how you get one) and takes only JSON.

## Push

### What is sent

The App gets the problems and their recoveries, chosen by the `severity` every notice already carries
(`hub/src/types.ts`, `Severity`), so a notice kind added later is sorted without touching the App:

- **Problems** (`problem` and `warning`): a server's notices (`lag`, `backupFailed`, `lowDisk`, `restartFailed`, …)
  and the `target` notices (`checkDown`, `serviceFailed`, `memoryHigh`, `diskLow`, `agentLost`, `eventsOff`, a failed
  `deployFinished`, …). Server lifecycle events carry no severity: `crashed`, `hung` and `lost` count as problems.
  A clean `stopped` is not one (the hub can't tell who stopped it, and an admin usually did).
- **Recoveries** (`good`): `checkUp`, `memoryOk`, `diskOk`, `agentBack`, `lagRecovered`, …, and lifecycle
  `recovered`. Each replaces its problem's notification (the same notification tag, per server or target and
  kind pair), so the shade shows the latest word.
- `info` is never pushed (deploy started, a pack update step, settings saved).
- A successful `deployFinished` is `good` with no problem before it: it is pushed on the silent Recoveries channel
  ("web-v0.20.0 deployed"), useful when a deploy started from the dashboard finishes after the owner left it.
- An Agent's `agentLost` and `agentBack` go through the same hold as Discord's `agentAlerts`
  (`agentAlerts`, `hub/src/discord/discord.ts:160`), moved out of `discord/` into a module both use, so a flapping Agent can't
  buzz the phone every minute.

The selection lives in `hub/src/push/select.ts`, tested on its own. The Discord formatting is not reused: push wants
a title ("gtnh crashed") and a one-line body, which `select.ts` writes.

### Devices

- `POST /api/app/devices` `{ fcmToken, name }` registers this phone under the calling session (`DELETE` removes it).
  Only a bearer session may register.
- A new table `app_devices (session_id, fcm_token, name, created)`. **A device lives only as long as its session**:
  every path that ends a session (logout, a disabled or deleted user, a password change and Log out everywhere,
  through the session deletes in `hub/src/users/store.ts` once Users moves them there; expiry through the prune at
  `db.ts:438`) deletes its devices in the same transaction. Otherwise a disabled user's phone would keep getting
  alerts. The hub's SQLite runs without `PRAGMA foreign_keys`, so no `ON DELETE CASCADE` does this: the deletes are
  explicit, with a test for each of the three paths.
- Android 13 and later show nothing without the `POST_NOTIFICATIONS` permission: the App asks for it right after the
  first login, registers the phone only once it is granted, and Settings says "Notifications are blocked" with a
  button to Android's settings when it was refused.
- `hub/src/stats/db.ts` is 42 KB and over the cap: the table and its queries go in their own module, after a pure move
  if `Db` needs opening up for it.

### Sending

- FCM's HTTP v1 API, called with `fetch` from `hub/src/push/fcm.ts`: the hub signs a JWT (RS256, `node:crypto`) with
  the service account's key, trades it at `oauth2.googleapis.com/token` for an access token kept until shortly before
  it expires, and posts one message per device to `fcm.googleapis.com/v1/projects/<project>/messages:send`.
- **No `firebase-admin`.** It would pull in a large dependency tree for two HTTP calls; the hand-rolled sender is
  about 100 lines and fully testable with a fake `fetch`. The tradeoff: Google's API changes are ours to follow.
- Data-only messages with Android priority `high` for problems and `normal` for recoveries; the App builds the
  notification itself, on two channels: **Problems** (sound) and **Recoveries** (silent).
- An answer of `UNREGISTERED` (404) or `INVALID_ARGUMENT` on the token deletes that device. Other failures are logged
  and dropped: no queue, no retry (the next alert is the retry). Sends never block the hub's event loop.
- Off unless switched on: `integrations.web.push` in `config.json` (`{ "projectId": "…" }`), and the key below. With
  the section and no key the hub warns at start and sends nothing; the App's Settings then says "Push is off on the
  hub".

### The service-account key

- A new root-only `/etc/orrery-fcm.env` holding `FCM_SERVICE_ACCOUNT` (the key's JSON, base64), read by
  `orrery-hub.service` alone through `EnvironmentFile=-/etc/orrery-fcm.env`, like the Factorio account file: the
  deploy units load `/etc/orrery.env`, and their `npm ci` must never see it. `test-deploy.sh` checks that no other
  unit names it.
- Staging gets none.
- The App's `google-services.json` (the Firebase project's client config) is not a secret, but the repo is public and
  it names the project: it stays out of git, as the repo secret `GOOGLE_SERVICES_JSON`, written into `android/app/`
  by CI. Locally, copy it there by hand (git-ignored).

## The API types in Kotlin

The dashboard imports the hub's API types; Kotlin can't. The App keeps its own `@Serializable` copies of only the
types it reads (`ServerCard`, `ServiceStatus`, `CheckStatus`, `HostNow`, `Me`, `FeedEvent` for the kinds it shows,
the action answers), in one file per area under `android/app/src/main/java/run/orrery/api/`.

Drift is caught by a contract file: a hub test writes `hub/test/fixtures/api-samples.json`, built from objects
checked with `satisfies` against the real types (one of each card state, service, check, Host, event kind the App
reads), and fails when the file on disk differs. The App's unit tests decode that file with the App's models, set to
reject missing fields and accept unknown ones. A hub change that removes or renames a field the App reads fails the
hub's test first (the sample no longer type-checks), then the App's.

## A new part: android

Like `agent/` and `factorio/`, `android/` is a part with its own versions (ADR 0001):

- `.github/changes.sh` (and its test): `android/**` and `hub/test/fixtures/api-samples.json` run the `android` CI job.
- `ci.yml`'s `android` job: JDK 21, the SDK, `./gradlew testDebugUnitTest lintDebug assembleDebug`.
- `.github/release.sh android <level>`; `release.yml` builds a signed release APK and attaches it as
  `orrery-android-vX.Y.Z.apk`. `versionName` is the tag's version; `versionCode` is
  `major * 10000 + minor * 100 + patch`, from the tag, so every release installs over the last.
- Signing: repo secrets `ANDROID_KEYSTORE` (base64), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
  `ANDROID_KEY_PASSWORD`. **If the keystore is lost, no later APK installs over the old one** (Android refuses a
  different signature): keep a copy offline. Debug builds are signed with the usual debug key.
- `test-release.sh` covers the APK naming and the version code.
- Updating on the phone: install the next APK from the release page (allow "install unknown apps" for the browser
  once). The App shows its version in Settings. Hub-side deploys (Host > Releases) don't cover the App.

## Trust rules

- The App talks only to the hub's HTTP API, like the dashboard (the frontend rule in `CLAUDE.md`); it never talks to
  Discord's API, mods, Agents or systemd.
- An app session is no stronger than a cookie session: same password check and login limits, same permissions on
  every request, same expiry, same audit actor `web:<name> (<id>)`.
- The password crosses the network once, to the hub, over HTTPS; the App keeps only the token, and the token is
  stored hashed in `web_sessions`, as now.
- A push carries only a title and a line; nothing secret goes through Google (no tokens, addresses, passwords or
  logs). Server ids and names, check URLs and Host ids do.

## Tests to write

Hub:

- Login: `POST /api/app/session` with the right password answers a token and sets no cookie; a wrong password, an
  unknown name and a disabled user get the one 401 text; the login limits count its failures with `/api/login`'s;
  it needs JSON and no session.
- Bearer: a valid token authenticates; a bad one is 401; with both header and cookie the header decides; a bearer
  POST without `Origin` passes CSRF, a cookie one still fails; logout with the header ends that session.
- Devices: register and remove; a cookie session can't register; **logout, expiry, a disabled user and Log out
  everywhere delete the devices**.
- Push: `select.ts`'s list (each kind in or out, title and body); the Agent hold; `fcm.ts` with a fake `fetch` (the
  JWT's claims and signature checkable with the key's public half, the access token reused until near expiry, the
  message body, `UNREGISTERED` deleting the device, other errors logged and dropped); no section or no key sends
  nothing.
- The contract sample file.

App (JVM unit tests, no emulator in CI):

- Decoding `api-samples.json`.
- The ViewModels with a fake API: overview loading, an action's confirm → call → error message, 401 → Login, the event
  stream changing a card.
- The login call: the token kept, the password not; 401 and 429 shown.

Manual smokes (only a real phone and real FCM show these): log in, see the servers, stop and start a service, take a
check down and get the notification with the App closed, log out and stop getting them.

## Build order

1. Users shipped (`docs/notes/users.md`): the App's login is its `Users.login` behind another route.
2. Pure move, its own commit: `agentAlerts` out of `hub/src/discord/discord.ts` into a module both Discord and push
   use.
3. Hub: bearer sessions and the app login, with tests.
4. Hub: devices, `select.ts`, `fcm.ts`, the config section and the env file in `orrery-hub.service`, tests.
5. Hub: the contract sample.
6. `android/`: the project, CI job and release wiring first (an empty App that builds and signs), then Login, Overview,
   Server, Services, Settings, push.
7. ADR, docs, ROADMAP.

## Release and deploy

1. Cut the next hub minor after Users, deploy it. By hand on the host: create the
   Firebase project, its service account key into `/etc/orrery-fcm.env` (root, mode 600), `integrations.web.push`
   in `config.json`, the updated `orrery-hub.service`, `systemctl daemon-reload`, restart the hub.
2. Cut `android-v0.1.0` (0.x until the App is finished, like the dashboard), install the APK on the phone, and run
   the manual smokes.
3. An older hub with the App: the token step fails (404); the App says the hub needs updating. The dashboard is
   unaffected throughout.

## Docs and ADRs

- **ADR 0006** (0005 is Users, `docs/notes/users.md`): the App, a native frontend with bearer sessions and FCM push
  (why native, why FCM, why no `firebase-admin`, why the token and not a cookie).
- ADR 0001's list of parts and tags gains `android`.
- `CLAUDE.md` (parts, secrets, verify commands, release order: hub, dashboard, agent, Factorio mod, App),
  `docs/RELEASING.md`, `android/CLAUDE.md` (new), `hub/src/web/CLAUDE.md`, `CONTEXT.md` (**App**: the Android app, a
  frontend like the dashboard; _Avoid_ "mobile dashboard", "client"), `docs/ROADMAP.md`.

## Out of scope

- iPhone, tablets' own layouts, Wear OS, widgets.
- Chat, the console, packs, game updates, uploads, settings, moderation, the audit log: the dashboard keeps those.
- Choosing which alerts reach the phone (one switch per phone for v1).
- A sessions list per user in the dashboard, to log one phone out and keep the rest (v1: Log out everywhere ends
  them all). A good next step.
- Offline caching, the Play Store, auto-update inside the App.

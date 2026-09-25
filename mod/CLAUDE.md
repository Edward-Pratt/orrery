# mod (gtnhdiscord)

Server-side-only Forge 1.7.10 mod, built from the GTNewHorizons ExampleMod1.7.10 template
(RetroFuturaGradle, Gradle 9.3.1). Package `io.github.edwardpratt.gtnhdiscord`, modid `gtnhdiscord`.

```bash
./gradlew spotlessApply build   # spotless is enforced; build also runs the JUnit 5 tests
./gradlew test
```

- Needs a full JDK 25 (`javac`). The jar to deploy is the newest `build/libs/gtnhdiscord-<version>.jar`
  (not `-dev`/`-sources`); version comes from the nearest `mod-v*` tag (`build.gradle.kts`; hub tags are ignored, see docs/adr/0001).
- Don't edit `build.gradle.kts`; project settings go in `gradle.properties` / `dependencies.gradle`.
- Checkstyle rejects wildcard imports.

## Java 8 runtime

`enableModernJavaSyntax = jabel`: modern *syntax* compiles to Java 8 bytecode, but Java 9+ *APIs*
(`List.of`, `String.isBlank`, …) will crash on Java 8 servers. Gson is 2.2.4: use `new JsonParser().parse(...)`
and `JsonArray.add(JsonElement)`.

## Minecraft names

MCP stable-12 mappings. Some methods have no readable name and must be called by SRG name, e.g.
`func_110142_aN()` (combat tracker), `func_151521_b()` (death message), `func_147099_x()` (stats file),
`func_150951_e()` (achievement name). Check signatures in the decompiled sources at
`build/rfg/minecraft-src/java/` (present after the first build) instead of guessing.

## Rules

- `HubClient` must not touch Minecraft classes (keeps it unit-testable; it runs on its own threads).
- Game state is only touched on the server thread: inbound `say`/`cmd` are drained in
  `ServerTickEvent` (phase END), which also emits the heartbeat. Never block the tick on I/O.
- Event buses: `ServerChatEvent`, `LivingDeathEvent`, `AchievementEvent` → `MinecraftForge.EVENT_BUS`;
  `PlayerLoggedIn/Out`, `TickEvent` → `FMLCommonHandler.instance().bus()`. `GameEvents` is registered on both.
- `HubClient.stop(0)` must return immediately (crash path); `stop(2000)` flushes `stopping` on clean shutdown.
- A clean stop is announced from two places: `FMLServerStoppingEvent` (`/stop`) and a JVM shutdown hook
  (SIGTERM — vanilla's hook bypasses the FML event). Both go through `announceStop`.
- `/cmd` output is collected in a `CommandOutput` until replies go quiet (1.5 s) or 8 s pass, because some mods
  (spark) reply from a worker thread after the command returns. `serverStopping` calls `flushPending()` first.
- The outbox holds `JsonObject`s; when a connection ends, `dropNonLifecycle` keeps only `started`/`stopping`.
- After the first result, a `/cmd` keeps collecting for 5 min and sends `cmdLate` batches (spark profiler links).
- **Event-listener classes must be `public`**: FML's event bus generates the caller in another package, so a
  package-private listener throws `IllegalAccessError` when the event first fires.
- BetterQuesting is `compileOnly` (never bundled). Only `QuestEvents` touches its classes, and it's created only when
  `Loader.isModLoaded("betterquesting")`; keep it that way so servers without BetterQuesting still load.
  Quest names resolve server-side via `QuestNames` (BetterQuesting's own translation is client-only).
  `QuestEvents` also catches `LinkageError` (a different BetterQuesting build): FML's bus rethrows `Error`s into the
  tick loop, which would crash the server. It disables itself instead. Use BetterQuesting's `QuestingAPI`, not its
  internal classes. `dependencies.gradle` pins the BetterQuesting version the server runs (3.8.86-GTNH as of GTNH
  2.9); when a GTNH update changes it, bump it there and rebuild (`ls <server>/mods | grep -i betterquesting`).
- `BackupLogWatcher` is a log4j appender on the `Server Utilities` logger (attached in `preInit`); it only enqueues.
- `/discord link|unlink` is `DiscordCommand`; the hub answers with `linkResult`.

## Tests

`HubClientTest` plays the hub over a real `ServerSocket`. `GameEvents`/`GtnhDiscord` can only be verified by
the manual smoke test on a real GTNH server (see the plan's final task).

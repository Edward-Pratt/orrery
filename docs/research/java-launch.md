# Research: launching a server on a chosen Java runtime

For #131 (part of #123, feeds #130). Researched 2026-10-04 against primary sources: real GTNH server zips (read
with HTTP range requests, not secondhand), loader and launcher sources on GitHub, the systemd man pages and the
Fedora SELinux policy source.

## Answer in short

- **Every launcher we looked at runs plain `java` and finds it on `PATH`.** None of them reads `JAVA_HOME`. GTNH's
  scripts have no `$JAVA` either. Two tools have their own variable, a file setting that defaults to `java`.
- So **putting `<runtime>/bin` first on the server's `PATH` picks the runtime for any pack**, without touching the
  pack's files.
- **Without root, the hub can do that through a file that the unit reads at every start.** Either a hub-written
  `EnvironmentFile=` or a hub-owned symlink named in a fixed `PATH`. The unit itself is written once, by root.
- **Editing the start script doesn't last.** A Pack update overwrites it, so a change there only survives as a
  Config edit. It is also tied to one pack's script name and command line.
- **Keep `ExecStart=` on a system binary** (`/bin/bash`, as now). Executing a file under `/home` directly from
  systemd is what SELinux blocks. `java` started by that shell from `<root>/runtimes` should be fine, but that
  needs checking on the host (see Traps).

## 1. What the start scripts run

### GTNH (2.6 to 2.9 and nightlies)

The scripts' source is `DreamAssemblerXXL/server_assets/forge/`
([startserver-java9.sh](https://github.com/GTNewHorizons/DreamAssemblerXXL/blob/master/server_assets/forge/startserver-java9.sh),
[startserver.sh](https://github.com/GTNewHorizons/DreamAssemblerXXL/blob/master/server_assets/forge/startserver.sh),
[java9args.txt](https://github.com/GTNewHorizons/DreamAssemblerXXL/blob/master/server_assets/forge/java9args.txt)).
`gtnh-modpack.json` (`server_java8_exclusions` / `server_java9_exclusions`) picks which pair goes into which zip:

| Zip | Script | Java line |
|---|---|---|
| `…_Server_Java_8.zip` | `startserver.sh` | `java -Xms6G -Xmx6G -XX:+UseStringDeduplication … -jar forge-1.7.10-10.13.4.1614-1.7.10-universal.jar nogui` |
| `…_Server_Java_17-2X.zip`, nightly `server-java17-26` | `startserver-java9.sh` | `java -Xms6G -Xmx6G -Dfml.readTimeout=180 [-Duser.language=en] @java9args.txt -jar lwjgl3ify-forgePatches.jar nogui` |

I read the script out of each of these zips:

- 2.6.1 (Java 17-21), 2.7.4 (Java 17-21) and 2.8.4 (Java 17-25), all from `downloads.gtnewhorizons.com/ServerPacks/`.
- 2.8.4 Java 8.
- 2.9.0-RC-1 (Java 17-26) from `ServerPacks/betas/`.
- The nightly `GTNH-daily-2026-10-04+772-server-java17-26.zip` from `GTNewHorizons/GTNH-Daily-Builds` releases.

What they have in common:

- **They call bare `java`, so it comes from `PATH`.** No `$JAVA`, no `JAVA_HOME`. The commit history of the
  script (2023-02 to 2026-09) has never had either.
- **The java line changes between versions.** 2.9.0-RC-1 and the nightly add `-Duser.language=en` (DAXXL #311,
  2026-09-05) and a comment line. Anything that copies the pack's java line would go stale.
- **Each script is a `while true` loop** that starts java again 12 s after it exits ("Rebooting in: 12…").
  Something to check on the host: with the shipped script, `/stop` and `systemctl stop gtnh` can't end the unit
  (the `ExecStop` waits on `$MAINPID`, which is bash). The host's copy may already be edited.
- **The `.sh` files aren't executable:** mode `0666` in the release zips, `0644` in 2.9 and the nightly. That is
  one more reason to run them as `/bin/bash ./startserver-java9.sh`, as `deploy/gtnh.service` does.
- Server versions 2.6 to 2.8 each come in a Java 8 zip and a Java 17-2X zip. The upper bound of the 17-2X zips is
  `maxJavaVersion` in `downloads.gtnewhorizons.com/versions.json` (21 for 2.6-2.7, 25 for 2.8, 26 for 2.9 betas).
  #130 can use that for matching.

### Other loaders and packs

| Source | What it runs | Ways to choose the java |
|---|---|---|
| Forge 1.17+ installer `run.sh` ([MinecraftForge `server_files/run.sh`](https://github.com/MinecraftForge/MinecraftForge/blob/1.20.x/server_files/run.sh)) | `java -jar <shim> --onlyCheckJava`, then `java @user_jvm_args.txt @libraries/…/unix_args.txt "$@"` | `PATH` only |
| NeoForge installer `run.sh` ([NeoForge `server_files/run.sh`](https://github.com/neoforged/NeoForge/blob/26.3.x/server_files/run.sh)) | `exec java @user_jvm_args.txt @libraries/…/unix_args.txt "$@"` | `PATH` only |
| Fabric installer ([`ServerPostInstallDialog.java`](https://github.com/FabricMC/fabric-installer/blob/master/src/main/java/net/fabricmc/installer/server/ServerPostInstallDialog.java) L65, L223) | writes `start.sh`: `#!/usr/bin/env bash` + `java -Xmx2G -jar fabric-server-launch.jar nogui` | `PATH` only |
| Forge 1.7.10 (GTNH's loader) | no script: you run the universal jar yourself | n/a |
| ServerPackCreator (the scripts in many CurseForge server packs) ([`default_template.sh`](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-api/src/main/resources/de/griefed/resources/server_files/default_template.sh), [`variables.txt`](https://github.com/Griefed/ServerPackCreator/blob/main/serverpackcreator-api/src/main/resources/de/griefed/resources/server_files/variables.txt)) | `"$JAVA" …` | Its own `JAVA` in `variables.txt`, set by `source ./variables.txt`, which wipes out any `JAVA` from the environment. The default is `java`, so `PATH`. If the version doesn't match it may run its own `install_java.sh`. |
| ATLauncher server export ([`server-scripts/LaunchServer.sh`](https://github.com/ATLauncher/ATLauncher/blob/master/src/main/resources/server-scripts/LaunchServer.sh)) | `$JAVAPATH $FINALJAVAARGS -jar <serverjar>` | `JAVAPATH="java"` in the script, so `PATH` |

Neither `JAVA` nor `JAVA_HOME` from the environment is honoured anywhere. `PATH` is honoured everywhere.

## 2. Does a pack update overwrite the start scripts?

Yes. The start script is an ordinary pack file. It isn't in the built-in Kept paths
(`Packs.#builtIn`, `hub/src/packs.ts` ~L944: world, `server.properties`, ops/whitelist/bans, `eula.txt`, logs,
backups and the Mod's jar). So a Pack update replaces it, and then applies Config edits again.
`hub/test/packs.test.ts` tests exactly that case on `startserver.sh` (L505-L665).

So the only edit to a start script that lasts is a Config edit. A Config edit has three problems for this job:

- **It is tied to one pack.** It depends on the script's name (`startserver.sh` vs `startserver-java9.sh` vs
  `run.sh`) and its text.
- **It breaks updates.** It stops a Pack update when it no longer matches.
- **It doesn't switch the runtime by itself.** A change only reaches the disk when the edits are applied again.

The other option is making the script a Kept path. Then the server would miss the pack's own changes to it, like
2.9's `-Duser.language=en`.

## 3. Ways to put the right java in front

What systemd says (primary source:
[systemd.service(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) "Command lines";
[systemd.exec(5)](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html) `EnvironmentFile=`,
`$PATH`):

- **The system manager's fixed `PATH`.** Services get `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin`.
- **How `ExecStart` finds its program.** It must be an absolute path, or a bare name found in that compiled-in
  search path. Keep it absolute (`/bin/bash`), which also keeps it out of the `ExecSearchPath=`/`PATH` question.
- **`EnvironmentFile=` is read "shortly before the process is executed".** So a file the hub rewrites takes effect
  at the next start or restart, with no `daemon-reload`.
- **A `-` prefix makes the file optional:** if it is missing, the variables are simply not set.
- **Values in the file aren't expanded.** `PATH=…:$PATH` doesn't work, so write the whole value.
- **Settings in the file override `Environment=`.**
- **The file is read by the service manager (root).** A file owned by the hub's user works.

| Option | Hub can switch without root? | Works for any pack? | Notes |
|---|---|---|---|
| a. Absolute `<runtime>/bin/java` in `ExecStart` | No: it means editing the unit | No: it skips the pack's script and args | Also executes a file under `/home` straight from systemd, which SELinux blocks (§4) |
| b. `Environment=PATH=<runtime>/bin:…` in the unit | No: the runtime is in the unit | Yes | Fine for a fixed runtime, not for switching |
| c. **`EnvironmentFile=-<hub-owned file>`** holding `PATH=<runtime>/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin` (and `JAVA_HOME=<runtime>` for tools that look) | **Yes**: the hub rewrites the file, and it applies at the next restart | **Yes**: the pack's script and args are untouched | If the file is missing, the server uses the system java, so it is opt-in. Root adds one line to the unit, once (the Install script can write it) |
| d. **Hub-owned symlink** (e.g. `…/<id>/java -> <root>/runtimes/<name>`), with `Environment=PATH=<that link>/bin:/usr/local/sbin:…` fixed in the unit | **Yes**: the hub swaps the link (`rename` is atomic) | **Yes** | Same effect as c. If the link breaks, `PATH` lookup quietly falls back to the system java instead of failing |
| e. Hub-written wrapper script that `exec`s `<runtime>/bin/java <args>` | Yes, if the unit runs `/bin/bash <wrapper>` | **No**: the hub has to know every pack's java line (`@java9args.txt`, `unix_args.txt` …) and keep up as it changes (2.9's `-Duser.language=en`) | It could drop GTNH's `while true` loop, but a Config edit can do that too |

c and d are equivalent, and both are portable: they are plain systemd and plain `PATH`. c is the smaller idea. The
unit names one file, and the hub writes two lines into it. Which runtime a server uses is then just the contents of
that file, so "can this runtime be removed?" (#130) is a lookup in the hub's own state.

## 4. Portability traps

- **SELinux (RHEL/Oracle Linux, the production host).** From the policy source
  ([init.te](https://github.com/fedora-selinux/selinux-policy/blob/main/policy/modules/system/init.te),
  [unconfined.te](https://github.com/fedora-selinux/selinux-policy/blob/main/policy/modules/system/unconfined.te)):
  - systemd (`init_t`) changes domain when it executes system binaries. A shell (`shell_exec_t`) runs as
    `initrc_t`, other system binaries (`bin_t`) as `unconfined_service_t`, and both domains are unconfined.
  - For files under `/home`, `init_t` only gets `userdom_exec_user_bin_files` (`home_bin_t`, i.e. `~/bin`). It is
    never allowed to execute an ordinary `user_home_t` file. That matches the existing comment in
    `deploy/gtnh.service`.
  - So keep `ExecStart=/bin/bash …`. The `java` that bash then starts from `<root>/runtimes` runs inside an
    unconfined domain, so it should be allowed. I could not confirm that here.
  - **Check it on the host** (this is #130's SELinux bullet):
    - Unpack a runtime under `/home/opc/orrery/runtimes`.
    - Point the GTNH unit at it (option c).
    - Restart, then run `ps -eZ | grep java` and `ausearch -m avc -ts recent`.
  - Don't extract runtimes outside `/home` and then `mv` them in. `mv` keeps the old label. Extracting in place
    gives `user_home_t`.
- **AppArmor (Debian/Ubuntu).** It confines a process only when a profile is attached to its path. No stock profile
  covers a bash-run service or a JDK under a home directory, so nothing changes there.
- **`noexec` mounts.** If `<root>` is on a `noexec` filesystem (a hardened `/home`, `/tmp`, some container
  volumes), executing `bin/java` fails with EACCES. Reading the start script still works, so the error only shows
  when the server starts. Systemd's `NoExecPaths=` has the same effect. `findmnt -no OPTIONS --target <root>` shows
  it.
- **musl vs glibc, and architecture.** Adoptium publishes these as different builds:
  - `os=linux` is the glibc build, `os=alpine-linux` the musl one, in the API at
    `api.adoptium.net/v3/assets/latest/<v>/hotspot?os=…&architecture=…`.
  - A musl build on a glibc host, or the wrong architecture, fails to exec with a misleading "No such file or
    directory" (its program interpreter is missing).
  - Choose `os` from the host: glibc unless `/lib/ld-musl-*` exists. Choose `architecture` from `process.arch`.
- **Execute bits.** Adoptium's Linux archives are `.tar.gz`, and `tar` keeps the modes. Extracting another way
  might lose `+x` on `bin/java`.

A cheap check that catches most of these:

- After unpacking, the hub runs `<runtime>/bin/java -version` itself.
- That catches `noexec`, the wrong libc or architecture, and missing `+x`.
- It is only a rough check for SELinux: the hub's own domain (`unconfined_service_t`, via `/usr/bin/node`) is close
  to the server's domain but not the same.

## Recommendation for #130

- **Wiring:** Option c.
  - The unit keeps `ExecStart=/bin/bash ./<pack's script>` and gains
    `EnvironmentFile=-<hub-owned path for this server>`. The Install script writes this for new servers; root adds
    it once to `gtnh.service`, and that one line is how the existing server opts in.
  - The hub writes `PATH=<root>/runtimes/<name>/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin` and
    `JAVA_HOME=<root>/runtimes/<name>` into the file.
  - A switch applies at the next restart.
  - Put the file outside the pack-managed folder, or make it a Kept path, so a Pack update never touches it.
- **No start-script edits and no wrapper script.** Leave the pack's script alone.
- **Download the glibc or musl build to match the host** and run `java -version` before calling a runtime installed.
- **Separately:** check whether the host's `startserver-java9.sh` still has GTNH's `while true` loop. If it does, a
  Config edit should remove it, because with systemd's `Restart=always` the loop makes stopping the unit hang.

# One root per Environment holds everything

Packs v2 adds a pack library, Java runtimes and servers the hub creates itself. These need homes on the host, and so
do the things that already exist: deploys, Extras, uploads, scratch space and backups. Each Environment gets **one
root**, and everything lives under it. The hub finds its root as the directory holding `hub.db` (`dbPath`), so there
is no new config setting. Production's is `/home/opc/orrery`, staging's `/srv/orrery-staging`.

```
<root>/
├── releases/  current            deploys (unchanged)
├── config.json  hub.db  deploy-status.json  deploy.lock
├── library/<sha256>.zip          the pack library; names and versions live in hub.db
├── runtimes/temurin-<version>/   Java runtimes
├── java/<serverId> -> ../runtimes/temurin-<version>   the runtime each server is set to (hub-owned link)
├── extras/<serverId>/<id>        Extras (unchanged)
├── uploads/                      chunked uploads in progress, wiped at start
├── work/                         scratch: Compare's unpack area, runtimes being checked
└── servers/<serverId>/           new servers' folders
    ├── <world>/  backups/  …     the server's own; backups stay inside (a Kept path)
    ├── .orrery-update/           a pack update's unpack area
    └── .pre-update-<time>/       what the last update replaced
```

- **Servers run as the Environment's hub user** (`opc`, `orrery-staging`), as `gtnh` does today. The hub swaps a
  server's files and its Java link itself, with no extra privileges. Root is needed only once per server, for its
  unit, socket and polkit file (`deploy/add-server.sh`).
- **The Java link lives outside the server folder**, so a pack update can't touch it, and the unit's fixed
  `PATH`/`JAVA_HOME` names it, so switching runtime needs no root.
- **The library is stored by sha256**, because pack names and versions are free text and never become paths.
- **"Staging" means only the Environment.** The old scratch names (`<data>/staging/`, `<dir>/.orrery-staging/`)
  become `work/` and `.orrery-update/`. Updates still clean up a leftover `.orrery-staging/`.
- **`/home/opc/GTNH` stays where it is.** Only new servers go under `servers/`.
- **Deleting a server folder deletes its backups.** That's accepted: deleting servers isn't a feature, and keeping
  backups beside the world keeps restores (`restore-backup.sh`) unchanged.
- **Nothing assumes a distro.** The root and the hub user are whatever the Environment has. SELinux labelling
  (`restorecon`) runs only where SELinux is on.

## Considered options

- **FHS split** (`/var/lib/orrery`, `/srv/<server>`, `/var/cache`): rejected. It needs root for every new
  folder and a config setting per path, and each Environment's pieces would be scattered over the host.
- **A server root set in `integrations.minecraft`**: rejected. A second setting that has to agree with `dbPath`, for
  no gain.
- **New servers as their own OS user**: rejected. The hub would need root or ACLs to swap their files, which Packs
  depends on.
- **Library as `library/<pack>/<version>.zip`**: readable on disk, but it turns request text into paths. Rejected,
  following Extras (stored by row id).

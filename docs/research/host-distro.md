# Which Linux distro to host orrery on

Research for #132 (part of #123). Checked 2026-10-04. Package versions come from the distros' own archive indexes,
queried that day (the URLs are under [Sources](#sources), so every row can be re-run). Lifecycle dates come from each
vendor's own page. "Repo" means a file in this repository.

## TL;DR

- **Every candidate runs orrery.** All of them have systemd ≥ 252, a polkit that reads JavaScript `.rules` files
  (≥ 0.106), `unzip`, and amd64 + arm64 builds. Nothing in the hub needs a particular distro. The differences are in
  `deploy/`, which was written for Oracle Linux 9 with SELinux enforcing and the `opc` user.
- **Node 24 is the main friction.** Only the EL family ships it as `/usr/bin/node`: EL9 through the `nodejs:24`
  module. EL10 and Fedora have a `nodejs24` package, but it installs **`/usr/bin/node-24` and `npm-24`**. Plain
  `node`/`npm` come from Fedora's `nodejs24-bin`/`nodejs24-npm-bin`, which EL10 doesn't have. Debian 13 ships Node 20,
  Ubuntu 26.04 ships Node 22. Elsewhere, use NodeSource (`/usr/bin/node`, npm bundled, amd64 + arm64) or the
  official tarball.
- **SELinux (EL, Fedora) vs AppArmor (Debian, Ubuntu).** Most of `deploy/`'s workarounds exist because the
  production root is under `/home` with SELinux enforcing: running the start script through bash, no
  `WorkingDirectory=`, env files in `/etc`, `gtnh-fifo.te`, `restorecon`, `httpd_can_network_connect`. Staging
  already runs from `/srv` on the same host with only `restorecon`. On Debian and Ubuntu, AppArmor leaves a process
  with no profile unconfined, so `node`, `java` and Caddy-to-localhost need none of this.
- **x86-64-v3 floor.** RHEL 10 and Oracle Linux 10 need an x86-64-v3 CPU (AVX2). AlmaLinux 10 also ships an
  `x86_64_v2` build. Debian, Ubuntu and EL9 have no such floor. Check an old personal box with
  `/lib64/ld-linux-x86-64.so.2 --help | grep supported` before choosing an EL10.
- **Recommendation:** **AlmaLinux 10** for continuity. It is the same family as today's Oracle Linux, so `deploy/`'s
  SELinux and `dnf` bits carry over, and support runs to 2035. It runs on v2 CPUs and on arm64. Alternative:
  **Debian 13** gives the plainest host (no SELinux workarounds) with support to 2030, but needs NodeSource and
  Caddy's own apt repo. Either way, the design for #130 should assume no distro (see
  [what the design must not assume](#what-the-design-must-not-assume)).

## Comparison

Versions are the current ones in each release's main/updates repos (x86_64/amd64; arm64 was checked where noted).

| | Debian 13 trixie | Ubuntu 26.04 LTS | Fedora 44 | AlmaLinux 10 / RHEL 10 / OL 10 | AlmaLinux 9 / OL 9 (today: OL9) |
|---|---|---|---|---|---|
| Support ends | 2028-08-09 full, **2030-06-30** LTS | **May 2031** standard, May 2036 ESM (Pro) | **2027-06-02** (Bodhi) | Alma: 2030-05-31 active, **2035-05-31** security. OL10 Premier June 2035 | Alma: 2027-05-31 active, **2032-05-31** security. OL9 Premier June 2032 |
| systemd | 257.13 | 259.5 | 259.5 | 257 | 252 |
| polkit (JS `.rules`) | 126 (duktape) | 127 (duktape) | 127 (duktape) | 125 | 0.117 (mozjs) |
| LSM by default | AppArmor (on since Debian 10) | AppArmor | SELinux enforcing | SELinux enforcing | SELinux enforcing |
| Node ≥ 24 from the distro | no (20.19) | no (22.22) | `nodejs24` 24.18 (+ `-bin` for `/usr/bin/node`) | `nodejs24` 24.21, **only as `node-24`/`npm-24`** | `nodejs:24` module, 24.21, `/usr/bin/node` |
| Java from the distro | 21, 25 | 8, 21, 25 | 25 (21 not in F44's base repo) | 21, 25 | 8, 17, 21, 25 |
| Temurin repo (8/17/21/25) | yes, amd64 + arm64 | yes, amd64 + arm64 | rpm (RHEL-family repo) | yes, x86_64 + aarch64 | yes, x86_64 + aarch64 |
| `unzip` | 6.0 | 6.0 | 6.0 | 6.0 | 6.0 |
| Caddy | 2.6.2 in Debian (old); official apt repo current | 2.6.2 universe; official apt repo | 2.10.2 in Fedora; official COPR | EPEL 10: 2.10.2; official COPR | EPEL 9: 2.6.4; official COPR |
| `gh` | 2.46 (old); GitHub's apt repo | 2.46 universe; GitHub's apt repo | 2.97 | EPEL 10: 2.97; GitHub's rpm repo | EPEL 9: 2.97 |
| Arches | amd64, arm64 (+ armhf, ppc64el, riscv64, s390x) | amd64, arm64 | x86_64, aarch64 | **x86-64-v3** (Alma also v2), aarch64 | x86_64 (v2), aarch64 |

Notes on the table:

- **Ubuntu 24.04 / Debian 12** are older but still supported: Ubuntu 24.04 to May 2029 (standard), Debian 12 LTS to
  2028-06-30. Debian 12 ships polkit 122 and Node 18. Debian 14 (forky, testing) already has Node 24.21 and Caddy 2.11,
  but it isn't released.
- **Fedora** lives about 13 months per release (F43 ends 2026-12-02, F44 2027-06-02, F45 2027-11-24 per Bodhi).
  That means an upgrade every year on a box nobody wants to babysit. Its packages are the newest, but it's a poor fit
  for a host.
- **Rocky Linux** tracks RHEL (10 needs x86-64-v3 like RHEL). Its version page 404'd that day, so it has no dates here.
- **Oracle Linux** is free to use and update without a subscription. OL10 has the same x86-64-v3 floor as RHEL 10.
- **Node:** Node 24 (Krypton) is LTS until 2028-04-30. Node 26 becomes LTS on 2026-10-28 and lasts until 2029-04-30
  (`nodejs/Release` schedule.json). NodeSource has `node_24.x` (24.21.0) and `node_26.x` (26.10.0) for amd64 and
  arm64, as one distro-agnostic `nodistro` repo.
- **Java for GTNH:** server packs come as `Java_8` and `Java_17-26` (see `docs/research/gtnh-github-downloads.md`
  on its branch). Every candidate has a distro Java 21 or 25 for the 17–26 pack. Only Ubuntu and EL9 ship Java 8.
  Temurin (Adoptium's own apt/rpm repos, both arches) covers 8/17/21/25 everywhere.

## polkit

- JavaScript `.rules` files exist since polkit **0.106**, replacing `.pkla` (polkit NEWS). Every candidate is far
  past that. Debian's old `.pkla`-only 0.105 is gone since bookworm (polkitd 122).
- Since polkit **126**, **duktape** is the only JS engine ("mozjs dropped in favor of duktape", NEWS). Duktape is
  **ES5.1**. EL9's 0.117 still uses mozjs.
- `deploy/orrery-hub.rules` is already ES5: `var`, `indexOf`, regex literals, no `const`, arrows or `includes`.
  **Keep it ES5** when #123's root script generates or edits `UNITS`, or the rules will fail to load on Debian 13,
  Ubuntu 26.04 and Fedora.
- The rules directory (`/etc/polkit-1/rules.d/`) and the `org.freedesktop.systemd1.manage-units` action with its
  `unit`/`verb` details are the same on every candidate. They come from systemd, not from the distro.

## SELinux vs AppArmor for Java and server folders

What `deploy/` does today because of SELinux, all from repo files:

| Workaround | Why (repo comment) | Needed on Debian/Ubuntu? |
|---|---|---|
| `ExecStart=/bin/bash ./startserver-java9.sh` (`gtnh.service`) | SELinux blocks executing a file in `/home` | no |
| No `WorkingDirectory=` in `orrery-hub*.service` | `init_t` may not read the `current` symlink (`user_home_t`) | no |
| `EnvironmentFile=/etc/orrery.env`, not in `/home` | SELinux blocks systemd reading files in `/home` | no (still right: root-only secrets) |
| `gtnh-fifo.te` module | `init_t` denied on the FIFO in `/run` (`var_run_t`) | no |
| `restorecon` in `install-web.sh`, staging setup step 9 | new files must get the right label for Caddy | no (`command -v` guards it already) |
| `setsebool -P httpd_can_network_connect 1` (Caddyfile) | Caddy may not connect to local ports | no |
| No tmux (`gtnh.service`) | SELinux doesn't let services start tmux | no, but the FIFO design works everywhere, so keep it |

- **Server folders under `/srv` vs `/home` on EL:** staging already runs from `/srv/orrery-staging` on the SELinux
  host with nothing but `restorecon -R`. Production needed the workarounds above because it lives under `/home/opc`.
  So a fixed per-Environment root outside `/home` (#125's layout) avoids most SELinux friction on EL. A server's
  Java runs as the hub user from a script under that root, through `/bin/bash` as today. Confirm the labels on the
  new host with `ls -Z` / `matchpathcon` and `ausearch -m avc -ts recent`; this research didn't check the exact
  label `/srv` gets.
- **Debian/Ubuntu:** AppArmor is on by default (Debian since 10), but a process without a profile is unconfined
  (Debian wiki). So `node` and `java` started by systemd run unconfined unless a profile for them is installed
  (check with `aa-status` on the new host), and folders anywhere work. The
  `deploy/` files still work there: the bash wrapper and `/etc` env files are harmless, `restorecon` is skipped by
  its `command -v` guard, and `gtnh-fifo.te`/`setsebool` are simply not installed.

## Host assumptions orrery makes today (distro-specific or host-specific)

From `deploy/` and the hub:

1. **User `opc` and root `/home/opc/...`** (OCI's default user): `User=opc` in `gtnh.service`,
   `orrery-hub.service`, `orrery-deploy@.service`, `SocketUser=opc` in `gtnh.socket`, `USER = 'opc'` twice in
   `orrery-hub.rules`, `/home/opc/orrery` and `/home/opc/GTNH` in the units, `deploy-web` unit and
   `restore-backup.sh`'s default `GTNH_DIR`.
2. **SELinux present and enforcing**: everything in the table above, and `checkmodule`/`semodule_package`
   (`checkpolicy`) to build `gtnh-fifo.te`.
3. **`dnf`**: `restore-backup.sh` says `sudo dnf install unzip`.
4. **`node` at `/usr/bin/node`** (both hub units) and **`npm`/`node` on `PATH=/usr/local/bin:/usr/bin:/bin`**
   (deploy units, `deploy-hub.sh` runs `npm ci`, both deploy scripts run `node -e`). This breaks on EL10 and Fedora's
   `nodejs24` (`node-24`/`npm-24`) unless the `-bin` packages or symlinks are added, and with nvm.
5. **`runuser`, `restorecon` in `/usr/sbin`**: `deploy-web.sh` adds it to `PATH` itself. Both live there on every
   candidate (util-linux and policycoreutils), and `restorecon` is optional.
6. **`gh` for root** (`install-web.sh`, `deploy-web.sh`). Debian/Ubuntu's `gh` is old (2.46 vs 2.97 in EPEL/Fedora),
   so use GitHub's own repo there.
7. **Caddy from a package** that runs `caddy.service` with `/etc/caddy/Caddyfile`, serving `/var/www/orrery*`.
   Debian/Ubuntu's 2.6.2 is old. Caddy's own apt repo (Cloudsmith) or COPR is the official route.
8. **Journal access through the per-user journal.** The hub runs `journalctl --unit=<server>` as its own user.
   That works today because `opc` is a regular UID and the server runs as `opc`. With journald's default
   `SplitMode=uid`, a regular user's processes get their own journal files, readable by that user, while **system
   users log to the system journal**, readable only by root and the `systemd-journal`/`adm`/`wheel` groups
   (`journald.conf(5)`, `journalctl(1)`). A `useradd --system` hub user, like staging's `orrery-staging`, can't read
   its servers' logs without joining **`systemd-journal`**. This holds on every distro, so the root setup script
   should add the group.
9. **`/run/gtnh.stdin` FIFO via socket activation**: plain systemd, portable (the SELinux module aside).
10. **`/usr/sbin/nologin`** for the staging user: it exists on every candidate.
11. **Root-owned script copies in `/usr/local/lib/orrery`**: portable.
12. **The hub reads `/proc/meminfo`** (`hub/src/host.ts`) and runs `unzip` without a shell (`hub/src/packs.ts`):
    portable Linux.

## What the design must not assume

For #130 and the root script from #123:

- **No fixed user or home**: take the hub user and the Environment root as parameters, and keep new roots out of
  `/home`.
- **SELinux is optional**: run `restorecon` and `semodule` only when present (`command -v`), as `install-web.sh`
  already does.
- **No package manager in messages or scripts**: say "install unzip", not `dnf install`.
- **Resolve `node`/`npm`**: write `command -v node` into the generated unit rather than hard-coding `/usr/bin/node`,
  or document NodeSource as the one supported source.
- **Journal group**: add the hub user to `systemd-journal` when it is a system user.
- **polkit rules stay ES5.1**.
- **CPU level**: if the owner picks RHEL/OL/Rocky 10, the box needs x86-64-v3.

## Sources

Package indexes, queried 2026-10-04:

- Debian: `https://qa.debian.org/madison.php?package=<pkg>&text=on&s=bookworm,trixie,forky` for `polkitd systemd
  nodejs openjdk-{17,21,25}-jre-headless unzip caddy apparmor gh`
- Ubuntu: `https://people.canonical.com/~ubuntu-archive/madison.cgi?package=<pkg>&text=on&s=noble,noble-updates,resolute,resolute-updates&a=amd64,arm64`
- Fedora: `https://mdapi.fedoraproject.org/<f43|f44|rawhide>/pkg/<pkg>` and `.../f44/files/<nodejs24|nodejs24-bin|nodejs24-npm|nodejs24-npm-bin>`.
  EOLs: `https://bodhi.fedoraproject.org/releases/F44` (`eol`)
- AlmaLinux: `https://repo.almalinux.org/almalinux/{9,10}/{BaseOS,AppStream}/x86_64/os/Packages/` and the AppStream 10
  `repodata/*-filelists.xml.gz` (only `nodejs` (22) provides `/usr/bin/node`; `nodejs24` has `/usr/bin/node-24`,
  `nodejs24-npm` has `npm-24`/`npx-24`)
- EPEL: `https://dl.fedoraproject.org/pub/epel/{9,10}/Everything/x86_64/Packages/{c,g}/`
- NodeSource: `https://deb.nodesource.com/node_{24,26}.x/dists/nodistro/` (`Architectures: amd64 arm64 ...`)
- Temurin: `https://packages.adoptium.net/artifactory/deb/dists/<codename>/main/binary-arm64/Packages`,
  `https://packages.adoptium.net/artifactory/rpm/rhel/{9,10}/aarch64/Packages/`
- GitHub CLI repos: `https://cli.github.com/packages/dists/stable/Release`, `https://cli.github.com/packages/rpm/gh-cli.repo`

Lifecycles and docs:

- Debian 13: https://www.debian.org/releases/trixie/ (full support until 2028-08-09, LTS until 2030-06-30; arches)
- Debian releases: https://wiki.debian.org/DebianReleases (Debian 12 LTS until 2028-06-30)
- Ubuntu: https://ubuntu.com/about/release-cycle
- AlmaLinux: https://wiki.almalinux.org/release-notes/ (dates, `x86_64_v2` in 10)
- RHEL 10 architectures (x86-64-v3): https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/10/html/10.0_release_notes/architectures
- Oracle Linux lifetime support: https://www.oracle.com/a/ocom/docs/elsp-lifetime-069338.pdf (OL9 June 2032, OL10 June 2035, Premier)
- Oracle Linux 10 architectures (x86-64-v3): https://docs.oracle.com/en/operating-systems/oracle-linux/10/relnotes10.0/ol10-AvailableArchitectures.html
  (from a search summary; the page itself wasn't fetched)
- Node release schedule: https://raw.githubusercontent.com/nodejs/Release/main/schedule.json, https://nodejs.org/dist/index.json
- polkit NEWS (0.106 `.rules`; 0.121 duktape; 126 mozjs dropped): https://github.com/polkit-org/polkit/blob/main/NEWS.md
- AppArmor in Debian: https://wiki.debian.org/AppArmor/HowToUse
- Caddy install (official apt repo, COPR): https://caddyserver.com/docs/install
- Journal access: https://man7.org/linux/man-pages/man1/journalctl.1.html, https://man7.org/linux/man-pages/man5/journald.conf.5.html
- Repo: `deploy/*` (units, `orrery-hub.rules`, `gtnh-fifo.te`, `Caddyfile`, scripts), `hub/package.json` (`node >=24`),
  `hub/src/services.ts`, `hub/src/packs.ts`, `hub/src/host.ts`

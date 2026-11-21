// New server, for `Packs` (with GitHub on: `PacksDeps.install`): `startInstall(form)` refuses before anything is
// written (400/404/409: the id `SERVER_ID`, not in config, a Pending server, pack data or
// `<root>/servers/<id>`/`<root>/java/<id>`; the game port 1–65535 and not another server's `server.properties` (25565
// without one) or a Pending server's; no unit (`systemctl show --property=LoadState`, not `not-found`); a Mod build for
// the pack's Minecraft version; the EULA; memory like `6G`; a start script from `startScripts` (`pack-zip.ts`), which
// must set `-Xmx`/`-Xms`; one install at a time, not during a library add), then in the background (`install` target
// events: unpack, write, mod, done or failed): the runtime link first, the zip unpacked into `work/install/` and its
// content root renamed to `<root>/servers/<id>`, `eula.txt`, `server-port`, the Mod's jar and `config/orrery.cfg`
// (Forge's format: `hubHost`, `hubPort`, `serverId`, a 64-hex `token`), the memory edit (`-Xm([sx])\S+`) and, ticked,
// the loop edit (`LOOP` → `$1`) applied, the pack row (`installed`) with the manifest (Kept paths of the server it
// becomes, and the Mod, left out), `.orrery-pending.json` (0600) and the `pending_servers` row; a failure removes all
// of it (`removeInstall`), and so does the next hub after one interrupted (`work/installing.json` names its id).
// `pendingServers()` (each with its `add-server.sh` command and, while `/usr/local/lib/orrery/add-server.sh` is
// missing, the line that installs it; the running install), `discard(id)` (409 once in config). Audited as `server
// install` and `server discard`. Hub core.

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, symlink, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PendingServers, StartScript } from '../api.ts';
import type { ServerSettings } from '../config.ts';
import type { LibraryRow } from '../stats/db.ts';
import type { InstallStep } from '../types.ts';
import { RUNTIME } from './library.ts';
import { installMarker, javaLink, serverDir, settings, sourceEntry, type PacksCtx } from './pack-ctx.ts';
import { exists, keptBy, keptPaths, MOD_JAR, PackRefused, text } from './pack-paths.ts';
import { snapshotOf } from './pack-state.ts';
import { LOOP, MEMORY_FLAG, SCRIPT, startScripts, unpack } from './pack-zip.ts';

/** A new server's id: also its unit's, folder's and polkit file's name (`add-server.sh` checks the same). */
export const SERVER_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** What `add-server.sh` reads: the name, start script and Mod token. */
export const PENDING_FILE = '.orrery-pending.json';
/** The root copy `add-server.sh` runs from, and the checked-in one it is installed from. */
const ROOT_SCRIPT = '/usr/local/lib/orrery/add-server.sh';
const REPO_SCRIPT = fileURLToPath(new URL('../../../deploy/add-server.sh', import.meta.url));

export type Install = { id: string; name: string; by: string; byName: string; started: number; step: string; detail: string; libraryId: number };

export function pendingServers(c: PacksCtx): PendingServers {
  const i = c.install;
  const installScript = existsSync(ROOT_SCRIPT) ? null : `sudo install -D -m 755 -o root -g root -t ${dirname(ROOT_SCRIPT)} ${REPO_SCRIPT}`;
  return {
    pending: c.d.db.pendingServers().map(({ token: _, unit: __, ...p }) => ({
      ...p,
      command: `sudo ${ROOT_SCRIPT} ${p.id} ${c.d.dataDir} --hub-unit ${c.d.install?.hubUnit ?? 'orrery-hub.service'}`,
      installScript,
    })),
    installing: i ? { id: i.id, name: i.name, by: i.byName, started: i.started, step: i.step, detail: i.detail } : null,
  };
}

export async function startInstall(c: PacksCtx, body: Record<string, unknown>, by: string, byName: string): Promise<string> {
  const cfg = c.d.install;
  if (!cfg) throw new PackRefused(404, 'New server needs the GitHub integration.');
  const id = typeof body.id === 'string' ? body.id : '';
  if (!SERVER_ID.test(id)) throw new PackRefused(400, 'The id must be a lowercase letter, then up to 31 lowercase letters, digits or dashes.');
  const name = text(body.name, 'a name', true);
  const port = body.gamePort;
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw new PackRefused(400, 'The game port must be 1–65535.');
  const gamePort = port as number;
  if (typeof body.memory !== 'string' || !/^[1-9]\d{0,5}[MG]$/.test(body.memory)) throw new PackRefused(400, 'Memory is a size like 6G or 512M.');
  const memory = body.memory;
  if (body.eula !== true) throw new PackRefused(400, 'Accept the Minecraft EULA to install a server.');
  if (typeof body.startScript !== 'string' || !SCRIPT.test(body.startScript)) throw new PackRefused(400, 'Pick a start script from the pack.');
  const startScript = body.startScript;
  const removeLoop = body.removeLoop === true;
  const runtime = body.runtime ?? null;
  if (runtime !== null && (typeof runtime !== 'string' || !RUNTIME.test(runtime) || !c.d.library.runtime(runtime))) {
    throw new PackRefused(404, 'No such runtime in the library.');
  }
  const entry = sourceEntry(c, body);
  if (c.install) throw new PackRefused(409, `${c.install.name} is being installed: one install at a time.`);
  if (c.d.library.busy()) throw new PackRefused(409, 'A library add is running: install once it is done.');
  const install: Install = { id, name, by, byName, started: Date.now(), step: 'unpack', detail: 'Checking', libraryId: entry.id };
  c.install = install; // claimed before the first await: two requests can't both pass
  let build: { tag: string; asset: string } | undefined;
  let script: StartScript | undefined;
  try {
    const pending = c.d.db.pendingServers();
    if (settings(c, id)) throw new PackRefused(409, `The id ${id} is a server in config already.`);
    if (pending.some((p) => p.id === id)) throw new PackRefused(409, `The id ${id} is a Pending server already.`);
    if (c.d.db.hasPackData(id)) throw new PackRefused(409, `orrery still has pack data under the id ${id}: pick another id.`);
    if ((await exists(serverDir(c, id))) || (await exists(javaLink(c, id)))) {
      throw new PackRefused(409, `${serverDir(c, id)} or ${javaLink(c, id)} exists already: pick another id.`);
    }
    const taken = pending.find((p) => p.gamePort === gamePort)?.name ?? (await portUser(c, gamePort));
    if (taken) throw new PackRefused(409, `Port ${gamePort} is ${taken}'s game port.`);
    let unit: boolean;
    try {
      unit = await cfg.unitExists(`${id}.service`);
    } catch (err) {
      throw new PackRefused(409, `Couldn't ask systemd about ${id}.service: ${(err as Error).message}`);
    }
    if (unit) throw new PackRefused(409, `systemd has a unit ${id}.service already: pick another id.`);
    build = cfg.mods.modBuild(entry.mc);
    if (!build) throw new PackRefused(409, `No Mod release has a build for Minecraft ${entry.mc}.`);
    script = (await startScripts(c.d.library.zip(entry.id))).find((sc) => sc.name === startScript);
    if (!script) throw new PackRefused(400, `${startScript} isn't a start script in ${entry.name} ${entry.version}.`);
    if (!script.memory) throw new PackRefused(400, `${startScript} sets no -Xmx or -Xms for the memory: pick another start script.`);
  } catch (err) {
    c.install = undefined;
    throw err;
  }
  c.d.hub.audit(by, 'server install', id, `${name}: ${entry.name} ${entry.version}, port ${gamePort}, ${memory}, ${runtime ?? 'system java'}`);
  void runInstall(c, install, entry, build, { gamePort, memory, startScript, removeLoop: removeLoop && script!.loops, runtime });
  return id;
}

export async function discard(c: PacksCtx, id: string, by: string): Promise<void> {
  if (settings(c, id)) throw new PackRefused(409, `${id} is in config: it is a server now, not a Pending one.`);
  const p = c.d.db.pendingServers().find((x) => x.id === id);
  if (!p) throw new PackRefused(404, 'No such Pending server.');
  await removeInstall(c, id);
  c.d.hub.audit(by, 'server discard', id, p.name);
}

async function runInstall(
  c: PacksCtx,
  i: Install,
  entry: LibraryRow,
  build: { tag: string; asset: string },
  f: { gamePort: number; memory: string; startScript: string; removeLoop: boolean; runtime: string | null },
): Promise<void> {
  const dir = serverDir(c, i.id);
  const work = join(c.d.dataDir, 'work', 'install');
  const cfg = c.d.install!;
  try {
    await mkdir(dirname(installMarker(c)), { recursive: true });
    await writeFile(installMarker(c), JSON.stringify({ id: i.id }));
    installStep(c, i, 'unpack', `Unpacking ${entry.name} ${entry.version}`);
    if (f.runtime) {
      // First: a runtime the install will use is in use from now on.
      await mkdir(dirname(javaLink(c, i.id)), { recursive: true });
      await symlink(join(c.d.dataDir, 'runtimes', f.runtime), javaLink(c, i.id));
    }
    const { root, files } = await unpack(c.d.library.zip(entry.id), work);
    await mkdir(dirname(dir), { recursive: true });
    await rename(root, dir);

    installStep(c, i, 'write', 'Writing eula.txt and server.properties');
    await writeFile(join(dir, 'eula.txt'), `# Accepted by ${i.byName} in orrery, ${new Date().toISOString()}\neula=true\n`);
    const props = await readFile(join(dir, 'server.properties'), 'utf8').catch(() => '');
    const port = `server-port=${f.gamePort}`;
    await writeFile(join(dir, 'server.properties'), /^server-port=.*$/m.test(props) ? props.replace(/^server-port=.*$/m, port) : `${props}${props && !props.endsWith('\n') ? '\n' : ''}${port}\n`);

    installStep(c, i, 'mod', `Downloading ${build.asset} (${build.tag})`);
    const jar = await cfg.mods.download(build.tag, build.asset);
    await mkdir(join(dir, 'mods'), { recursive: true });
    await writeFile(join(dir, 'mods', build.asset), jar);
    const token = randomBytes(32).toString('hex');
    await mkdir(join(dir, 'config'), { recursive: true });
    await writeFile(join(dir, 'config', 'orrery.cfg'), forgeConfig({ hubHost: '127.0.0.1', hubPort: cfg.hubPort, serverId: i.id, token }), { mode: 0o600 });

    installStep(c, i, 'write', 'Applying the Config edits');
    const at = Date.now();
    c.d.db.addEdit(i.id, { path: f.startScript, find: MEMORY_FLAG.source, replace: `-Xm$1${f.memory}`, note: 'Memory, set at install', by: i.byName, at });
    if (f.removeLoop) c.d.db.addEdit(i.id, { path: f.startScript, find: LOOP, replace: '$1', note: "No restart loop: systemd restarts the server", by: i.byName, at });
    for (const e of c.d.db.configEdits(i.id)) {
      const file = join(dir, e.path);
      const content = await readFile(file, 'utf8');
      const re = new RegExp(e.find, 'gm');
      if (!re.test(content)) throw new Error(`The Config edit on ${e.path} (${e.find}) matched nothing.`);
      await writeFile(file, content.replace(re, e.replace));
    }
    // The Kept paths of the server it becomes (no `keep` yet; the backup folder `<dir>/backups`, as config defaults it).
    const kept = await keptPaths({ id: i.id, name: i.name, dir, backupDir: join(dir, 'backups'), keep: [] } as unknown as ServerSettings);
    const manifest = files.filter((x) => !keptBy(x, kept) && !MOD_JAR.test(x)).sort();
    const { name, version, source, sha256, id: libraryId } = entry;
    c.d.db.setPack(i.id, { name, version, source, sha256, by: i.byName, at, how: 'installed', snapshot: JSON.stringify(snapshotOf(c, i.id)), libraryId }, manifest, new Set(manifest));

    await writeFile(join(dir, PENDING_FILE), `${JSON.stringify({ name: i.name, startScript: f.startScript, token })}\n`, { mode: 0o600 });
    c.d.db.addPendingServer({ id: i.id, name: i.name, dir, token, unit: `${i.id}.service`, gamePort: f.gamePort, runtime: f.runtime, by: i.byName, at: Date.now() });
    await endInstall(c, i, work);
    installStep(c, i, 'done', '');
    c.d.hub.audit(i.by, 'server install', i.id, `${i.name}: ok`);
  } catch (err) {
    if (c.closed) return;
    const why = (err as Error).message;
    await removeInstall(c, i.id).catch((e: Error) => console.error(`[packs] cleaning up ${i.id}'s install failed:`, e.message));
    await endInstall(c, i, work);
    installStep(c, i, 'failed', why);
    c.d.hub.audit(i.by, 'server install', i.id, `${i.name}: failed: ${why}`);
  }
}

/** Clears the install's scratch and marker, and its slot, before its end is announced (a closing hub leaves the marker for the next). */
async function endInstall(c: PacksCtx, i: Install, work: string): Promise<void> {
  await rm(work, { recursive: true, force: true }).catch(() => {});
  await rm(installMarker(c), { force: true }).catch(() => {});
  if (c.install === i) c.install = undefined;
}

/** Removes everything an install wrote under an id: its folder, Java link, pack data and Pending row. */
export async function removeInstall(c: PacksCtx, id: string): Promise<void> {
  await rm(serverDir(c, id), { recursive: true, force: true });
  await rm(javaLink(c, id), { force: true });
  c.d.db.deletePackData(id);
  c.d.db.deletePendingServer(id);
}

function installStep(c: PacksCtx, i: Install, step: InstallStep['step'], detail: string): void {
  if (c.closed) throw new Error('The hub is closing.');
  i.step = step;
  i.detail = detail;
  c.d.hub.publishTarget({ target: 'install', id: i.id, type: 'install', step, detail, name: i.name, by: i.byName });
}

/** The name of the configured server whose `server.properties` sets this game port (25565 when it sets none). */
async function portUser(c: PacksCtx, port: number): Promise<string | undefined> {
  for (const s of c.d.servers) {
    if (!s.dir) continue;
    const props = await readFile(join(s.dir, 'server.properties'), 'utf8').catch(() => undefined);
    if (props !== undefined && Number(/^server-port=\s*(\d+)/m.exec(props)?.[1] ?? 25565) === port) return s.name;
  }
  return undefined;
}

/** Forge's config format, as the Mod reads `config/orrery.cfg` (`Configuration`, category `general`). */
function forgeConfig(c: { hubHost: string; hubPort: number; serverId: string; token: string }): string {
  return [
    '# Configuration file',
    '',
    'general {',
    '    # Address of the orrery hub',
    `    S:hubHost=${c.hubHost}`,
    '',
    '    # TCP port of the hub [range: 1 ~ 65535, default: 25580]',
    `    I:hubPort=${c.hubPort}`,
    '',
    "    # This server's id in the hub's config.json",
    `    S:serverId=${c.serverId}`,
    '',
    "    # This server's token from the hub's config.json",
    `    S:token=${c.token}`,
    '}',
    '',
  ].join('\n');
}

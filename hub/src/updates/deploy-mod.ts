// A Mod deploy, for `Deploys`: refused (`DeployRefused`, 409) onto a server with no folder, no Mod token or a countdown
// running. The release's build for the Minecraft version of the server's pack (from its library entry; 1.7.10 without
// one) (`orrery-<mc>-<version>.jar` assets, 409 naming the version when there's none; a pre-rename release's one
// `gtnhdiscord-<version>.jar`, 409 onto a server without `config/gtnhdiscord.cfg`) downloaded to `mods/.<jar>.part`,
// renamed into place (every other `gtnhdiscord-*.jar` and `orrery-*.jar` removed; a renamed jar also gets
// `config/gtnhdiscord.cfg` copied to `config/orrery.cfg` when only the old one exists) at once on a stopped server,
// else as the end of a `RestartScheduler` countdown before `stop`, ok on the server's next hello with the new version
// (failed after 10 min; a cancelled countdown removes the part file). Hub core.

import { constants, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeployRow, HubEvent, Release } from '../types.ts';
import { begin, finish, later, type DeployCtx } from './deploy-rows.ts';
import { DeployRefused, MC, MOD_BUILD, MOD_JAR, version } from './release-rules.ts';

export async function deployMod(
  c: DeployCtx,
  release: Release,
  serverId: string,
  serverName: string,
  from: string | null,
  by: string,
  byName: string,
): Promise<number> {
  const { dir } = c.d.servers.find((s) => s.id === serverId) ?? {};
  if (!dir) throw new DeployRefused(409, `${serverName} has no server folder.`);
  if (!c.d.hasMod(serverId)) throw new DeployRefused(409, `${serverName} has no Mod token.`);
  if (c.d.restarts.pending(serverId)) throw new DeployRefused(409, `A countdown is running on ${serverName}: cancel it first.`);
  const v = version(release.tag).join('.');
  const builds = release.assets.map((a) => MOD_BUILD.exec(a)).filter((m) => m !== null);
  let asset: string;
  let jar: string;
  if (builds.length) {
    const mc = c.d.mcOf(serverId) ?? MC;
    const build = builds.find((m) => m[1] === mc);
    if (!build) throw new DeployRefused(409, `${release.tag} has no Mod build for Minecraft ${mc}.`);
    asset = build[0];
    jar = `orrery-${mc}-${v}.jar`;
  } else {
    // From before the rename: one gtnhdiscord jar, which reads its token from gtnhdiscord.cfg.
    const jars = release.assets.filter((a) => a.endsWith('.jar') && !a.endsWith('-dev.jar') && !a.endsWith('-sources.jar'));
    if (jars.length !== 1) throw new DeployRefused(409, `${release.tag} has no single Mod jar.`);
    if (!existsSync(join(dir, 'config', 'gtnhdiscord.cfg'))) {
      throw new DeployRefused(409, `${release.tag} reads config/gtnhdiscord.cfg, which ${serverName} doesn't have.`);
    }
    asset = jars[0]!;
    jar = `gtnhdiscord-${v}.jar`;
  }
  const mods = join(dir, 'mods');
  const part = join(mods, `.${jar}.part`);
  c.starting = true;
  let row: DeployRow;
  try {
    row = begin(c, 'mod', serverId, from, release.tag, by);
    try {
      const bytes = await c.d.github.download(release.tag, asset);
      await mkdir(mods, { recursive: true });
      await writeFile(part, bytes);
    } catch (err) {
      await rm(part, { force: true });
      finish(c, row, 'failed', `download failed: ${(err as Error).message}`);
      throw err;
    }
  } finally {
    c.starting = false;
  }
  // A rename never rewrites the file a running JVM has open; Forge crashes on two copies, so the others go.
  // A renamed jar reads orrery.cfg: the old config is copied over once, and kept for a pre-rename release.
  const swap = async () => {
    if (jar.startsWith('orrery-')) {
      await copyFile(join(dir, 'config', 'gtnhdiscord.cfg'), join(dir, 'config', 'orrery.cfg'), constants.COPYFILE_EXCL).catch((err) => {
        if (!['ENOENT', 'EEXIST'].includes(err.code)) throw err;
      });
    }
    await rename(part, join(mods, jar));
    for (const f of await readdir(mods)) if (MOD_JAR.test(f) && f !== jar) await rm(join(mods, f), { force: true });
  };
  if (!c.d.hub.get(serverId)?.online) {
    try {
      await swap();
    } catch (err) {
      finish(c, row, 'failed', `swap failed: ${(err as Error).message}`);
      throw err;
    }
    finish(c, row, 'ok', 'applied at next start');
    return row.id;
  }

  let swapped = false;
  let timeout: NodeJS.Timeout | undefined;
  const off = () => c.d.hub.off('event', listen);
  const done = (outcome: 'ok' | 'failed', log: string) => {
    off();
    c.listeners.delete(off);
    clearTimeout(timeout);
    if (timeout) c.timers.delete(timeout);
    finish(c, row, outcome, log);
  };
  const listen = (e: HubEvent) => {
    if (e.serverId !== serverId) return;
    if (!swapped && e.type === 'notice' && (e.kind === 'restartCancelled' || e.kind === 'restartCancelledDown')) {
      void rm(part, { force: true });
      done('failed', 'cancelled');
    } else if (swapped && e.type === 'connected' && c.d.hub.modVersion(serverId) === v) {
      done('ok', `${serverName} runs ${release.tag}`);
    }
  };
  c.d.hub.on('event', listen);
  c.listeners.add(off);
  // The server may have gone down, or a countdown started, during the download: close the row, don't leave it running.
  try {
    c.d.restarts.schedule(serverId, c.countdownMinutes, by, byName, {
      fire: async () => {
        try {
          await swap();
        } catch (err) {
          done('failed', `swap failed: ${(err as Error).message}`);
          throw err;
        }
        swapped = true;
        timeout = later(c, () => done('failed', `${serverName} didn't come back with ${release.tag} in time`), c.modTimeoutMs);
        await c.d.hub.runCommand(serverId, 'stop', by); // the linked service, or the countdown restart, brings it back
      },
    });
  } catch (err) {
    await rm(part, { force: true });
    done('failed', `no countdown: ${(err as Error).message}`);
    throw new DeployRefused(409, `${serverName} changed during the download: ${(err as Error).message}`);
  }
  return row.id;
}

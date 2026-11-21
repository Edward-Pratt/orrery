// The packs tests' world, shared by `test/packs/`: packs 2.7.4 and 2.7.5 behind fake URLs (`URL_OLD`, `URL_NEW`), a
// server folder holding 2.7.4 plus its own files (`SERVER_OWN`), `world` (that folder, the backup folder beside it,
// the zips built with the real zip, and a config with Minecraft, web and systemd on), `rawZip` (entries as given,
// for the unsafe ones), and the file helpers `write`, `snapshot` and `sha`. The hub on it: `pack-hub.ts`.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Config, ServerSettings } from '../../src/config.ts';
import type { RunRestore } from '../../src/backups/restore.ts';
import type { HubDeps } from '../../src/start.ts';
import { WEB } from '../web/web-hub.ts';
import { TOKEN } from '../fake-mod.ts';

export const URL_OLD = 'https://packs.example/GTNH_2.7.4.zip';
export const URL_NEW = 'https://packs.example/GTNH_2.7.5.zip';

export const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

/** Every file under a folder, with its sha256: what "byte-for-byte unchanged" compares. */
export function snapshot(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, snapshot(dir, p));
    else out[p] = createHash('sha256').update(readFileSync(join(dir, p))).digest('hex');
  }
  return out;
}

export function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** The 2.7.4 pack as the server runs it, and 2.7.5. */
export const PACK_OLD = {
  'mods/gregtech.jar': 'gt 1',
  'mods/old-only.jar': 'gone in 2.7.5',
  'mods/bq.jar': 'bq 3.4',
  'config/gregtech.cfg': 'pollution=true\nheap=6G\n',
  'config/forge.cfg': 'forge defaults',
  'startserver.sh': 'java -Xmx6G -jar forge.jar\n',
  'server.properties': 'level-name=world\nmotd=pack default\n',
  'World/level.dat': 'the pack must never ship this',
};
export const PACK_NEW = {
  'mods/gregtech.jar': 'gt 2',
  'mods/new-only.jar': 'new in 2.7.5',
  'mods/bq.jar': 'bq 3.5',
  'config/gregtech.cfg': 'pollution=true\nheap=6G\nnew=1\n',
  'config/forge.cfg': 'forge defaults',
  'startserver.sh': 'java -Xmx6G -jar forge.jar\n',
  'server.properties': 'level-name=world\nmotd=pack default\n',
};
/** What the server folder holds besides the pack: its own files, an Extra-to-be, a local change, and the Mod. */
export const SERVER_OWN = {
  'server.properties': 'level-name=World\nmotd=GTNH main\n',
  'World/level.dat': 'the world',
  'World/region/r.0.0.mca': 'chunks',
  'ops.json': '[]',
  'logs/latest.log': 'log',
  'journeymap/data.dat': 'map',
  'config/JourneyMapServer/world.cfg': 'kept by config',
  'mods/journeymap-fairplay.jar': 'a third-party mod',
  'config/custom.cfg': 'our own config',
  'mods/orrery-1.7.10-1.4.0.jar': 'the Mod',
};

export type Setup = {
  server?: Partial<ServerSettings>;
  /** Whether the fake Mod comes back after the nth start of the unit (1 is the first); default: always. */
  comesBack?: (n: number) => boolean;
  restore?: RunRestore;
  github?: HubDeps['github'];
  gateMs?: number;
  /** How long a stop may take (default 15 min). */
  stopMs?: number;
  /** The unit's state when the hub starts (default active). */
  unit?: string;
  uploadIdleMs?: number;
  githubToken?: string;
  /** How long a Compare is held (default an hour). */
  compareMs?: number;
};

/**
 * A temporary world: a server folder holding pack 2.7.4 plus its own files, the backup folder beside it, both packs
 * as zips (built with the real zip) behind fake URLs, and a config with Minecraft, web and systemd on.
 */
export function world(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'hub-packs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'gtnh');
  const backupDir = join(root, 'backups');
  mkdirSync(backupDir);
  write(dir, { ...PACK_OLD, ...SERVER_OWN, 'config/forge.cfg': 'changed on the server' });
  const zips = join(root, 'zips');
  const zip = (name: string, files: Record<string, string>, prefix = '') => {
    const src = join(zips, name.replace(/\.zip$/, ''));
    write(join(src, prefix), files);
    execFileSync('zip', ['-qry', join(zips, name), '.'], { cwd: src });
    return join(zips, name);
  };
  const urls: Record<string, string> = {
    [URL_OLD]: zip('GTNH_2.7.4.zip', PACK_OLD, 'GT_New_Horizons_2.7.4_Server'),
    [URL_NEW]: zip('GTNH_2.7.5.zip', PACK_NEW),
  };
  const gtnh: ServerSettings = {
    id: 'gtnh',
    name: 'GTNH',
    game: 'minecraft',
    dir,
    backupDir,
    backupMinFreeGB: 10,
    lag: { tps: 15, minutes: 2, enabled: true },
    quests: 'batched',
    service: 'gtnh',
    keep: ['config/JourneyMapServer', 'journeymap/'],
  };
  const config: Config = {
    dbPath: join(root, 'data', 'hub.db'),
    servers: [gtnh],
    integrations: {
      minecraft: { listenPort: 0, tokens: { gtnh: TOKEN } },
      web: WEB,
      systemd: [{ id: 'gtnh', unit: 'gtnh.service' }],
    },
  };
  mkdirSync(dirname(config.dbPath));
  return { root, dir, backupDir, zips, zip, urls, config };
}

export type World = ReturnType<typeof world>;

/** A zip with entries python's zipfile writes as given (zip itself strips `..` and leading slashes). */
export function rawZip(w: World, name: string, entries: Record<string, string>, symlink?: string): string {
  const path = join(w.zips, name);
  const script = `import sys, zipfile, json
z = zipfile.ZipFile(sys.argv[1], 'w')
for n, c in json.loads(sys.argv[2]).items(): z.writestr(n, c)
if sys.argv[3]:
    i = zipfile.ZipInfo(sys.argv[3]); i.external_attr = 0o120777 << 16; z.writestr(i, '/etc/passwd')
z.close()`;
  execFileSync('python3', ['-c', script, path, JSON.stringify(entries), symlink ?? '']);
  return path;
}

// Compare and Adopt, for `Packs`: `compare` (from a library entry, `{ library: <id> }`, unzipped into
// `<root>/work/<server>/`, cleared at start; the report: matching, the Mod, files under `mods/`/`config/` not in the
// pack, pack files that differ; held an hour, `compareMs`; refused once the server has a pack) and `adopt` (stores the
// kept files as Extras and records the pack, pointing at its library entry (`packs.library_id`), and the manifest —
// the pack's files plus the report's, so the next update drops what wasn't kept — changing nothing in the folder).
// Audited as `pack compare` and `pack adopt`. Hub core.

import { copyFile, lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompareReport, PackState, ReportFile } from '../api.ts';
import type { LibraryRow } from '../stats/db.ts';
import { extrasDir, server, sourceEntry, work, type PacksCtx } from './pack-ctx.ts';
import { isFile, keptBy, keptPaths, modJars, PackRefused, walk } from './pack-paths.ts';
import { snapshotOf, state } from './pack-state.ts';
import { sha256File, unpack } from './pack-zip.ts';

export type Compared = { report: CompareReport; entry: LibraryRow; manifest: string[]; own: Set<string>; timer: NodeJS.Timeout };

export async function compare(c: PacksCtx, serverId: string, source: unknown, by: string): Promise<CompareReport> {
  const s = server(c, serverId);
  if (c.d.db.pack(serverId)) throw new PackRefused(409, `${s.name} has a pack already.`);
  const entry = sourceEntry(c, source);
  const into = work(c, serverId);
  const kept = await keptPaths(s);
  try {
    const { root, files } = await unpack(c.d.library.zip(entry.id), into);
    const manifest = files.filter((f) => !keptBy(f, kept)).sort();
    const own = new Set(manifest);
    const report: CompareReport = { name: entry.name, version: entry.version, matching: 0, mod: await modJars(s.dir!), notInPack: [], different: [] };
    const size = async (f: string) => (await lstat(join(s.dir!, f))).size;
    for (const f of manifest) {
      if (!(await isFile(join(s.dir!, f)))) continue;
      if ((await sha256File(join(root, f))) === (await sha256File(join(s.dir!, f)))) report.matching++;
      else report.different.push({ path: f, size: await size(f) });
    }
    const inPack = new Set(files);
    for (const top of ['mods', 'config']) {
      for (const f of await walk(s.dir!, top)) {
        if (!inPack.has(f) && !keptBy(f, kept)) report.notInPack.push({ path: f, size: await size(f) });
      }
    }
    report.notInPack.sort((a, b) => a.path.localeCompare(b.path));
    // Files the pack lacks count as the last apply's too: the next update drops them, unless kept as Extras.
    manifest.push(...report.notInPack.map((f) => f.path));
    manifest.sort();
    forget(c, serverId);
    const timer = setTimeout(() => forget(c, serverId), c.o.compareMs);
    timer.unref();
    c.compared.set(serverId, { report, entry, manifest, own, timer });
    c.d.hub.audit(by, 'pack compare', serverId, `${entry.name} ${entry.version}: ${report.matching} files match`);
    return report;
  } finally {
    await rm(into, { recursive: true, force: true });
  }
}

export async function adopt(ctx: PacksCtx, serverId: string, keep: unknown, by: string, byName: string): Promise<PackState> {
  const s = server(ctx, serverId);
  if (ctx.d.db.pack(serverId)) throw new PackRefused(409, `${s.name} has a pack already.`);
  const c = ctx.compared.get(serverId);
  if (!c) throw new PackRefused(409, 'Compare with the server first (a comparison is kept for an hour).');
  if (!Array.isArray(keep) || !keep.every((k) => typeof k === 'string')) throw new PackRefused(400, 'Give the paths to keep.');
  const offered = new Set([...c.report.notInPack, ...c.report.different].map((f: ReportFile) => f.path));
  const bad = (keep as string[]).find((k) => !offered.has(k));
  if (bad !== undefined) throw new PackRefused(400, `${bad} isn't in the report.`);
  if (!ctx.d.library.entry(c.entry.id)) throw new PackRefused(409, `${c.entry.name} ${c.entry.version} is no longer in the library: compare again.`);
  const at = Date.now();
  for (const target of new Set(keep as string[])) {
    const from = join(s.dir!, target);
    const sha256 = await sha256File(from);
    const id = ctx.d.db.addExtra(serverId, { target, sha256, label: '', note: 'kept at adopt', by: byName, at });
    await mkdir(extrasDir(ctx, serverId), { recursive: true });
    await copyFile(from, join(extrasDir(ctx, serverId), String(id)));
  }
  const { id: libraryId, name, version, source, sha256 } = c.entry;
  ctx.d.db.setPack(serverId, { name, version, source, sha256, by: byName, at, how: 'adopted', snapshot: JSON.stringify(snapshotOf(ctx, serverId)), libraryId }, c.manifest, c.own);
  clearTimeout(c.timer);
  ctx.compared.delete(serverId);
  ctx.d.hub.audit(by, 'pack adopt', serverId, `${name} ${version}, keeping ${(keep as string[]).length} files`);
  return state(ctx, serverId);
}

function forget(ctx: PacksCtx, serverId: string): void {
  const c = ctx.compared.get(serverId);
  if (!c) return;
  clearTimeout(c.timer);
  ctx.compared.delete(serverId);
}

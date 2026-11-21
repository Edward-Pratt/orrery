// Extras and Config edits, for `Packs`: Extras (`<data>/extras/<server>/<id>`, stored under their row id from a
// finished upload; removed ones kept struck through until an apply, one never applied goes at once) and Config edits
// (JS regexes, `gm`, in the order added), each with pending changes per file against the last apply's snapshot
// (`pack-state.ts`); an Extra's target or an edit's file is normalised, inside the folder and not a Kept path (the
// Mod's jar among them). Both are refused (409) while an update runs. `previewEdit` counts the lines a Find matches
// in the file on the server now. Audited as `pack extra …` and `pack edit …`. Hub core.

import { readFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { EditPreview, PackState } from '../api.ts';
import type { ServerSettings } from '../config.ts';
import type { EditRow } from '../stats/db.ts';
import { adopted, extrasDir, server, type PacksCtx } from './pack-ctx.ts';
import { inside, isFile, keptBy, keptPaths, MOD_JAR, PackRefused, regex, relPath, text } from './pack-paths.ts';
import { state, type Snapshot } from './pack-state.ts';
import type { Upload } from './uploads.ts';

export async function addExtra(c: PacksCtx, serverId: string, body: Record<string, unknown>, by: string, byName: string): Promise<PackState> {
  const s = adopted(c, serverId);
  const target = await extraTarget(s, body.target);
  const label = text(body.label, 'a label');
  const note = text(body.note, 'a note');
  const rows = c.d.db.extras(serverId);
  if (rows.some((e) => e.target === target && !e.removed)) throw new PackRefused(409, `An Extra is at ${target} already: replace its file instead.`);
  const upload = take(c, body.upload);
  for (const old of rows.filter((e) => e.target === target)) await purge(c, serverId, old.id); // added back before an apply
  const id = c.d.db.addExtra(serverId, { target, sha256: upload.sha256, label, note, by: byName, at: Date.now() });
  await store(c, serverId, id, upload);
  c.d.hub.audit(by, 'pack extra add', serverId, target);
  return state(c, serverId);
}

export async function updateExtra(c: PacksCtx, serverId: string, extraId: number, body: Record<string, unknown>, by: string): Promise<PackState> {
  adopted(c, serverId);
  const e = c.d.db.extras(serverId).find((x) => x.id === extraId);
  if (!e) throw new PackRefused(404, 'No such Extra.');
  if (e.removed) throw new PackRefused(409, `The Extra at ${e.target} is removed.`);
  const label = body.label === undefined ? e.label : text(body.label, 'a label');
  const note = body.note === undefined ? e.note : text(body.note, 'a note');
  const upload = body.upload === undefined ? undefined : take(c, body.upload);
  if (upload) await store(c, serverId, e.id, upload);
  c.d.db.updateExtra(e.id, { sha256: upload?.sha256 ?? e.sha256, label, note, removed: false });
  c.d.hub.audit(by, 'pack extra change', serverId, `${e.target}${upload ? ': new file' : ''}`);
  return state(c, serverId);
}

export async function removeExtra(c: PacksCtx, serverId: string, extraId: number, by: string): Promise<PackState> {
  const pack = c.d.db.pack(serverId);
  adopted(c, serverId);
  const e = c.d.db.extras(serverId).find((x) => x.id === extraId);
  if (!e) throw new PackRefused(404, 'No such Extra.');
  if ((JSON.parse(pack!.snapshot) as Snapshot).extras[e.target]) c.d.db.updateExtra(e.id, { ...e, removed: true });
  else await purge(c, serverId, e.id);
  c.d.hub.audit(by, 'pack extra remove', serverId, e.target);
  return state(c, serverId);
}

export async function addEdit(c: PacksCtx, serverId: string, body: Record<string, unknown>, by: string, byName: string): Promise<PackState> {
  const edit = await editOf(adopted(c, serverId), body);
  c.d.db.addEdit(serverId, { ...edit, by: byName, at: Date.now() });
  c.d.hub.audit(by, 'pack edit add', serverId, `${edit.path}: ${edit.find} → ${edit.replace}`);
  return state(c, serverId);
}

export async function updateEdit(c: PacksCtx, serverId: string, editId: number, body: Record<string, unknown>, by: string): Promise<PackState> {
  const s = adopted(c, serverId);
  if (!c.d.db.configEdits(serverId).some((e) => e.id === editId)) throw new PackRefused(404, 'No such Config edit.');
  const edit = await editOf(s, body);
  c.d.db.updateEdit(editId, { ...edit, failedOn: null });
  c.d.hub.audit(by, 'pack edit change', serverId, `${edit.path}: ${edit.find} → ${edit.replace}`);
  return state(c, serverId);
}

export async function removeEdit(c: PacksCtx, serverId: string, editId: number, by: string): Promise<PackState> {
  adopted(c, serverId);
  const e = c.d.db.configEdits(serverId).find((x) => x.id === editId);
  if (!e) throw new PackRefused(404, 'No such Config edit.');
  c.d.db.deleteEdit(editId);
  c.d.hub.audit(by, 'pack edit remove', serverId, `${e.path}: ${e.find} → ${e.replace}`);
  return state(c, serverId);
}

export async function previewEdit(c: PacksCtx, serverId: string, path: unknown, find: unknown): Promise<EditPreview> {
  const s = server(c, serverId);
  const p = relPath(path, 'a file');
  const re = regex(find);
  const file = join(s.dir!, p);
  if (!(await isFile(file)) || !(await inside(s.dir!, p))) throw new PackRefused(404, `No file ${p} on the server.`);
  const content = await readFile(file, 'utf8');
  const lines = new Set([...content.matchAll(re)].map((m) => content.slice(0, m.index).split('\n').length));
  return { matches: lines.size };
}

/** An Extra's target: normalised, inside the folder, and not a Kept path (the Mod's jar among them). */
async function extraTarget(s: ServerSettings, raw: unknown): Promise<string> {
  const target = relPath(raw, 'a path to put it at');
  if (MOD_JAR.test(target)) throw new PackRefused(400, `${target} is the Mod's jar: deploy the Mod from Host.`);
  const kept = keptBy(target, await keptPaths(s));
  if (kept) throw new PackRefused(400, `${target} is a Kept path (${kept}): an update never writes there.`);
  if (!(await inside(s.dir!, target))) throw new PackRefused(400, `${target} leads outside the server folder.`);
  return target;
}

async function editOf(s: ServerSettings, body: Record<string, unknown>): Promise<Pick<EditRow, 'path' | 'find' | 'replace' | 'note'>> {
  const path = await extraTarget(s, body.path);
  regex(body.find);
  if (typeof body.replace !== 'string') throw new PackRefused(400, 'Give a Replace string.');
  return { path, find: body.find as string, replace: body.replace, note: text(body.note, 'a note') };
}

/** Takes an upload for use: it is gone from the list (its file is the caller's). */
function take(c: PacksCtx, id: unknown): Upload {
  const up = c.d.uploads.take(id);
  if (!up) throw new PackRefused(400, 'Upload the file (again).');
  return up;
}

async function store(c: PacksCtx, serverId: string, id: number, upload: Upload): Promise<void> {
  await mkdir(extrasDir(c, serverId), { recursive: true });
  await rename(upload.path, join(extrasDir(c, serverId), String(id)));
}

export async function purge(c: PacksCtx, serverId: string, id: number): Promise<void> {
  c.d.db.deleteExtra(id);
  await rm(join(extrasDir(c, serverId), String(id)), { force: true });
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { deflateSync } from 'node:zlib';
import { checkSave, compareVersions } from '../src/save-check.ts';
import { Saves, UPLOAD_SPARE, uploadedName } from '../src/saves.ts';
import type { UnitState } from '../src/service.ts';

type Entry = { name: string; data?: Buffer; mode?: number; method?: 0 | 8 };

/** A zip built by hand (stored or deflated entries), as Factorio's saves are: enough for `checkSave`. */
function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const raw = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 0;
    const data = method === 8 ? deflateSync(raw, { level: 1 }).subarray(2, -4) : raw; // raw deflate: no zlib header or Adler
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** `level.dat0` as Factorio writes it: a zlib stream starting with the version's four u16s, then much more. */
function level(version: string): Buffer {
  const head = Buffer.alloc(8);
  version.split('.').forEach((n, i) => head.writeUInt16LE(Number(n), i * 2));
  head.writeUInt16LE(1, 6);
  return deflateSync(Buffer.concat([head, Buffer.alloc(200_000, 7)]));
}

const save = (version = '2.1.24', top = 'w', method: 0 | 8 = 0) =>
  zip([
    { name: `${top}/level-init.dat`, data: Buffer.from('init') },
    { name: `${top}/control.lua`, data: Buffer.from('-- freeplay') },
    { name: `${top}/level.dat0`, data: level(version), method },
  ]);

async function check(t: TestContext, bytes: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'save-check-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'x.zip'), bytes);
  const fh = await open(join(dir, 'x.zip'));
  try {
    return await checkSave(fh, bytes.length);
  } finally {
    await fh.close();
  }
}

test('checkSave reads the Factorio version from level.dat0, stored or deflated in the zip', async (t) => {
  assert.deepEqual(await check(t, save()), { ok: true, version: '2.1.24' });
  assert.deepEqual(await check(t, save('2.0.66', 'world', 8)), { ok: true, version: '2.0.66' });
});

test('checkSave refuses what is no Factorio save: not a zip, an unsafe name, two folders, a root file, a link, no level.dat0', async (t) => {
  const reason = async (bytes: Buffer) => {
    const r = await check(t, bytes);
    assert.equal(r.ok, false);
    return (r as { reason: string }).reason;
  };
  assert.match(await reason(Buffer.alloc(100, 1)), /not a zip/);
  assert.match(await reason(Buffer.alloc(5)), /too small/);
  assert.match(await reason(zip([{ name: 'w/level.dat0', data: level('2.1.24') }, { name: 'w/../../etc/x' }])), /unsafe name/);
  assert.match(await reason(zip([{ name: '/abs/level.dat0', data: level('2.1.24') }])), /unsafe name/);
  assert.match(await reason(zip([{ name: 'w\\level.dat0', data: level('2.1.24') }])), /unsafe name/);
  assert.match(await reason(zip([{ name: 'w/level.dat0', data: level('2.1.24') }, { name: 'v/control.lua' }])), /more than one folder/);
  assert.match(await reason(zip([{ name: 'level.dat0', data: level('2.1.24') }])), /outside a folder/);
  assert.match(await reason(zip([{ name: 'w/level.dat0', data: level('2.1.24') }, { name: 'w/link', mode: 0o120777 }])), /symbolic link/);
  assert.match(await reason(zip([{ name: 'w/control.lua', data: Buffer.from('x') }])), /no level\.dat0/);
  assert.match(await reason(zip([{ name: 'w/level.dat0', data: Buffer.from('not zlib, not a version') }])), /no Factorio version|does not inflate/);
});

test('compareVersions orders X.Y.Z as numbers', () => {
  assert.equal(compareVersions('2.1.24', '2.1.24'), 0);
  assert.equal(compareVersions('2.1.9', '2.1.24'), -1);
  assert.equal(compareVersions('2.2.0', '2.1.24'), 1);
});

test('uploadedName keeps safe characters of the file name only', () => {
  const ms = Date.UTC(2030, 0, 2, 3, 4, 5);
  assert.equal(uploadedName('My World.zip', ms), 'uploaded-20300102T030405Z-My-World.zip');
  assert.equal(uploadedName('../../etc/passwd', ms), 'uploaded-20300102T030405Z-etc-passwd.zip');
  assert.equal(uploadedName('🚀.zip', ms), 'uploaded-20300102T030405Z-save.zip');
  assert.equal(uploadedName('x'.repeat(300) + '.zip', ms).length, 'uploaded-20300102T030405Z-'.length + 40 + 4);
});

const stopped: UnitState = { unit: 'factorio.service', active: 'inactive', sub: 'dead', since: 0, result: 'success' };

async function folder(t: TestContext) {
  const data = await mkdtemp(join(tmpdir(), 'save-upload-'));
  t.after(() => rm(data, { recursive: true, force: true }));
  const dir = join(data, 'saves');
  await (await import('node:fs/promises')).mkdir(dir);
  const saves = new Saves({ dir, log: join(data, 'factorio-current.log'), run: async () => '', unit: async () => stopped });
  return { dir, saves };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const ID = 'a'.repeat(32);

/** Sends `bytes` in pieces of `piece`, as the hub does. */
async function send(saves: Saves, bytes: Buffer, piece = 64 * 1024) {
  for (let at = 0; at < bytes.length; at += piece) await saves.uploadChunk(ID, at, bytes.subarray(at, at + piece));
}

test('an upload arrives in order and is stored as uploaded-<time>-<name>.zip, 2 s older than the newest save, listed', async (t) => {
  const { dir, saves } = await folder(t);
  await writeFile(join(dir, 'world.zip'), save());
  const newest = Date.now() - 60_000;
  await utimes(join(dir, 'world.zip'), newest / 1000, newest / 1000);
  const bytes = save();
  await saves.uploadStart(ID, 'Base Game.zip', bytes.length, sha(bytes));
  assert.ok((await readdir(dir)).includes(`.upload-${ID}.zip.partial`));
  assert.deepEqual((await saves.list()).saves.map((s) => s.name), ['world.zip'], 'a partial upload is no save');
  await send(saves, bytes);
  const name = await saves.uploadEnd(ID, '2.1.24');
  assert.match(name, /^uploaded-\d{8}T\d{6}Z-Base-Game\.zip$/);
  assert.deepEqual((await readdir(dir)).sort(), [name, 'world.zip'].sort(), 'the partial file is gone');
  assert.equal((await stat(join(dir, name))).mtimeMs, newest - 2000, 'never the newest: a start loads it only through a restore');
  assert.deepEqual((await readdir(dir)).length, 2);
  const listed = (await saves.list()).saves.find((s) => s.name === name)!;
  assert.equal(listed.kind, 'world');
  assert.equal(listed.size, bytes.length);
});

test('a piece out of order, past the size, or with no start is refused; a damaged file or a newer Factorio leaves nothing', async (t) => {
  const { dir, saves } = await folder(t);
  const bytes = save();
  await assert.rejects(saves.uploadChunk(ID, 0, bytes), /no such upload/);
  await saves.uploadStart(ID, 'w.zip', bytes.length, sha(bytes));
  await assert.rejects(saves.uploadStart('b'.repeat(32), 'v.zip', 10, sha(bytes)), /another save is being uploaded/);
  await assert.rejects(saves.uploadChunk(ID, 5, bytes.subarray(0, 10)), /expected the piece at 0/);
  await assert.rejects(saves.uploadChunk(ID, 0, Buffer.concat([bytes, Buffer.alloc(1)])), /more bytes/);
  await send(saves, bytes.subarray(0, 100));
  await assert.rejects(saves.uploadEnd(ID, '2.1.24'), /only 100 of/);
  assert.deepEqual(await readdir(dir), [], 'a short upload leaves nothing');

  await saves.uploadStart(ID, 'w.zip', bytes.length, 'f'.repeat(64));
  await send(saves, bytes);
  await assert.rejects(saves.uploadEnd(ID, '2.1.24'), /damaged/);
  assert.deepEqual(await readdir(dir), []);

  const newer = save('2.2.0');
  await saves.uploadStart(ID, 'w.zip', newer.length, sha(newer));
  await send(saves, newer);
  await assert.rejects(saves.uploadEnd(ID, '2.1.24'), /Factorio 2\.2\.0, newer than this server's 2\.1\.24/);
  assert.deepEqual(await readdir(dir), []);

  const junk = Buffer.alloc(5000, 3);
  await saves.uploadStart(ID, 'w.zip', junk.length, sha(junk));
  await send(saves, junk);
  await assert.rejects(saves.uploadEnd(ID, '2.1.24'), /isn't a Factorio save: it is not a zip/);
  assert.deepEqual(await readdir(dir), []);
});

test('a cancel removes the partial file, and an upload with too little room is refused before a byte', async (t) => {
  const { dir, saves } = await folder(t);
  await saves.uploadStart(ID, 'w.zip', 10, 'f'.repeat(64));
  await saves.uploadChunk(ID, 0, Buffer.alloc(4));
  await saves.uploadCancel(ID);
  assert.deepEqual(await readdir(dir), []);
  await saves.uploadCancel(ID); // nothing to drop is fine
  await assert.rejects(saves.uploadStart(ID, 'huge.zip', Number.MAX_SAFE_INTEGER - UPLOAD_SPARE, 'f'.repeat(64)), /not enough space/);
  assert.deepEqual(await readdir(dir), []);
});

test('a partial upload an exit left behind is removed at start', async (t) => {
  const { dir, saves } = await folder(t);
  await writeFile(join(dir, `.upload-${ID}.zip.partial`), 'half');
  await writeFile(join(dir, 'world.zip'), save());
  saves.start();
  t.after(() => saves.stop());
  for (let i = 0; i < 100 && (await readdir(dir)).length > 1; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(await readdir(dir), ['world.zip']);
});

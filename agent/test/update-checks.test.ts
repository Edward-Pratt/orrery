// Game updates, on the Host `fake-world.ts` builds: a version of `../../x`, a mod name with `..`, an http URL, an
// unlisted host (and a look-alike, a port, a user, no `orrery`) each refused, with no query string in the error, and a
// redirect off the list not followed; a sha256 that differs from factorio.com's list or a sha1 from the portal's fails
// prepare before any download, a download that doesn't match after it; an update refused while a deploy runs (`idle`),
// nothing written; a fake ELF needing glibc 2.41 fails prepare, never a release (and `glibcNeed` on 64-bit LE and
// 32-bit BE files); a current `mod-list.json` that isn't Factorio's list (or is a symlink) failing prepare with
// nothing changed; archive entries escaping the target (`..`, absolute, symlinks out, a chain of them, writes below a
// symlink, hard links out, devices, FIFOs, pax paths) refused, and so is a release with one; a `.tar.xz` through the
// Host's `xz` (skipped without one).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareGlibc, glibcNeed, Refused, unpack, unxz } from '../src/unpack.ts';
import { ALLOWED_HOSTS, checkUpdate } from '../src/update.ts';
import type { Request } from '../src/wire.ts';
import { fakeElf, releaseTar, tar, type Entry } from './fake-release.ts';
import { SUMS, sha256, sha1, tarball, gameUrl, signedGame, world, exists, until } from './fake-world.ts';

test('a version of ../../x, a mod name with .., an http URL and an unlisted host are each refused', async (t) => {
  const w = await world(t);
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  const good = w.request('2.1.25', [['orrery', '0.2.0']]);
  assert.doesNotThrow(() => checkUpdate(good, 'x64'));
  const bad: [string, Request<'update'>, RegExp][] = [
    ['version ../../x', { ...good, factorio: { ...good.factorio, version: '../../x' } }, /"\.\.\/\.\.\/x" is not a Factorio version/],
    ['mod version ../../x', { ...good, mods: [{ ...good.mods[0]!, version: '../../x' }] }, /is not a version of orrery/],
    ['mod name with ..', { ...good, mods: [...good.mods, { ...good.mods[0]!, name: 'flib..x' }] }, /"flib\.\.x" is not a mod name/],
    ['mod name ..', { ...good, mods: [...good.mods, { ...good.mods[0]!, name: '..' }] }, /"\.\." is not a mod name/],
    ['mod name with a slash', { ...good, mods: [...good.mods, { ...good.mods[0]!, name: '../mods' }] }, /is not a mod name/],
    ['http URL', { ...good, factorio: { ...good.factorio, url: 'http://www.factorio.com/get-download/2.1.25/headless/linux64' } }, /is not https/],
    ['unlisted host', { ...good, mods: [{ ...good.mods[0]!, url: 'https://mods.example.com/orrery.zip?token=SECRET' }] }, /is on mods\.example\.com, not a host updates come from/],
    ['look-alike host', { ...good, factorio: { ...good.factorio, url: 'https://dl.factorio.com.example.net/x' } }, /not a host updates come from/],
    ['a port', { ...good, factorio: { ...good.factorio, url: 'https://dl.factorio.com:8443/x' } }, /names a port or a user/],
    ['a user', { ...good, factorio: { ...good.factorio, url: 'https://bob:pw@dl.factorio.com/x' } }, /names a port or a user/],
    ['no orrery', { ...good, mods: [] }, /must include orrery/],
    ['a bad sha256', { ...good, factorio: { ...good.factorio, sha256: 'ab' } }, /sha256 is not 64 hex/],
    ['a mod twice', { ...good, mods: [good.mods[0]!, good.mods[0]!] }, /in the mods twice/],
  ];
  for (const [what, req, why] of bad) {
    await assert.rejects(w.u.update(req), why, what);
    await assert.rejects(w.u.update(req), (err: Error) => !/SECRET|token=/.test(err.message), `${what}: no query string in the error`);
  }
  assert.deepEqual(ALLOWED_HOSTS, ['www.factorio.com', 'dl.factorio.com', 'dl-mod.factorio.com']);
  assert.equal(w.requests.length, 0, 'nothing downloaded');
  assert.equal(w.sent.length, 0);
  assert.equal(await exists(join(w.state, 'update.json')), false, 'nothing recorded');
  assert.throws(() => checkUpdate(good, 'riscv64'), /no Factorio headless build/);

  // A redirect to a host off the list: followed no further, prepare fails.
  w.routes.set(gameUrl('2.1.25'), async () => new Response(null, { status: 302, headers: { location: 'https://cdn.example.com/f.tar.xz?secure=SECRET' } }));
  await w.u.update(good);
  const done = await w.done();
  assert.equal(done.outcome, 'failed in staging');
  const failed = await w.step('prepare', 'failed');
  assert.match(failed.detail, /redirect is on cdn\.example\.com, not a host updates come from/);
  assert.ok(!w.requests.some((u) => u.includes('cdn.example.com')), 'the redirect was not followed');
  assert.ok(!JSON.stringify(w.sent).includes('SECRET'));
});

test("a hash that differs from factorio.com's list, or the mod portal's, fails prepare before any download", async (t) => {
  const w = await world(t);
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  const req = w.request('2.1.25', [['orrery', '0.2.0']]);
  await w.u.update({ ...req, factorio: { ...req.factorio, sha256: 'b'.repeat(64) } });
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.match((await w.step('prepare', 'failed')).detail, /The hub's sha256 for factorio-headless_linux_2\.1\.25\.tar\.xz is not factorio\.com's/);
  assert.deepEqual(w.requests, [SUMS], 'only the sha256 list was read');
  assert.equal(await exists(join(w.install, 'releases/2.1.25')), false);
  assert.deepEqual(w.unit.calls, [], 'the server was left alone');

  w.sent.length = 0;
  w.requests.length = 0;
  await w.u.update({ ...req, id: 'u2', mods: [{ ...req.mods[0]!, sha1: 'c'.repeat(40) }] });
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.match((await w.step('prepare', 'failed')).detail, /The hub's sha1 for orrery 0\.2\.0 is not the mod portal's/);
  assert.ok(!w.requests.some((u) => u.startsWith('https://dl')), 'nothing downloaded');

  // A download that doesn't match the list it was checked against: refused after the download.
  w.sent.length = 0;
  w.routes.set(signedGame('2.1.25'), async () => new Response(new Uint8Array(releaseTar('2.1.25', { extra: [{ name: 'factorio/tampered', data: 'x' }] }))));
  await w.u.update({ ...req, id: 'u3' });
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.match((await w.step('prepare', 'failed')).detail, /doesn't match factorio\.com's sha256/);
  assert.deepEqual(await readdir(join(w.install, '.incoming')), []);
  assert.equal(await exists(join(w.install, 'releases/2.1.25')), false);
});

test('an update is refused while a deploy of the agent runs, before anything is written; not once it ended', async (t) => {
  const w = await world(t);
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  await w.u.start();
  w.deploying = 'orrery-agent-deploy@agent-v1.2.5.service is active';
  await assert.rejects(w.u.update(w.request('2.1.25', [['orrery', '0.2.0']])), /^Error: a deploy is running \(orrery-agent-deploy@agent-v1\.2\.5\.service is active\)$/);
  assert.equal(w.u.busy, false);
  assert.equal(await exists(join(w.state, 'update.json')), false);
  assert.deepEqual([w.requests, w.sent], [[], []]);
  w.deploying = null;
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  await w.step('stop', 'waiting');
  await w.u.cancel();
  assert.equal((await w.done()).outcome, 'cancelled');
});

test('a binary needing a newer glibc than the image fails at prepare', async (t) => {
  const w = await world(t);
  w.offer('2.1.30', releaseTar('2.1.30', { glibc: ['GLIBC_2.17', 'GLIBC_2.41', 'GLIBC_2.38'] }));
  w.mod('orrery', '0.2.0');
  await w.u.update(w.request('2.1.30', [['orrery', '0.2.0']]));
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.match(
    (await w.step('prepare', 'failed')).detail,
    /^Factorio 2\.1\.30 needs glibc 2\.41; the friend must re-run setup with a newer image \(it has glibc 2\.39\)$/,
  );
  assert.equal(await exists(join(w.install, 'releases/2.1.30')), false, 'never a release');
  assert.deepEqual(await readdir(join(w.install, '.incoming')), [], 'nothing left in .incoming');
  assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');

  // The reader itself: the highest GLIBC_X.Y, compared as numbers, in 64-bit LE and 32-bit BE files.
  const elf = join(w.dir, 'elf');
  await writeFile(elf, fakeElf(['GLIBC_2.4', 'GLIBC_2.38', 'GLIBC_2.17', 'GLIBC_PRIVATE', 'GLIBC_2.38.1']));
  assert.equal(await glibcNeed(elf), '2.38');
  await writeFile(elf, fakeElf(['GLIBC_2.9', 'GLIBC_2.10'], { wide: false, le: false }));
  assert.equal(await glibcNeed(elf), '2.10');
  await writeFile(elf, fakeElf([]));
  assert.equal(await glibcNeed(elf), null);
  await writeFile(elf, '#!/bin/sh\necho not an ELF\n'.repeat(4));
  await assert.rejects(glibcNeed(elf), /not a well-formed ELF/);
  assert.ok(compareGlibc('2.4', '2.38') < 0 && compareGlibc('2.41', '2.39') > 0 && compareGlibc('3.0', '2.99') > 0);
});

test("a current mod-list.json that isn't Factorio's list fails prepare: nothing changed", async (t) => {
  const w = await world(t);
  w.offer('2.1.25');
  w.mod('orrery', '0.2.0');
  for (const bad of ['not json', JSON.stringify({ mods: [{ name: 'space-age', enabled: 'no' }] }), JSON.stringify([])]) {
    await writeFile(join(w.data, 'mods/mod-list.json'), bad);
    w.sent.length = 0;
    await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
    const done = await w.done();
    assert.equal(done.outcome, 'failed in staging');
    assert.match((await w.step('prepare', 'failed')).detail, /^mods\/mod-list\.json is not Factorio's mod list/);
    assert.equal(await readlink(join(w.install, 'current')), 'releases/2.1.24');
    assert.equal(await readFile(join(w.data, 'mods/mod-list.json'), 'utf8'), bad, 'left as it was');
    assert.equal(await exists(join(w.data, 'mods.next')), false);
    assert.deepEqual(w.unit.calls, [], 'the server never stopped');
    await until(async () => !(await exists(join(w.state, 'update.json'))), 2000, 'reported');
  }
  // A symlink in its place is not followed.
  await rm(join(w.data, 'mods/mod-list.json'));
  await writeFile(join(w.dir, 'elsewhere.json'), JSON.stringify({ mods: [] }));
  await symlink(join(w.dir, 'elsewhere.json'), join(w.data, 'mods/mod-list.json'));
  w.sent.length = 0;
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.equal((await w.step('prepare', 'failed')).detail, 'mods/mod-list.json is not a regular file');
});

test('an archive entry escaping the target is refused, and so is the release', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'orrery-unpack-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chunks = (b: Buffer) =>
    (async function* () {
      for (let i = 0; i < b.length; i += 700) yield b.subarray(i, i + 700); // headers split across chunks
    })();
  let n = 0;
  const into = async (entries: Entry[]) => {
    const target = join(dir, `t${n++}`);
    await mkdir(target);
    await unpack(chunks(tar([{ name: 'factorio/' }, ...entries])), target);
    return target;
  };
  const refused: [string, Entry[], RegExp][] = [
    ['a .. path', [{ name: 'factorio/../../evil', data: 'x' }], /leads out of the release/],
    ['an absolute path', [{ name: '/etc/evil', data: 'x' }], /is an absolute path/],
    ['a symlink out', [{ name: 'factorio/out', type: '2', link: '../../../etc' }], /the symlink out leads out of the release/],
    ['an absolute symlink', [{ name: 'factorio/abs', type: '2', link: '/etc/passwd' }], /points at an absolute path/],
    ['a write through a symlink', [{ name: 'factorio/sub/', type: '5' }, { name: 'factorio/l', type: '2', link: 'sub' }, { name: 'factorio/l/x', data: 'x' }], /below a symlink of the archive/],
    ['a chain of symlinks out', [{ name: 'factorio/a/', type: '5' }, { name: 'factorio/b', type: '2', link: 'a/c/../..' }, { name: 'factorio/a/c', type: '2', link: '..' }], /leads out of the release, or nowhere/],
    ['a hard link to a path outside', [{ name: 'factorio/h', type: '1', link: '/etc/passwd' }], /is an absolute path/],
    ['a hard link to nothing unpacked', [{ name: 'factorio/h', type: '1', link: 'factorio/missing' }], /not to a file unpacked before it/],
    ['a device', [{ name: 'factorio/dev', type: '3' }], /a kind of entry a release never has/],
    ['a FIFO', [{ name: 'factorio/fifo', type: '6' }], /a kind of entry a release never has/],
    ['a pax path out', [{ name: 'factorio/fine', data: 'x', pax: { path: 'factorio/../../evil' } }], /leads out of the release/],
    ['a file outside the top folder', [{ name: 'top-level-file', data: 'x' }], /is not in the release's folder/],
    ['a file there twice', [{ name: 'factorio/x', data: 'a' }, { name: 'factorio/x', data: 'b' }], /EEXIST/],
  ];
  for (const [what, entries, why] of refused) await assert.rejects(into(entries), why, what);
  assert.deepEqual((await readdir(dir)).filter((f) => !f.startsWith('t')), [], 'nothing written outside the targets');
  const corrupt = tar([{ name: 'factorio/x', data: 'x' }]);
  corrupt[150] ^= 1;
  await assert.rejects(unpack(chunks(corrupt), await mkdtemp(join(dir, 'c'))), Refused);
  await assert.rejects(unpack(chunks(tar([{ name: 'factorio/x', data: 'x'.repeat(2000) }]).subarray(0, 1536)), await mkdtemp(join(dir, 'c'))), /ends in the middle/);

  // What a real tarball has unpacks: long names, pax paths, links inside, modes.
  const long = `factorio/data/base/graphics/${'entity/'.repeat(14)}sprite.png`;
  const ok = await into([
    { name: long, data: 'png' },
    { name: 'factorio/pax-name', data: 'p', pax: { path: 'factorio/data/ünïcode name.txt' } },
    { name: 'factorio/bin/x64/factorio', data: 'elf', mode: 0o755 },
    { name: 'factorio/bin/current', type: '2', link: 'x64' },
    { name: 'factorio/bin/again', type: '1', link: 'factorio/bin/x64/factorio' },
  ]);
  assert.equal(await readFile(join(ok, long.slice('factorio/'.length)), 'utf8'), 'png');
  assert.equal(await readFile(join(ok, 'data/ünïcode name.txt'), 'utf8'), 'p');
  assert.equal((await stat(join(ok, 'bin/x64/factorio'))).mode & 0o777, 0o755);
  assert.equal(await readlink(join(ok, 'bin/current')), 'x64');
  assert.equal(await readFile(join(ok, 'bin/again'), 'utf8'), 'elf');

  // A tarball from factorio.com's list with such an entry: prepare fails, no release, nothing left behind.
  const w = await world(t);
  w.offer('2.1.25', releaseTar('2.1.25', { extra: [{ name: 'factorio/../../../srv/orrery-agent/state/update.json', data: '{}' }] }));
  w.mod('orrery', '0.2.0');
  await w.u.update(w.request('2.1.25', [['orrery', '0.2.0']]));
  assert.equal((await w.done()).outcome, 'failed in staging');
  assert.match((await w.step('prepare', 'failed')).detail, /^Factorio 2\.1\.25's tarball is refused: .* leads out of the release$/);
  assert.equal(await exists(join(w.install, 'releases/2.1.25')), false);
  assert.deepEqual(await readdir(join(w.install, '.incoming')), []);
});

test('a .tar.xz unpacks through xz -dc; what is not xz fails', async (t) => {
  const xz = spawnSync('xz', ['--version']);
  if (xz.error) return t.skip('no xz here (setup installs it on the Host)');
  const dir = await mkdtemp(join(tmpdir(), 'orrery-unxz-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'release.tar.xz');
  const packed = spawnSync('xz', ['-c'], { input: releaseTar('2.1.25') });
  await writeFile(file, packed.stdout);
  await unpack(unxz(file), join(dir, 'release'));
  assert.equal(await glibcNeed(join(dir, 'release/bin/x64/factorio')), '2.38');
  await writeFile(join(dir, 'plain.tar.xz'), releaseTar('2.1.25'));
  await assert.rejects(unpack(unxz(join(dir, 'plain.tar.xz')), join(dir, 'other')), /xz could not unpack it/);
});

// Dependency resolution on a fake portal (`factorio-resolve.ts`, through `FactorioCatalog.resolve`).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FactorioCatalog, GameRefused } from '../../src/updates/factorio.ts';
import { GAME, portal, rel, resolved, sha1 } from './factorio-portal.ts';

test("the catalog offers a mod's releases for the Factorio version's line only, newest first, and picks the newest", async () => {
  const { fetch } = portal({}, {
    flib: { title: 'Factorio Library', releases: [rel('flib', '0.15.0', '2.0'), rel('flib', '0.16.0'), rel('flib', '0.16.2'), rel('flib', '0.17.0', '2.2')] },
  });
  const catalog = new FactorioCatalog(fetch);
  const r = await catalog.resolve('2.1.24', [{ name: 'flib', version: null }], GAME);
  assert.deepEqual(r.unresolved, []);
  assert.deepEqual(
    r.mods.map(({ sha1: _, downloadUrl: __, ...m }) => m),
    [{ name: 'flib', title: 'Factorio Library', version: '0.16.2', releases: ['0.16.2', '0.16.0'], requiredBy: null }],
  );
  assert.equal(r.mods[0]!.sha1, sha1('flib@0.16.2'));
  // A version picked by hand must be one for that line.
  assert.deepEqual(resolved(await catalog.resolve('2.1.24', [{ name: 'flib', version: '0.16.0' }], GAME)), ['flib 0.16.0']);
  const old = await catalog.resolve('2.1.24', [{ name: 'flib', version: '0.15.0' }], GAME);
  assert.deepEqual(old.mods, []);
  assert.deepEqual(old.unresolved, [{ mod: 'flib', dependency: 'flib = 0.15.0', reason: "flib 0.15.0 isn't a release for Factorio 2.1." }]);
  // Factorio 2.2 has only 0.17.0.
  assert.deepEqual(resolved(await catalog.resolve('2.2.0', [{ name: 'flib', version: null }], GAME)), ['flib 0.17.0']);
});

test("required dependencies resolve transitively, at versions meeting every limit and base's against the Factorio version; optional ones stay out", async () => {
  const { fetch } = portal({}, {
    // `~` is required too; `?` and `(?)` are optional; `B < 1.3.0` limits B.
    A: { releases: [rel('A', '1.0.0', '2.1', ['base >= 2.1.0', 'B >= 1.1.0', 'B < 1.3.0', '? C', '(?) D', '~ E', 'space-age'])] },
    // B 1.2.5 needs a newer base than 2.1.24: B 1.2.0 is the newest that fits.
    B: { releases: [rel('B', '1.0.0'), rel('B', '1.2.0', '2.1', ['base', 'F']), rel('B', '1.2.5', '2.1', ['base >= 2.1.30', 'F']), rel('B', '1.3.0')] },
    C: { releases: [rel('C', '1.0.0')] },
    D: { releases: [rel('D', '1.0.0')] },
    E: { releases: [rel('E', '3.0.0')] },
    // F's newest is for 2.0; and G's limit on F (picked by hand too) binds once both are there.
    F: { releases: [rel('F', '0.9.0'), rel('F', '1.0.0'), rel('F', '1.1.0', '2.0')] },
    G: { releases: [rel('G', '1.0.0', '2.1', ['? F <= 0.9.0'])] },
  });
  const catalog = new FactorioCatalog(fetch);
  const r = await catalog.resolve('2.1.24', [{ name: 'A', version: null }], GAME);
  assert.deepEqual(r.unresolved, []);
  assert.deepEqual(resolved(r), ['A 1.0.0', 'B 1.2.0 < A', 'E 3.0.0 < A', 'F 1.0.0 < B']);
  // An optional dependency's limit binds once its mod is in: G holds F at 0.9.0, which B accepts.
  const both = await catalog.resolve('2.1.24', [{ name: 'A', version: null }, { name: 'G', version: null }], GAME);
  assert.deepEqual(both.unresolved, []);
  assert.deepEqual(resolved(both), ['A 1.0.0', 'G 1.0.0', 'B 1.2.0 < A', 'E 3.0.0 < A', 'F 0.9.0 < B']);
  // On Factorio 2.1.30, B 1.2.5 fits.
  assert.deepEqual(resolved(await catalog.resolve('2.1.30', [{ name: 'A', version: null }], GAME)), ['A 1.0.0', 'B 1.2.5 < A', 'E 3.0.0 < A', 'F 1.0.0 < B']);
});

test('! incompatibilities are refused, and every dependency that cannot be met is shown', async () => {
  const { fetch } = portal({}, {
    A: { releases: [rel('A', '1.0.0', '2.1', ['base', '! G', '! quality', 'missing', 'H >= 9.0', 'space-age'])] },
    G: { releases: [rel('G', '1.0.0')] },
    H: { releases: [rel('H', '1.0.0')] },
    I: { releases: [rel('I', '1.0.0', '2.1', ['base >= 2.2.0'])] },
  });
  const catalog = new FactorioCatalog(fetch);
  const r = await catalog.resolve('2.1.24', [{ name: 'A', version: null }, { name: 'G', version: null }, { name: 'I', version: null }], new Set(['base', 'quality']));
  assert.deepEqual(resolved(r), ['A 1.0.0', 'G 1.0.0']);
  assert.deepEqual(r.unresolved, [
    { mod: 'I', dependency: 'base >= 2.2.0', reason: 'Factorio 2.1.24 is picked (I: the newest for Factorio 2.1 is 1.0.0).' },
    { mod: 'A', dependency: 'missing', reason: 'Not on the mod portal.' },
    { mod: 'A', dependency: 'H >= 9.0', reason: 'No release of H for Factorio 2.1 meets it (the newest for Factorio 2.1 is 1.0.0).' },
    { mod: 'A', dependency: 'space-age', reason: "space-age comes with Factorio, but it isn't enabled on this server." },
    { mod: 'A', dependency: '! G', reason: 'G is in the update too.' },
    { mod: 'A', dependency: '! quality', reason: 'quality comes with Factorio and is enabled on this server.' },
  ]);
  // A picked mod the portal doesn't have is a 404.
  await assert.rejects(catalog.resolve('2.1.24', [{ name: 'nope', version: null }], GAME), (err: GameRefused) => err.status === 404 && err.message === 'The mod portal has no mod nope.');
});

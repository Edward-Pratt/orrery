import { DeferBlockState } from '@angular/core/testing';
import type { ModBrowse, ModCheckAnswer } from '@hub/api';
import { dialog, dialogButton, until } from '../testing';
import { mod, PICKS, SAME, sent, setup } from './game.testing';

afterEach(() => dialog() && dialogButton('cancel').click());

describe('server game tab', () => {
  it('browses the mod portal for the picked version: Add puts a mod pack in the picks, its mods follow, and Back keeps them', async () => {
    const { q, text, all, open, catalog, choose, render, backend } = await setup();
    await open();
    await choose('[data-factorio]', '2.1.25');
    await catalog({ ...SAME, changes: ['Factorio 2.1.24 → 2.1.25'] }, PICKS, '2.1.25');
    const sheet = q('[data-sheet]');
    q('[data-browse]').click();
    await render();
    await until(() => !!document.querySelector('[data-browse-search]'), () => render());
    expect(text(q('[data-sheet] [hlmSheetTitle]'))).toBe('Browse mods');
    expect(q('[data-update-view]').hidden).toBe(true);
    expect(document.activeElement).toBe(q('[data-browse-search]'));
    const read = await sent(backend, (r) => r.url === '/api/servers/space/game/mods', render);
    expect(read.request.urlWithParams).toBe('/api/servers/space/game/mods?factorio=2.1.25&sort=downloads&page=1');
    const pack = { name: 'se-pack', title: 'SE pack', owner: 'Earendel', summary: '', downloads: 9, version: '0.7.3', updated: null, category: 'mod-packs', spaceAge: false, page: 'https://mods.factorio.com/mod/se-pack' };
    read.flush({ line: '2.1', total: 2, mods: [pack, { ...pack, name: 'flib', title: 'Flib', category: null }], categories: [{ id: 'mod-packs', title: 'Mod packs' }] } satisfies ModBrowse);
    await render();
    const button = (name: string) => q<HTMLButtonElement>(`[data-listing="${name}"] [data-add-mod]`);
    expect(text(button('flib'))).toBe('Installed');
    expect(text(q('[data-browse-changes]'))).toBe('1 change');
    button('se-pack').click();
    await render();
    expect(text(q('[data-browse-changes]'))).toBe('Checking with the mod portal…');
    const withPack = [...PICKS, { name: 'se-pack', version: null }];
    await catalog(
      {
        ...SAME,
        mods: [...SAME.mods, mod('se-pack', ['0.7.3']), mod('space-exploration', ['0.7.40'], { requiredBy: 'se-pack' })],
        changes: ['Factorio 2.1.24 → 2.1.25', 'Added: se-pack 0.7.3', 'Added: space-exploration 0.7.40'],
      },
      withPack,
      '2.1.25',
    );
    expect(text(button('se-pack'))).toBe('Added');
    expect(text(q('[data-browse-changes]'))).toBe('3 changes');
    q('[data-browse-back]').click();
    await render();
    expect(document.querySelector('[data-browse-search]')).toBeNull();
    expect(q('[data-update-view]').hidden).toBe(false);
    expect(text(q('[data-sheet] [hlmSheetTitle]'))).toBe('Update game');
    expect(document.activeElement).toBe(q('[data-browse]'));
    expect(q<HTMLSelectElement>('[data-factorio]').value).toBe('2.1.25');
    expect(all('[data-pick]').map((p) => p.getAttribute('data-pick'))).toEqual(['orrery', 'flib', 'RateCalculator', 'se-pack']);
    expect(text(q('[data-dependency=space-exploration]'))).toContain('required by se-pack');
    expect(sheet.isConnected).toBe(true);
    // Review the update goes back too.
    q('[data-browse]').click();
    await until(() => !!document.querySelector('[data-browse-review]'), () => render());
    (await sent(backend, (r) => r.url === '/api/servers/space/game/mods', render)).flush({ line: '2.1', total: 0, mods: [], categories: [] } satisfies ModBrowse);
    await render();
    q('[data-browse-review]').click();
    await render();
    expect(q('[data-update-view]').hidden).toBe(false);
  });

  it("imports a client's mod-list.json: the new names checked with the hub, a preview before anything changes, then Confirm merges them and the catalog resolves", async () => {
    const { q, text, all, open, catalog, render, backend } = await setup();
    await open();
    q('[data-import]').click();
    await render();
    expect(text(q('[data-sheet] [hlmSheetTitle]'))).toBe('Import mod list');
    expect(q('[data-update-view]').hidden).toBe(true);
    expect(document.activeElement).toBe(q('[data-import-file]'));
    expect(text(q('#mod-list-where'))).toContain('%APPDATA%\\Factorio\\mods on Windows');
    expect(text(q('#mod-list-where'))).toContain('~/.factorio/mods on Linux');
    expect(text(q('#mod-list-where'))).toContain('~/Library/Application Support/factorio/mods on macOS');
    const list = {
      mods: [
        { name: 'base', enabled: true },
        { name: 'recycler', enabled: true },
        { name: 'space-age', enabled: false },
        { name: 'flib', enabled: true },
        { name: 'helmod', enabled: true, version: '2.0.0' },
        { name: 'Squeak Through', enabled: true, version: '1.0.0' },
        { name: 'gone-mod', enabled: true },
        { name: 'old-mod', enabled: true },
        { name: 'RateCalculator', enabled: false },
        { name: '<b>bold</b>', enabled: true },
      ],
    };
    const input = q<HTMLInputElement>('[data-import-file]');
    Object.defineProperty(input, 'files', { value: [new File([JSON.stringify(list)], 'mod-list.json', { type: 'application/json' })], configurable: true });
    input.dispatchEvent(new Event('change'));
    await until(() => !!document.querySelector('[data-import-checking]'), () => render()); // the file is read first
    // Only the names not in the update yet are asked about: flib is, the game's own and the bad name never go.
    const check = backend.expectOne('/api/servers/space/game/check');
    expect(check.request.method).toBe('POST');
    expect(check.request.body).toEqual({ factorio: '2.1.24', names: ['helmod', 'Squeak Through', 'gone-mod', 'old-mod'] });
    check.flush({
      line: '2.1',
      mods: [
        { name: 'helmod', found: 'fits', title: 'Helmod', latest: '2.1.0' },
        { name: 'Squeak Through', found: 'fits', title: 'Squeak Through', latest: '1.0.0' },
        { name: 'gone-mod', found: 'missing', title: null, latest: null },
        { name: 'old-mod', found: 'noRelease', title: null, latest: null },
      ],
    } satisfies ModCheckAnswer);
    await render();
    expect(text(q('[data-import-count]'))).toBe('2 mods to add from mod-list.json');
    const adding = () => all('[data-import-add]').map((li) => [li.getAttribute('data-import-add'), text(li.firstElementChild?.firstElementChild), text(li.lastElementChild)]);
    expect(adding()).toEqual([
      ['helmod', 'Helmod', 'Newest that fits'],
      ['Squeak Through', 'Squeak Through', 'Newest that fits'],
    ]);
    expect(text(q('[data-import-already]'))).toBe('1 mod already in the update: flib.');
    expect(all('[data-import-skip]').map(text)).toEqual([
      'gone-mod: not on the mod portal',
      'old-mod: no release for Factorio 2.1',
      // The server keeps its own game mods as they are: one set otherwise in the file says so.
      'base: comes with Factorio, enabled on the server too',
      'recycler: comes with Factorio: enabled here but disabled on the server, which keeps its own setting',
      'space-age: comes with Factorio: disabled here but enabled on the server, which keeps its own setting',
      "<b>bold</b>: not a mod's name",
    ]);
    expect(document.querySelector('[data-import-skipped] b')).toBeNull(); // shown as text
    expect(text(q('[data-import-left]'))).toBe('1 mod disabled in the file left out.');
    // Nothing changed yet: the picks are as they were.
    expect(backend.match('/api/servers/space/game/catalog')).toEqual([]);
    // Keep the versions in the file: helmod at 2.0.0, with no new request. The check answered only 2.1's newest, so
    // 2.0.0 is said to be checked on Add; Squeak Through's 1.0.0 is that newest.
    q<HTMLInputElement>('[data-import-keep]').click();
    await render();
    expect(adding()).toEqual([
      ['helmod', 'Helmod', '2.0.0 checked for 2.1 on Add'],
      ['Squeak Through', 'Squeak Through', '1.0.0'],
    ]);
    expect(all('[data-import-unsure]')).toHaveLength(1);
    expect(backend.match(() => true)).toEqual([]);
    expect(text(q('[data-import-go]'))).toBe('Add 2 mods');
    q('[data-import-go]').click();
    await render();
    expect(q('[data-update-view]').hidden).toBe(false);
    expect(text(q('[data-sheet] [hlmSheetTitle]'))).toBe('Update game');
    expect(document.activeElement).toBe(q('[data-import]'));
    // The picks there kept as they are, orrery too; the catalog resolves the new ones' dependencies.
    const merged = [...PICKS, { name: 'helmod', version: '2.0.0' }, { name: 'Squeak Through', version: '1.0.0' }];
    await catalog({ ...SAME, mods: [...SAME.mods, mod('helmod', ['2.1.0', '2.0.0']), mod('Squeak Through', ['1.0.0'])], changes: ['Added: helmod 2.0.0', 'Added: Squeak Through 1.0.0'] }, merged);
    expect(all('[data-pick]').map((p) => p.getAttribute('data-pick'))).toEqual(['orrery', 'flib', 'RateCalculator', 'helmod', 'Squeak Through']);
    expect(text(q('[data-changes]'))).toContain('Added: Squeak Through 1.0.0');
  });

  it('checks pasted names; a list it cannot read, a file over 256 KiB or an older hub say why inline, and nothing new or over 500 mods adds nothing', async () => {
    const { q, text, all, open, render, type, backend } = await setup();
    await open();
    q('[data-import]').click();
    await render();
    const checks = () => backend.match('/api/servers/space/game/check');
    const paste = async (value: string) => {
      await type('[data-import-text]', value);
      q('[data-import-check]').click();
      await render();
    };
    expect(q<HTMLButtonElement>('[data-import-check]').disabled).toBe(true);
    // All in the update already, or the game's own: no request, and nothing to add.
    await paste('flib, base\nRateCalculator');
    expect(checks()).toEqual([]);
    expect(text(q('[data-import-count]'))).toBe('Nothing to add from pasted');
    expect(text(q('[data-import-already]'))).toBe('2 mods already in the update: flib, RateCalculator.');
    expect(q<HTMLButtonElement>('[data-import-go]').disabled).toBe(true);
    expect(text(q('[data-import-go-why]'))).toBe('Nothing here is new to the update.');
    expect(document.querySelector('[data-import-keep]')).toBeNull(); // pasted names have no versions
    // Thousands of names that aren't a mod's: the first 50 listed, the rest counted.
    await paste(Array.from({ length: 2000 }, (_, i) => `m${i}/`).join(','));
    expect(checks()).toEqual([]);
    expect(text(q('[data-import-skipped] p'))).toBe('Skipped (2000)');
    expect(all('[data-import-skip]')).toHaveLength(50);
    expect(text(q('[data-import-skip-more]'))).toBe("and 1950 more that aren't a mod's name");
    // Not JSON: why, inline, and no request.
    await paste('{"mods": [');
    expect(text(q('[data-import-error]'))).toBe("That isn't a mod-list.json: it isn't JSON.");
    expect(document.querySelector('[data-import-preview]')).toBeNull();
    expect(checks()).toEqual([]);
    // A file over 256 KiB isn't read.
    const input = q<HTMLInputElement>('[data-import-file]');
    const big = new File(['x'], 'mod-list.json');
    Object.defineProperty(big, 'size', { value: 256 * 1024 + 1 });
    Object.defineProperty(big, 'text', { value: () => Promise.reject(new Error('read')) });
    Object.defineProperty(input, 'files', { value: [big], configurable: true });
    input.dispatchEvent(new Event('change'));
    await render();
    expect(text(q('[data-import-error]'))).toBe('mod-list.json is over 256 KiB: a mod-list.json is much smaller.');
    expect(checks()).toEqual([]);
    // A hub without the route.
    await paste('helmod');
    backend.expectOne('/api/servers/space/game/check').flush('Not Found', { status: 404, statusText: 'Not Found' });
    await render();
    expect(text(q('[data-import-error]'))).toBe("The mod portal check: This hub can't check a mod list yet: deploy hub-v2.17.0 or later.");
    // 498 new ones on 3 picks: over the hub's 500.
    const names = Array.from({ length: 498 }, (_, i) => `mod-${i}`);
    await paste(names.join('\n'));
    backend.expectOne('/api/servers/space/game/check').flush({ line: '2.1', mods: names.map((name) => ({ name, found: 'fits', title: name, latest: '1.0.0' })) } satisfies ModCheckAnswer);
    await render();
    expect(q<HTMLButtonElement>('[data-import-go]').disabled).toBe(true);
    expect(text(q('[data-import-go-why]'))).toBe('That makes 501 mods: an update takes at most 500.');
    // Back: the picks as they were, nothing asked.
    q('[data-import-back]').click();
    await render();
    expect(q('[data-update-view]').hidden).toBe(false);
    expect(document.activeElement).toBe(q('[data-import]'));
    expect(backend.match('/api/servers/space/game/catalog')).toEqual([]);
  });

  it("says to reload only in the Browse view when its chunk failed to load, never in the update view", async () => {
    const { harness, q, open, render } = await setup();
    await open();
    const blocks = await harness.fixture.getDeferBlocks();
    expect(blocks).toHaveLength(1);
    await blocks[0]!.render(DeferBlockState.Error);
    await render();
    expect(document.querySelector('[data-stale]')).toBeNull(); // the update view, as it was
    q('[data-browse]').click();
    await render();
    expect(document.querySelector('[data-stale]')).not.toBeNull();
    q('[data-browse-back]').click();
    await render();
    expect(document.querySelector('[data-stale]')).toBeNull();
    expect(q('[data-update-view]').hidden).toBe(false);
  });
});

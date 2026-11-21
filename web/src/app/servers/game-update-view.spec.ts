import { TestBed } from '@angular/core/testing';
import type { GameCatalog, ModBrowse } from '@hub/api';
import { Feedback } from '../feedback';
import { dialog, dialogButton, until } from '../testing';
import { mod, PICKS, SAME, sent, setup, STATE } from './game.testing';

afterEach(() => dialog() && dialogButton('cancel').click());

describe('server game tab', () => {
  it('opens the picker on what runs now: the Factorio releases on offer, each portal mod at its version, the game’s own apart', async () => {
    const { q, text, all, open, go } = await setup();
    await open();
    expect(all('[data-factorio] option').map(text)).toEqual(['2.1.24 (running)', '2.1.25 · stable', '2.2.0 · experimental']);
    expect(q<HTMLSelectElement>('[data-factorio]').value).toBe('2.1.24');
    expect(all('[data-pick]').map((p) => p.getAttribute('data-pick'))).toEqual(['orrery', 'flib', 'RateCalculator']);
    expect(all('[data-pick=flib] [data-version] option').map(text)).toEqual(['Newest that fits (0.16.2)', '0.16.2', '0.16.1']);
    expect(q<HTMLSelectElement>('[data-pick=flib] [data-version]').value).toBe('0.16.1');
    expect(text(q('[data-game-mods]'))).toBe('Comes with Factorio: base, elevated-rails, quality, space-age');
    expect(document.querySelector('[data-pick=orrery] [data-remove]')).toBeNull(); // the Agent needs it
    expect(document.querySelector('[data-pick=orrery] [data-locked]')).not.toBeNull();
    expect(text(q('[data-changes]'))).toContain('Nothing: the server runs these already. Add a mod or pick other versions.');
    expect(go().disabled).toBe(true);
    expect(text(q('[data-update-go-why]'))).toBe('Nothing to change: the server runs these already.');
  });

  it('labels a release factorio.com lists on both channels as stable, whatever the order', async () => {
    const both = (versions: GameCatalog['versions']) => ({ ...SAME, versions });
    const stableFirst: GameCatalog['versions'] = [
      { version: '2.1.24', channel: 'stable' },
      { version: '2.1.24', channel: 'experimental' },
    ];
    const experimentalFirst = [...stableFirst].reverse();
    for (const versions of [stableFirst, experimentalFirst]) {
      const running = await setup();
      await running.open(both(versions));
      expect(running.all('[data-factorio] option').map(running.text)).toEqual(['2.1.24 · stable (running)']);
      TestBed.resetTestingModule();
      document.body.innerHTML = '';
      const older = await setup({ ...STATE, installed: { ...STATE.installed!, factorio: '2.1.23' } });
      older.q('[data-update]').click();
      await older.render();
      await older.catalog(both(versions), PICKS, '2.1.23');
      expect(older.all('[data-factorio] option').map(older.text)).toEqual(['2.1.23 (running)', '2.1.24 · stable']);
      TestBed.resetTestingModule();
      document.body.innerHTML = '';
    }
  });

  it('puts a mod the server runs back at the version it runs, typed or from Browse: Remove then Add back changes nothing', async () => {
    const { q, text, open, catalog, type, render, backend, go } = await setup();
    await open();
    q('[data-pick=RateCalculator] [data-remove]').click();
    await render();
    const without = PICKS.filter((p) => p.name !== 'RateCalculator');
    await catalog({ ...SAME, mods: SAME.mods.slice(0, 2), changes: ['Removed: RateCalculator 3.3.2'] }, without);
    await type('[data-add-name]', 'RateCalculator');
    q('[data-add]').click();
    await render();
    await catalog(SAME, [...without, { name: 'RateCalculator', version: '3.3.2' }]);
    expect(q<HTMLSelectElement>('[data-pick=RateCalculator] [data-version]').value).toBe('3.3.2');
    expect(go().disabled).toBe(true); // what it runs: nothing to change
    // From Browse, the same.
    q('[data-pick=RateCalculator] [data-remove]').click();
    await render();
    await catalog({ ...SAME, mods: SAME.mods.slice(0, 2), changes: ['Removed: RateCalculator 3.3.2'] }, without);
    q('[data-browse]').click();
    await until(() => !!document.querySelector('[data-browse-search]'), () => render());
    const listing = { name: 'RateCalculator', title: 'Rate Calculator', owner: '', summary: '', downloads: 9, version: '3.3.3', updated: null, category: null, spaceAge: false, page: 'https://mods.factorio.com/mod/RateCalculator' };
    (await sent(backend, (r) => r.url === '/api/servers/space/game/mods', render)).flush({ line: '2.1', total: 1, mods: [listing], categories: [] } satisfies ModBrowse);
    await render();
    const button = q<HTMLButtonElement>('[data-listing=RateCalculator] [data-add-mod]');
    expect(text(button)).toBe('Add back');
    button.click();
    await render();
    await catalog(SAME, [...without, { name: 'RateCalculator', version: '3.3.2' }]);
    expect(text(button)).toBe('Installed');
  });

  it('asks the catalog on every change, shows the dependencies it added, and an unmet one stops the update until fixed', async () => {
    const { q, text, all, open, go, catalog, choose, type, render, backend } = await setup();
    await open();
    // Removing flib: the catalog adds it back for RateCalculator, at the newest that fits.
    q('[data-pick=flib] [data-remove]').click();
    await render();
    const noFlib = PICKS.filter((p) => p.name !== 'flib');
    await catalog(
      { ...SAME, mods: [mod('orrery', ['1.0.1', '1.0.0']), mod('RateCalculator', ['3.3.3', '3.3.2']), mod('flib', ['0.16.2', '0.16.1'], { requiredBy: 'RateCalculator' })], changes: ['Updated: flib 0.16.1 → 0.16.2'] },
      noFlib,
    );
    expect(text(q('[data-dependency=flib]'))).toMatch(/^FLIB\s*flib 0\.16\.2\s*required by RateCalculator$/);
    expect(go().disabled).toBe(false);
    // A new mod at the newest that fits, whose dependency can't be met on this Factorio.
    await type('[data-add-name]', ' bigger-belts ');
    q('[data-add]').click();
    await render();
    const unmet: GameCatalog = {
      ...SAME,
      mods: [...SAME.mods, mod('bigger-belts', ['0.4.0'])],
      unresolved: [{ mod: 'bigger-belts', dependency: 'base >= 2.2', reason: 'Factorio 2.1.24 is older' }],
      changes: ['Added: bigger-belts 0.4.0'],
    };
    await catalog(unmet, [...noFlib, { name: 'bigger-belts', version: null }]);
    expect(text(q('[data-unresolved]'))).toContain("A dependency can't be met. The update can't start until they are fixed");
    expect(all('[data-unmet]').map(text)).toEqual(['bigger-belts needs base >= 2.2: Factorio 2.1.24 is older']);
    expect(go().disabled).toBe(true);
    expect(text(q('[data-update-go-why]'))).toBe('Fix the unmet dependencies first.');
    // A newer Factorio meets it.
    await choose('[data-factorio]', '2.2.0');
    await catalog({ ...unmet, unresolved: [], changes: ['Factorio 2.1.24 → 2.2.0', 'Added: bigger-belts 0.4.0'] }, [...noFlib, { name: 'bigger-belts', version: null }], '2.2.0');
    expect(document.querySelector('[data-unresolved]')).toBeNull();
    expect(go().disabled).toBe(false);
    go().click();
    await render(320);
    expect(dialog()?.textContent).toContain('Update Space to Factorio 2.2.0?');
    expect(dialog()?.textContent).toContain('Factorio 2.1.24 → 2.2.0; Added: bigger-belts 0.4.0.');
    expect(dialog()?.textContent).toContain('Saves, then stops the server (a 5-minute countdown: 2 players online), swaps Factorio and the mods, and starts it.');
    expect(dialog()?.textContent).toContain('rolls back to the old ones and the pre-update save');
    dialogButton('ok').click();
    await render();
    const req = backend.expectOne('/api/servers/space/game/update');
    expect(req.request.body).toEqual({ factorio: '2.2.0', mods: [...noFlib, { name: 'bigger-belts', version: null }] });
    req.flush({ id: 3 }, { status: 202, statusText: 'Accepted' });
  });

  it('picks the newest that fits for a mod, and Update waits for the answer to the picks as they are now', async () => {
    const { q, open, go, choose, backend, render, text } = await setup();
    await open();
    await choose('[data-pick=RateCalculator] [data-version]', '');
    expect(go().disabled).toBe(true); // the answer on screen is for the earlier picks
    expect(text(q('[data-update-go-why]'))).toBe('Waiting for the mod portal.');
    await choose('[data-pick=orrery] [data-version]', '1.0.1');
    const [first, second] = backend.match('/api/servers/space/game/catalog');
    expect(first!.cancelled).toBe(true); // an answer for an earlier pick is never shown
    expect(second!.request.body.mods).toEqual([
      { name: 'orrery', version: '1.0.1' },
      { name: 'flib', version: '0.16.1' },
      { name: 'RateCalculator', version: null },
    ]);
    second!.flush({ ...SAME, changes: ['Updated: orrery 1.0.0 → 1.0.1', 'Updated: RateCalculator 3.3.2 → 3.3.3'] });
    await render();
    expect(go().disabled).toBe(false);
  });

  it("shows the catalog's refusal in the sheet, not as a toast, and the game's own mods can't be added", async () => {
    const { q, text, open, go, render, backend, type } = await setup();
    const failed = vi.spyOn(TestBed.inject(Feedback), 'failed');
    await open();
    await type('[data-add-name]', 'space-age');
    q('[data-add]').click();
    await render();
    expect(text(q('[data-add-error]'))).toBe('space-age comes with Factorio.');
    await type('[data-add-name]', 'flib');
    q('[data-add]').click();
    await render();
    expect(text(q('[data-add-error]'))).toBe('flib is in the list already.');
    backend.expectNone('/api/servers/space/game/catalog');
    await type('[data-add-name]', 'no-such-mod');
    q('[data-add]').click();
    await render();
    backend.expectOne('/api/servers/space/game/catalog').flush('The mod portal has no mod no-such-mod.', { status: 404, statusText: 'Not Found' });
    await render();
    expect(text(q('[data-catalog-error]'))).toBe('The catalog: The mod portal has no mod no-such-mod.');
    expect(go().disabled).toBe(true);
    expect(text(q('[data-update-go-why]'))).toBe('Fix the problem above first.');
    expect(failed).not.toHaveBeenCalled();
    q('[data-pick=no-such-mod] [data-remove]').click();
    await render();
    backend.expectOne('/api/servers/space/game/catalog').flush(SAME);
    await render();
    expect(document.querySelector('[data-catalog-error]')).toBeNull();
  });
});

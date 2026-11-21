import { TestBed } from '@angular/core/testing';
import type { ModUpdatesState } from '@hub/api';
import { dialog, dialogButton } from '../testing';
import { CARD, NO_UPDATES, row, SAME, setup, STATE } from './game.testing';

afterEach(() => dialog() && dialogButton('cancel').click());

describe('server game tab', () => {
  it("shows the Factorio version and every mod, the game's own muted, and the history with its mod changes", async () => {
    const history = [row({ id: 2, from: '2.1.24 · 3 mods', to: '2.1.24 · 3 mods', changes: null, outcome: 'rolled back', finished: Date.UTC(2026, 9, 20, 10, 14) }), row({})];
    const { el, text } = await setup({ ...STATE, history });
    expect(text(el.querySelector('[data-installed]'))).toBe('Factorio 2.1.24');
    expect(text(el.querySelector('[data-mod=flib]'))).toBe('flib 0.16.1');
    expect(el.querySelector('[data-mod=space-age]')!.className).toContain('text-muted-foreground');
    expect(el.querySelector('[data-mod=space-age]')!.getAttribute('title')).toBe('Comes with Factorio');
    expect(el.querySelector('[data-mod=flib]')!.getAttribute('title')).toBeNull();
    const rows = [...el.querySelectorAll('[data-update-row]')].map((r) => [...r.querySelectorAll('td')].slice(1).map(text));
    expect(rows).toEqual([
      ['2.1.24 · 3 mods', 'rolled back 14 m', 'alex'],
      ['2.1.23 · 2 mods → 2.1.24 · 3 mods Added: flib 0.16.1', 'ok 6 m', 'alex'],
    ]);
  });

  it('says so when there are no updates yet, or when its Agent has not said what it runs', async () => {
    const { el, q, text } = await setup({ ...STATE, installed: null, history: [] });
    expect(text(el.querySelector('[data-no-history]'))).toBe('No game updates yet.');
    expect(text(el.querySelector('[data-not-reported]'))).toContain("Its Agent hasn't said yet what the server runs");
    expect(q<HTMLButtonElement>('[data-update]').disabled).toBe(true);
  });

  it("disables Update game with the hub's reason, but not for a stopped server", async () => {
    const busy = await setup({ ...STATE, blocked: 'The Agent on vm is not connected.' });
    expect(busy.q<HTMLButtonElement>('[data-update]').disabled).toBe(true);
    expect(busy.text(busy.el.querySelector('[data-update-why]'))).toBe('The Agent on vm is not connected.');
    TestBed.resetTestingModule();
    const stopped = await setup(STATE, { ...CARD, online: false, players: [], service: { id: 'factorio', state: 'inactive' } });
    expect(stopped.q<HTMLButtonElement>('[data-update]').disabled).toBe(false);
    expect(stopped.el.querySelector('[data-update-why]')).toBeNull();
  });

  it('shows a failure while preparing as a red box naming its cause', async () => {
    const failed = row({
      id: 3,
      to: '2.2.0 · 3 mods',
      outcome: 'failed in staging',
      step: 'prepare',
      backup: null,
      log: 'Factorio 2.2.0 needs glibc 2.39; the friend must re-run setup with a newer image\nprepare: failed: needs glibc 2.39',
    });
    const { el, text } = await setup({ ...STATE, history: [failed, row({})] });
    const box = text(el.querySelector('[data-failed-prep]'));
    expect(box).toContain("Update to 2.2.0 · 3 mods failed while preparing. The server wasn't touched.");
    expect(box).toContain('needs glibc 2.39; the friend must re-run setup with a newer image');
  });

  describe('portal mod updates', () => {
    const UPDATES: ModUpdatesState = {
      ...NO_UPDATES,
      updates: [
        { name: 'flib', title: 'Factorio Library', from: '0.16.1', to: '0.16.2' },
        { name: 'RateCalculator', title: 'Rate Calculator', from: '3.3.2', to: '3.3.3' },
      ],
      later: [{ name: 'Krastorio2', title: 'Krastorio 2', latest: '2.1.0' }],
      gone: ['oldmod'],
      unchecked: ['a', 'b'],
    };

    it('shows the count, each updatable chip with its version in words, and the later, gone and unchecked lines', async () => {
      const { el, text, all } = await setup(STATE, CARD, UPDATES);
      expect(text(el.querySelector('[data-updates]'))).toBe('2 updates');
      expect(all('[data-update-to]').map(text)).toEqual(['→ 0.16.2, update available: 0.16.2', '→ 3.3.3, update available: 3.3.3']);
      expect(el.querySelector('[data-mod="flib"] [data-update-to]')!.getAttribute('title')).toBe('0.16.2 is on the mod portal for Factorio 2.1');
      expect(text(el.querySelector('[data-later]'))).toBe('Newer releases need a newer Factorio: Krastorio2 2.1.0.');
      expect(text(el.querySelector('[data-gone]'))).toBe("Not on the mod portal for Factorio 2.1 any more: oldmod. A game update can't keep it: remove it in Update game.");
      expect(text(el.querySelector('[data-unchecked]'))).toBe('Not checked (more than 20 at once): a, b.');
      expect(text(el.querySelector('[data-update-all]'))).toBe('Update 2 mods…');
    });

    it('Update N mods… opens the sheet with the updatable mods at the newest that fits and the others as they run', async () => {
      const { q, render, catalog } = await setup(STATE, CARD, UPDATES);
      q('[data-update-all]').click();
      await render();
      await catalog(SAME, [
        { name: 'orrery', version: '1.0.0' },
        { name: 'flib', version: null },
        { name: 'RateCalculator', version: null },
      ]);
    });

    it('says the mods are up to date, or why the portal could not be checked, and nothing at all against an older hub', async () => {
      const up = await setup();
      expect(up.text(up.el.querySelector('[data-up-to-date]'))).toBe('Mods up to date');
      expect(up.el.querySelector('[data-update-all]')).toBeNull();
      TestBed.resetTestingModule();
      const failed = await setup(STATE, CARD, { ...UPDATES, error: 'The mod portal answered 503.' });
      expect(failed.text(failed.el.querySelector('[data-check-error]'))).toMatch(/^Couldn't check the mod portal: The mod portal answered 503\. \(last checked at /);
      expect(failed.text(failed.el.querySelector('[data-updates]'))).toBe('2 updates');
      TestBed.resetTestingModule();
      const old = await setup(STATE, CARD, 404);
      expect(old.el.querySelector('[data-updates], [data-up-to-date], [data-checking-updates], [data-update-all]')).toBeNull();
    });

    it('asks again on a modUpdates notice, a finished update and a change in what the server runs', async () => {
      const { backend, notice, reload, render } = await setup();
      const asked = () => backend.match('/api/servers/space/game/updates').length;
      await notice({ severity: 'info', kind: 'modUpdates', factorio: '2.1.24', mods: [], count: 0 });
      expect(asked()).toBe(1);
      await notice({ severity: 'good', kind: 'packUpdateFinished', outcome: 'ok', from: 'a', to: 'b', ms: 1 });
      backend.match('/api/servers/space');
      await reload({ ...STATE, installed: { ...STATE.installed!, factorio: '2.1.25' } });
      await render();
      expect(asked()).toBe(2); // the notice's ask, then the change's (the first answer never came, so one request each)
    });
  });
});

import { TestBed } from '@angular/core/testing';
import type { PackState } from '@hub/api';
import { Feedback } from '../feedback';
import { dialog } from '../testing';
import { extra, INSTALLED, setup } from './pack.testing';

describe('server pack tab', () => {
  it('shows Extras with their pills, removed ones struck through, and the Mod as a locked last row', async () => {
    const state: PackState = {
      ...INSTALLED,
      extras: [
        extra('config/forge.cfg', { replaces: true, change: 'replaced' }),
        extra('mods/dynmap.jar', { removed: true, change: 'removed' }),
        extra('mods/journeymap-fairplay.jar', { label: '5.2.6', note: 'fairplay build' }),
      ],
    };
    const { el, text } = await setup(state);
    const rows = [...el.querySelectorAll('[data-extra]')];
    expect(rows.map((r) => r.getAttribute('data-extra'))).toEqual(['config/forge.cfg', 'mods/dynmap.jar', 'mods/journeymap-fairplay.jar']);
    expect(text(rows[0]!.querySelector('[data-change]'))).toBe('replaced');
    expect(text(rows[0]!.querySelector('[data-where]'))).toBe("replaces the pack's file");
    expect(text(rows[2]!.querySelector('[data-where]'))).toBe('new path');
    expect(rows[1]!.querySelector('.line-through')).not.toBeNull();
    expect(rows[1]!.querySelector('[data-more]')).toBeNull();
    expect(text(rows[2])).toContain('new path 5.2.6 · alex');
    expect(text(rows[2])).toContain('fairplay build');
    const mod = el.querySelector('[data-mod-row]')!;
    expect(text(mod)).toContain('mods/gtnhdiscord-1.4.0.jar');
    expect(text(mod)).toContain('put back on every update. Deployed from Host.');
    expect(mod.querySelector('[data-more]')).toBeNull();
    expect(el.querySelector('[data-extras] li:last-child')).toBe(mod);
  });

  it('removes an Extra from its ⋯ menu without asking, and says the change is pending', async () => {
    const { el, render, backend } = await setup();
    const ok = vi.spyOn(TestBed.inject(Feedback), 'ok');
    el.querySelector<HTMLButtonElement>('[data-extra="config/forge.cfg"] [data-more]')!.click();
    await render();
    expect([...document.querySelectorAll('[data-slot=dropdown-menu-item]')].map((i) => i.textContent?.trim())).toEqual(['Replace file…', 'Edit label and note…', 'Remove']);
    document.querySelector<HTMLButtonElement>('[data-slot=dropdown-menu-item][data-remove]')!.click();
    await render();
    expect(dialog()).toBeNull();
    const req = backend.expectOne((r) => r.method === 'DELETE' && r.url === `/api/servers/gtnh/pack/extras/${'config/forge.cfg'.length}`);
    expect(req.request.headers.get('content-type')).toBe('application/json');
    req.flush({ ...INSTALLED, pending: [{ path: 'config/forge.cfg', kind: 'extra', change: 'removed' }] });
    await render();
    expect(ok).toHaveBeenCalledWith('Saved: changes pending, not on the server until you apply them.');
  });

  it('adds an Extra from a sheet: Put at from the file name, and a note when the pack has that path', async () => {
    const { q, type, render, backend } = await setup();
    q('[data-add-extra]').click();
    await render();
    const file = new File(['jar'], 'Chunk-Pregenerator-4.4.4.jar');
    const input = q<HTMLInputElement>('[data-extra-file]');
    Object.defineProperty(input, 'files', { value: [file] });
    input.dispatchEvent(new Event('change'));
    await render();
    expect(q<HTMLInputElement>('[data-target]').value).toBe('mods/Chunk-Pregenerator-4.4.4.jar');
    expect(document.querySelector('[data-replaces]')).toBeNull();
    await type('[data-target]', 'config/forge.cfg');
    expect(document.querySelector('[data-replaces]')?.textContent).toContain('this Extra replaces it');
    await type('[data-target]', 'mods/pregen.jar');
    await type('[data-label]', '4.4.4');
    await type('[data-note]', 'pregen');
    q('[data-save]').click();
    await render();
    backend.expectOne('/api/uploads').flush({ upload: 'u1' });
    await render();
    backend.expectOne('/api/uploads/u1?offset=0').flush({ received: 3 });
    await render();
    const add = backend.expectOne('/api/servers/gtnh/pack/extras');
    expect(add.request.body).toEqual({ upload: 'u1', target: 'mods/pregen.jar', label: '4.4.4', note: 'pregen' });
    add.flush(INSTALLED);
    await render(320);
    expect(document.querySelector('[data-sheet]')).toBeNull();
  });
});

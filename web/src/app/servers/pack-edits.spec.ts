import { INSTALLED, setup } from './pack.testing';

describe('server pack tab', () => {
  it('shows edits, one that matched nothing in red, and previews a new one before saving', async () => {
    const state = { ...INSTALLED, edits: [{ ...INSTALLED.edits[0]!, path: 'config/GregTech/Pollution.cfg', find: 'pollution=true', replace: 'pollution=false', failedOn: '2.7.5' }] };
    const { el, q, type, text, render, backend } = await setup(state);
    expect(text(el.querySelector('[data-unmatched]'))).toBe('Matched nothing in 2.7.5 (the last update tried).');
    q('[data-add-edit]').click();
    await render();
    await type('[data-edit-path]', 'startserver.sh');
    await type('[data-find]', '-Xmx(\\d+)G');
    await type('[data-replace-with]', '-Xmx12G');
    await render(350);
    const preview = backend.expectOne('/api/servers/gtnh/pack/edits/preview');
    expect(preview.request.body).toEqual({ path: 'startserver.sh', find: '-Xmx(\\d+)G' });
    preview.flush({ matches: 1 });
    await render();
    expect(document.querySelector('[data-preview]')?.textContent?.trim()).toBe('Against the installed 2.7.4: 1 match');
    q('[data-save]').click();
    await render();
    const save = backend.expectOne('/api/servers/gtnh/pack/edits');
    expect(save.request.body).toEqual({ path: 'startserver.sh', find: '-Xmx(\\d+)G', replace: '-Xmx12G', note: '' });
    save.flush(INSTALLED);
  });
});

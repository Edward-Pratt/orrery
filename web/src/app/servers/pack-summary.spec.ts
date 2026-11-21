import { TestBed } from '@angular/core/testing';
import type { PackState } from '@hub/api';
import { dialog, dialogButton } from '../testing';
import { CARD, INSTALLED, row, setup } from './pack.testing';

describe('server pack tab', () => {
  it("shows the server's Java runtime and changes it, pending until the next restart", async () => {
    const { el, q, text, render, backend, library } = await setup();
    await library();
    expect(q<HTMLSelectElement>('[data-runtime-select]').value).toBe('');
    expect([...el.querySelectorAll('[data-runtime-select] option')].map(text)).toEqual(['System java', 'Temurin 21.0.8+9']);
    const select = q<HTMLSelectElement>('[data-runtime-select]');
    select.value = 'temurin-21.0.8+9';
    select.dispatchEvent(new Event('change'));
    await render();
    const req = backend.expectOne('/api/servers/gtnh/pack/runtime');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ runtime: 'temurin-21.0.8+9' });
    req.flush({ ...INSTALLED, runtime: { name: 'temurin-21.0.8+9', pending: true, unitLines: null } });
    await render();
    expect(text(el.querySelector('[data-runtime-pending]'))).toBe('pending restart');
    expect(q<HTMLSelectElement>('[data-runtime-select]').value).toBe('temurin-21.0.8+9');
  });

  it("shows the two unit lines instead of the selector when the server's unit doesn't name the link", async () => {
    const lines = ['Environment=PATH=/srv/o/java/gtnh/bin:/usr/local/bin:/usr/bin:/bin', 'Environment=JAVA_HOME=/srv/o/java/gtnh'];
    const { el, text, library } = await setup({ ...INSTALLED, runtime: { name: null, pending: false, unitLines: lines } });
    await library();
    expect(el.querySelector('[data-runtime-select]')).toBeNull();
    expect(text(el.querySelector('[data-runtime-now]'))).toBe('System java');
    expect(el.querySelector('[data-unit-lines]')!.textContent).toBe(lines.join('\n'));
  });

  it('lists the changes pending in an amber box, with Apply N changes beside Update pack', async () => {
    const pending: PackState = {
      ...INSTALLED,
      pending: [
        { path: 'config/forge.cfg', kind: 'extra', change: 'removed' },
        { path: 'startserver.sh', kind: 'edit', change: 'replaced' },
      ],
    };
    const { el, text } = await setup(pending);
    expect(text(el.querySelector('[data-pending]'))).toContain('2 changes pending');
    expect(text(el.querySelector('[data-pending]'))).toContain('config/forge.cfg removed');
    expect(text(el.querySelector('[data-pending]'))).toContain('startserver.sh edits replaced');
    expect(text(el.querySelector('[data-apply]'))).toBe('Apply 2 changes');
    expect(el.querySelector('[data-update]')).not.toBeNull();
  });

  it('applies the changes pending after a dialog, posting { pending: true }', async () => {
    const { q, render, backend } = await setup({ ...INSTALLED, pending: [{ path: 'config/forge.cfg', kind: 'extra', change: 'removed' }] });
    q('[data-apply]').click();
    await render();
    expect(dialog()?.textContent).toContain('Apply 1 change to GTNH?');
    expect(dialog()?.textContent).toContain('3 players online');
    dialogButton('ok').click();
    await render();
    const req = backend.expectOne('/api/servers/gtnh/pack/update');
    expect(req.request.body).toEqual({ pending: true });
    req.flush({ id: 2 }, { status: 202, statusText: 'Accepted' });
  });

  it('updates to a library version picked in the sheet, after the dialog naming the server and the version', async () => {
    const { q, render, backend, pick, library } = await setup();
    q('[data-update]').click();
    await render();
    await library();
    expect(document.querySelector('[data-sheet]')?.textContent).toContain('rolls back');
    expect(document.querySelector('[data-sheet] [data-library-link]')).not.toBeNull();
    expect(q('[data-update-go]').textContent?.trim()).toBe('Update to ……');
    await pick(2);
    expect(q('[data-update-go]').textContent?.trim()).toBe('Update to 2.7.5…');
    q('[data-update-go]').click();
    await render(320);
    expect(dialog()?.textContent).toContain('Update GTNH to GT New Horizons 2.7.5?');
    expect(dialogButton('ok').textContent?.trim()).toBe('Update to 2.7.5');
    dialogButton('ok').click();
    await render();
    const req = backend.expectOne('/api/servers/gtnh/pack/update');
    expect(req.request.body).toEqual({ library: 2 });
    req.flush({ id: 2 }, { status: 202, statusText: 'Accepted' });
  });

  it("disables Update and Apply with the hub's reason, or when the server is offline", async () => {
    const busy = await setup({ ...INSTALLED, blocked: 'A restore is running on GTNH.', pending: [{ path: 'a', kind: 'extra', change: 'added' }] });
    expect(busy.q<HTMLButtonElement>('[data-update]').disabled).toBe(true);
    expect(busy.q<HTMLButtonElement>('[data-apply]').disabled).toBe(true);
    expect(busy.text(busy.el.querySelector('[data-update-why]'))).toBe('A restore is running on GTNH.');
    TestBed.resetTestingModule();
    const offline = await setup(INSTALLED, { ...CARD, online: false });
    expect(offline.q<HTMLButtonElement>('[data-update]').disabled).toBe(true);
    expect(offline.text(offline.el.querySelector('[data-update-why]'))).toBe('GTNH is offline: an update needs it running, for the backup.');
  });

  it('shows a failure while preparing as a red box naming its cause', async () => {
    const failed = row({
      id: 3,
      from: '2.7.4',
      to: '2.7.5',
      outcome: 'failed in staging',
      step: 'prepare',
      backup: null,
      log: 'The Config edit on config/GregTech/Pollution.cfg (pollution=true) matched nothing in 2.7.5.\nprepare: failed: The Config edit on config/GregTech/Pollution.cfg (pollution=true) matched nothing in 2.7.5.',
    });
    const { el, text } = await setup({ ...INSTALLED, history: [failed, row({})] });
    const box = text(el.querySelector('[data-failed-prep]'));
    expect(box).toContain("Update to 2.7.5 failed while preparing. The server wasn't touched.");
    expect(box).toContain('config/GregTech/Pollution.cfg (pollution=true) matched nothing in 2.7.5.');
  });
});

import { TestBed } from '@angular/core/testing';
import type { BackupsAnswer, ServiceStatus } from '@hub/api';
import { dialog, dialogButton, until } from '../testing';
import { CARD, FACTORIO, setup } from './server.testing';

describe("a factorio server's saves", () => {
  const GB = 1024 ** 3;
  const SAVES: BackupsAnswer = {
    configured: true,
    backups: [
      { name: 'orrery-2026-10-31T12-00-00Z.zip', size: GB, mtimeMs: new Date(2026, 9, 31, 12, 0).getTime(), kind: 'named', current: false },
      { name: '_autosave3.zip', size: GB, mtimeMs: new Date(2026, 9, 31, 11, 50).getTime(), kind: 'auto', current: false },
      { name: 'world.zip', size: 2 * GB, mtimeMs: new Date(2026, 9, 30, 8, 0).getTime(), kind: 'world', current: true },
    ],
    free: 40 * GB,
    growth: null,
    minFree: 10 * GB,
  };
  const FACTORIO_SVC: ServiceStatus = { id: 'factorio', unit: 'factorio.service', state: 'active', sub: 'running', checks: [] };
  const marks = (el: HTMLElement) =>
    [...el.querySelectorAll('[data-backup]')].map((r) => [r.querySelector('[data-kind]')?.textContent?.trim() ?? null, !!r.querySelector('[data-current]')]);
  const openMenu = async (page: { el: HTMLElement; render: () => Promise<void> }) => {
    page.el.querySelector<HTMLButtonElement>('[data-backup-more]')!.click();
    await until(() => !!document.querySelector('[data-restore]'), page.render);
  };
  const type = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };

  it('says Saves and Save now, and marks each with its kind, and the world Factorio last loaded as the current world', async () => {
    const { el, text } = await setup('/space/backups', FACTORIO, FACTORIO_SVC, { backups: SAVES });
    expect(text(el.querySelector('[data-tile=count] h2'))).toBe('Saves');
    expect(text(el.querySelector('[data-backup-start]'))).toBe('Save now');
    expect([...el.querySelectorAll('thead th')].map((th) => th.textContent?.trim()).slice(0, 3)).toEqual(['Name', 'Saved', 'Size']);
    expect(marks(el)).toEqual([['Named', false], ['Autosave', false], ['World', true]]);
    expect(text(el.querySelector('[data-current]'))).toBe('Current world');
    expect(el.querySelector('[data-kind]')!.getAttribute('title')).toContain('Made by the Agent');
  });

  it('has no marks on a Minecraft backup', async () => {
    const { el } = await setup('/gtnh/backups', CARD, null, { backups: { ...SAVES, backups: [{ name: '2026-09-27-06-00-00.zip', size: GB, mtimeMs: 0 }] } });
    expect(marks(el)).toEqual([[null, false]]);
    expect(el.querySelector('[data-backup-start]')?.textContent?.trim()).toBe('Start backup');
  });

  it('saves without asking, "Saving…" until the finished notice, and explains offline in save words', async () => {
    const { backend, events, el, render, text } = await setup('/space/backups', FACTORIO, FACTORIO_SVC, { backups: SAVES });
    el.querySelector<HTMLButtonElement>('[data-backup-start]')!.click();
    expect(dialog()).toBeNull();
    backend.expectOne('/api/servers/space/backup').flush({ output: [] });
    await render();
    expect(text(el.querySelector('[data-backup-start]'))).toBe('Saving…');
    expect(text(el.querySelector('[data-progress]'))).toBe('Saving: this updates when it finishes.');
    events.push(1, { serverId: 'space', type: 'notice', severity: 'good', kind: 'backupFinished', detail: 'orrery-2026-10-31T12-30-00Z.zip' });
    await render();
    expect(el.querySelector('[data-progress]')).toBeNull();
    TestBed.resetTestingModule();

    const offline = await setup('/space/backups', { ...FACTORIO, online: false }, FACTORIO_SVC, { backups: { ...SAVES, backups: [] } });
    expect(offline.el.textContent).toContain('Space Age is offline: a save needs it running.');
    expect(offline.text(offline.el.querySelector('[data-empty] p'))).toBe('No saves yet');
  });

  it("names a restored copy's copy after the original save, as the Agent does", async () => {
    const restored = { ...SAVES, backups: [{ name: 'restored-20261031T120000Z-restored-20261030T080000Z-world.zip', size: GB, mtimeMs: new Date(2026, 9, 31, 12, 0).getTime(), kind: 'world' as const, current: true }] };
    const page = await setup('/space/backups', { ...FACTORIO, online: false }, { ...FACTORIO_SVC, state: 'inactive', sub: 'dead' }, { backups: restored });
    await openMenu(page);
    document.querySelector<HTMLButtonElement>('[data-restore]')!.click();
    await page.render();
    expect(dialog()?.textContent).toContain('copies the save as the newest one (restored-<time>-world.zip)');
  });

  it('restores a save only with its service stopped, copying it as the newest one, which the next start loads', async () => {
    const running = await setup('/space/backups', { ...FACTORIO, online: false }, FACTORIO_SVC, { backups: SAVES });
    await openMenu(running);
    expect(document.querySelector('[data-restore-why]')?.textContent?.trim()).toBe('To restore a save, stop factorio.service first.');
    TestBed.resetTestingModule();
    document.querySelectorAll('.cdk-overlay-container > *').forEach((n) => n.remove());

    const page = await setup('/space/backups', { ...FACTORIO, online: false }, { ...FACTORIO_SVC, state: 'inactive', sub: 'dead' }, { backups: SAVES });
    await openMenu(page);
    document.querySelector<HTMLButtonElement>('[data-restore]')!.click();
    await page.render();
    expect(dialog()?.textContent).toContain('copies the save as the newest one (restored-<time>-orrery-2026-10-31T12-00-00Z.zip)');
    expect(dialog()?.textContent).toContain('Nothing is overwritten');
    type(document.querySelector<HTMLInputElement>('[data-confirm-typed]')!, 'Space Age');
    await page.render();
    dialogButton('ok').click();
    await page.render();
    const req = page.backend.expectOne('/api/servers/space/restore');
    expect(req.request.body).toEqual({ name: 'orrery-2026-10-31T12-00-00Z.zip' });
    req.flush({ output: [] });
    await page.render();
    expect(page.el.querySelector('[data-progress]')).toBeNull();
  });
});

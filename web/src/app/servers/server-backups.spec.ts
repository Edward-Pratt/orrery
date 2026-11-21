import { TestBed } from '@angular/core/testing';
import type { BackupsAnswer, ServiceStatus } from '@hub/api';
import { Feedback } from '../feedback';
import { dialog, dialogButton, until } from '../testing';
import { CARD, debounce, detail, setup } from './server.testing';

describe('server backups section', () => {
  const GB = 1024 ** 3;
  const BACKUPS: BackupsAnswer = {
    configured: true,
    backups: [
      { name: '2026-09-27-06-00-00.zip', size: 3 * GB, mtimeMs: new Date(2026, 8, 27, 6, 5).getTime() },
      { name: '2026-09-26-06-00-00.zip', size: 2.5 * GB, mtimeMs: new Date(2026, 8, 26, 6, 4).getTime() },
    ],
    free: 40 * GB,
    growth: 0.5 * GB,
    minFree: 10 * GB,
  };
  const rows = (el: HTMLElement) =>
    [...el.querySelectorAll('[data-backup]')].map((r) => [...r.querySelectorAll('td')].slice(0, 3).map((td) => td.textContent?.trim()));
  const tiles = (el: HTMLElement) => Object.fromEntries([...el.querySelectorAll('[data-tile]')].map((t) => [t.getAttribute('data-tile'), t.querySelector('[data-value]')?.textContent?.trim()]));

  it('lists backups newest first with sizes, and shows the count, total, free space and growth as tiles', async () => {
    const { el, tabs } = await setup('/gtnh/backups', CARD, null, { backups: BACKUPS });
    expect(tabs()).toContain('Backups');
    expect(rows(el)).toEqual([
      ['2026-09-27-06-00-00.zip', '2026-09-27 06:05', '3.0 GB'],
      ['2026-09-26-06-00-00.zip', '2026-09-26 06:04', '2.5 GB'],
    ]);
    expect(tiles(el)).toEqual({ count: '2', total: '5.5 GB', free: '40.0 GB', growth: '+512.0 MB/day' });
    expect(el.querySelector('[data-tile=free]')!.getAttribute('data-state')).toBe('ok');
  });

  it('turns Free amber when it is under the minimum', async () => {
    const { el } = await setup('/gtnh/backups', CARD, null, { backups: { ...BACKUPS, free: 4 * GB } });
    const free = el.querySelector('[data-tile=free]')!;
    expect(free.getAttribute('data-state')).toBe('warn');
    expect(free.querySelector('[data-value]')!.classList).toContain('text-status-warn');
    expect(free.textContent).toContain('under the 10.0 GB minimum');
  });

  it('has no Backups section without a backup folder', async () => {
    const { el, tabs } = await setup('/gtnh/backups');
    expect(tabs()).not.toContain('Backups');
    expect(el.querySelector('[data-backup-start]')).toBeNull();
  });

  it('says there are no backups yet, with a Start backup action', async () => {
    const { backend, el, render } = await setup('/gtnh/backups', CARD, null, { backups: { ...BACKUPS, backups: [] } });
    expect(el.querySelector('[data-empty]')?.textContent).toContain('No backups yet');
    el.querySelector<HTMLButtonElement>('[data-backup-start-empty]')!.click();
    backend.expectOne('/api/servers/gtnh/backup').flush({ output: [] });
    await render();
  });

  it('starts a backup without asking, shows it running from the live feed, and a finished notice ends it and refreshes the list', async () => {
    const { backend, events, el, render } = await setup('/gtnh/backups', CARD, null, { backups: BACKUPS });
    el.querySelector<HTMLButtonElement>('[data-backup-start]')!.click();
    expect(dialog()).toBeNull();
    const req = backend.expectOne('/api/servers/gtnh/backup');
    expect(req.request.method).toBe('POST');
    req.flush({ output: ['Backup started'] });
    await render();
    // The command's reply text isn't shown; the tab shows the backup running.
    expect(el.textContent).not.toContain('Backup started');
    expect(el.querySelector('[data-progress]')?.textContent).toContain('Backup running');
    expect(el.querySelector<HTMLButtonElement>('[data-backup-start]')!.disabled).toBe(true);

    events.push(1, { serverId: 'gtnh', type: 'notice', severity: 'good', kind: 'backupFinished', detail: 'done' });
    await debounce();
    const newer = { name: '2026-09-27-18-00-00.zip', size: GB, mtimeMs: new Date(2026, 8, 27, 18, 1).getTime() };
    backend.expectOne('/api/servers/gtnh').flush(detail(CARD, { backups: { ...BACKUPS, backups: [newer, ...BACKUPS.backups] } }));
    await render();
    expect(el.querySelector('[data-progress]')).toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-backup-start]')!.disabled).toBe(false);
    expect(rows(el).map((r) => r[0])).toEqual(['2026-09-27-18-00-00.zip', '2026-09-27-06-00-00.zip', '2026-09-26-06-00-00.zip']);
  });

  it('explains offline: the button is disabled, and a 409 is a toast', async () => {
    const offline = await setup('/gtnh/backups', { ...CARD, online: false }, null, { backups: BACKUPS });
    expect(offline.el.querySelector<HTMLButtonElement>('[data-backup-start]')!.disabled).toBe(true);
    expect(offline.el.textContent).toContain('GTNH is offline: a backup needs it running.');
    TestBed.resetTestingModule();

    const { backend, el, render } = await setup('/gtnh/backups', CARD, null, { backups: BACKUPS });
    const failed = vi.spyOn(TestBed.inject(Feedback), 'failed');
    el.querySelector<HTMLButtonElement>('[data-backup-start]')!.click();
    backend.expectOne('/api/servers/gtnh/backup').flush('GTNH is offline', { status: 409, statusText: 'Conflict' });
    await render();
    expect(failed).toHaveBeenCalledWith('Starting the backup', expect.objectContaining({ error: 'GTNH is offline' }));
    expect(el.querySelector('[data-progress]')).toBeNull();
  });
});

describe('restoring a backup', () => {
  const GB = 1024 ** 3;
  const BACKUPS: BackupsAnswer = {
    configured: true,
    backups: [{ name: '2026-09-27-06-00-00.zip', size: GB, mtimeMs: 0 }],
    free: 40 * GB,
    growth: null,
    minFree: 10 * GB,
  };
  const GTNH: ServiceStatus = { id: 'gtnh', unit: 'gtnh.service', state: 'active', sub: 'running', checks: [] };
  /** Opens the first row's ⋯ menu; Restore is in the overlay. */
  const openMenu = async (page: { el: HTMLElement; render: () => Promise<void> }) => {
    page.el.querySelector<HTMLButtonElement>('[data-backup-more]')!.click();
    await until(() => !!document.querySelector('[data-restore]'), page.render);
  };
  const restoreButton = () => document.querySelector<HTMLButtonElement>('[data-restore]')!;
  const why = () => document.querySelector('[data-restore-why]')?.textContent?.trim();
  const type = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };

  it('is disabled with a reason until the linked service is stopped, following live state', async () => {
    const page = await setup('/gtnh/backups', { ...CARD, online: false }, GTNH, { backups: BACKUPS });
    await openMenu(page);
    expect(restoreButton().disabled).toBe(true);
    expect(why()).toBe('To restore a backup, stop gtnh.service first.');
    await until(() => page.events.requests.length > 0);
    page.events.push(1, { target: 'service', id: 'gtnh', type: 'state', state: 'inactive', sub: 'dead' });
    await page.render();
    if (!restoreButton()) await openMenu(page); // on a busy machine the overlay can close before this render
    expect(restoreButton().disabled).toBe(false);
    expect(why()).toBeUndefined();
  });

  it('is disabled without a linked service', async () => {
    const page = await setup('/gtnh/backups', CARD, null, { backups: BACKUPS });
    await openMenu(page);
    expect(restoreButton().disabled).toBe(true);
    expect(why()).toContain('no linked service');
  });

  it("asks for the server's name before restoring, then reports it as a toast, not the script's output", async () => {
    const stopped = { ...GTNH, state: 'inactive', sub: 'dead' };
    const page = await setup('/gtnh/backups', { ...CARD, online: false }, stopped, { backups: BACKUPS });
    const { backend, el, render } = page;
    await openMenu(page);
    restoreButton().click();
    await render();
    expect(dialog()?.textContent).toContain('pre-restore');
    const confirm = dialogButton('ok');
    expect(confirm.disabled).toBe(true);
    type(document.querySelector<HTMLInputElement>('[data-confirm-typed]')!, 'gtnh');
    await render();
    expect(confirm.disabled).toBe(true);
    type(document.querySelector<HTMLInputElement>('[data-confirm-typed]')!, 'GTNH');
    await render();
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await render();
    const req = backend.expectOne('/api/servers/gtnh/restore');
    expect(req.request.body).toEqual({ name: '2026-09-27-06-00-00.zip' });
    expect(el.querySelector('[data-progress]')?.textContent).toContain('Restoring 2026-09-27-06-00-00.zip');
    req.flush({ output: ['Restored 2026-09-27-06-00-00.zip into /srv/GTNH/World.', 'Next: sudo systemctl start gtnh.service'] });
    await render();
    expect(el.querySelector('[data-progress]')).toBeNull();
    expect(el.textContent).not.toContain('Next: sudo systemctl');
  });

  it("shows the hub's refusal", async () => {
    const stopped = { ...GTNH, state: 'inactive', sub: 'dead' };
    const page = await setup('/gtnh/backups', { ...CARD, online: false }, stopped, { backups: BACKUPS });
    const { backend, render } = page;
    const failed = vi.spyOn(TestBed.inject(Feedback), 'failed');
    await openMenu(page);
    restoreButton().click();
    await render();
    type(document.querySelector<HTMLInputElement>('[data-confirm-typed]')!, 'GTNH');
    await render();
    dialogButton('ok').click();
    await render();
    backend.expectOne('/api/servers/gtnh/restore').flush('The restore failed: restore-backup: unzip failed', { status: 502, statusText: 'Bad Gateway' });
    await render();
    expect(failed).toHaveBeenCalledWith('Restoring 2026-09-27-06-00-00.zip', expect.objectContaining({ error: 'The restore failed: restore-backup: unzip failed' }));
  });
});

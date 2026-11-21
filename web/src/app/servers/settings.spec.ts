import { TestBed } from '@angular/core/testing';
import { Feedback } from '../feedback';
import { dialog, dialogButton } from '../testing';
import { FIELDS, STATE, VALUES, setup } from './settings.testing';

afterEach(() => dialog() && dialogButton('cancel').click());

describe('server settings tab', () => {
  it("is a factorio server's tab, after Game, with features.settings", async () => {
    const { el, text } = await setup();
    expect([...el.querySelectorAll('[data-sections] a')].map(text).slice(-2)).toEqual(['Game', 'Settings']);
  });

  it('renders the fields from the report, and Save waits for a valid change', async () => {
    const { q, text, type, save, el } = await setup();
    expect(q<HTMLInputElement>('[data-field=name]').value).toBe('orrery Factorio');
    expect(q<HTMLInputElement>('[data-field=max_players]').value).toBe('0');
    expect(q<HTMLSelectElement>('[data-field=allow_commands]').value).toBe('admins-only');
    expect(q('[data-field=require_user_verification]').getAttribute('role')).toBe('switch');
    expect(q('[data-field=require_user_verification]').getAttribute('aria-checked')).toBe('true');
    expect(text(q('[data-password-state]'))).toBe('Set');
    expect(text(q('[data-admin=alice]'))).toContain('alice');
    expect(q('[data-admin=alice] button').getAttribute('aria-label')).toBe('Remove alice from the admins');
    expect([...el.querySelectorAll('[data-badge]')].map(text)).toEqual(['next restart', 'next restart']);
    expect(save().disabled).toBe(true);
    expect(q('[data-applies]')).toBeNull();

    await type('[data-field=max_players]', '1001');
    expect(text(q('[data-error=max_players]'))).toBe('A whole number from 0 to 1000.');
    expect(save().disabled).toBe(true);
    await type('[data-field=max_players]', '8');
    expect(q('[data-changed=max_players]').getAttribute('title')).toBe('Saved: 0');
    expect(save().disabled).toBe(false);
    await type('[data-field=name]', ' padded');
    expect(q('[data-field=name]').getAttribute('aria-describedby')).toBe('err-name');
    expect(save().disabled).toBe(true);
    // 26 two-byte letters: 26 characters, but 52 bytes, past what Factorio keeps.
    await type('[data-field=name]', 'Ü'.repeat(26));
    expect(text(q('[data-error=name]'))).toBe('Name: Factorio keeps only the first 50 bytes, so at most 50 plain letters (fewer with accents or emoji).');
    expect(save().disabled).toBe(true);
    await type('[data-field=name]', 'Ü'.repeat(25));
    expect(q('[data-error=name]')).toBeNull();
  });

  it('a long name the file already has is no error; clearing the description applies now', async () => {
    const { q, text, type, save } = await setup({ ...STATE, settings: { ...VALUES, name: 'n'.repeat(60), description: 'Ours' } });
    expect(q('[data-error=name]')).toBeNull();
    await type('[data-field=description]', '');
    expect(text(q('[data-applies]'))).toBe('Applies now: Description.');
    expect(save().disabled).toBe(false);
  });

  it('says what applies now and what at the next restart, then sends every field and the password only when changed', async () => {
    const { q, text, type, tick, save, backend, reload, render } = await setup();
    const ok = vi.spyOn(TestBed.inject(Feedback), 'ok');
    await type('[data-field=name]', 'Our base');
    await type('[data-field=max_players]', '8');
    await tick('[data-field=auto_pause]');
    expect(text(q('[data-applies]'))).toBe('Applies now: Name, Max players. At the next restart: Pause while nobody is on.');
    save().click();
    await render();
    const req = backend.expectOne('/api/servers/space/settings');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ ...FIELDS, name: 'Our base', max_players: 8, auto_pause: false, admins: ['alice'] });
    expect('game_password' in req.request.body).toBe(false);
    req.flush({ applied: ['name', 'max_players'], pending: ['auto_pause'] });
    await render();
    expect(ok).toHaveBeenCalledWith('Saved. 1 change applies at the next restart.');
    await reload({ ...STATE, settings: { ...VALUES, name: 'Our base', max_players: 8, auto_pause: false }, pending: ['auto_pause'] });
    expect(text(q('[data-pending]'))).toContain('Waiting for a restart: Pause while nobody is on.');
    expect(q('[data-restart]')).not.toBeNull();
    expect(save().disabled).toBe(true);
  });

  it("an older hub's 404 says which hub to deploy", async () => {
    const { q, text } = await setup(404);
    expect(text(q('[data-missing]'))).toBe('This hub has no game settings yet: deploy hub-v2.16.0 or later.');
  });
});

import { TestBed } from '@angular/core/testing';
import { dialog, dialogButton } from '../testing';
import { generatePassword } from './settings';
import { STATE, VALUES, setup } from './settings.testing';

afterEach(() => dialog() && dialogButton('cancel').click());

describe('server settings tab', () => {
  it('changes the password: typed or generated, shown on demand; Remove is disabled with the account check off', async () => {
    const { q, click, save, backend, render } = await setup();
    await click('[data-password-change]');
    const input = q<HTMLInputElement>('[data-password-input]');
    expect(input.type).toBe('password');
    await click('[data-password-generate]');
    expect(q<HTMLInputElement>('[data-password-input]').type).toBe('text');
    const generated = q<HTMLInputElement>('[data-password-input]').value;
    expect(generated).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(generatePassword()).not.toBe(generated);
    save().click();
    await render();
    const req = backend.expectOne('/api/servers/space/settings');
    expect(req.request.body.game_password).toBe(generated);
    req.flush({ applied: ['game_password'], pending: [] });
    await render();

    const off = await (async () => {
      TestBed.resetTestingModule();
      return setup({ ...STATE, settings: { ...VALUES, require_user_verification: false } });
    })();
    expect(off.q<HTMLButtonElement>('[data-password-remove]').disabled).toBe(true);
  });

  it('turning the account check off warns in a live region, turns Lua commands off and needs a password', async () => {
    const { q, text, click, choose, save, el } = await setup({ ...STATE, settings: { ...VALUES, game_password_set: false } });
    expect(q('[data-warning-region]').getAttribute('aria-live')).toBe('polite');
    expect(q('[data-warning]')).toBeNull();
    await click('[data-field=require_user_verification]');
    expect(q('[data-field=require_user_verification]').getAttribute('aria-checked')).toBe('false');
    expect(text(q('[data-warning]'))).toMatch(/^Names are not checked\. Without this, players join with no factorio\.com account check: anyone who has the game password can join under any name, an admin's included\./);
    expect(text(q('[data-warning]'))).toContain('Keep the game password secret, and change it here if it leaks.');
    expect(q<HTMLSelectElement>('[data-field=allow_commands]').value).toBe('false');
    expect(text(q('[data-commands-off]'))).toBe("Turned off with the account check: names can't be trusted.");
    expect(text(q('[data-admin=alice]'))).toContain('(name not checked)');
    expect(text(q('[data-error=game_password]'))).toBe('Without the account check a game password is needed.');
    expect(save().disabled).toBe(true);
    await choose('[data-field=allow_commands]', 'admins-only');
    expect(q('[data-commands-risk]').className).toContain('text-destructive');
    expect(text(q('[data-commands-risk]'))).toBe('Anyone with the game password can run Lua as an admin.');
    await click('[data-password-change]');
    const input = q<HTMLInputElement>('[data-password-input]');
    input.value = 'pass word';
    input.dispatchEvent(new Event('input'));
    await click('[data-password-reveal]');
    expect(save().disabled).toBe(true);
    input.value = 'family-secret';
    input.dispatchEvent(new Event('input'));
    await click('[data-password-reveal]');
    expect(save().disabled).toBe(false);
    expect(el.querySelector('[data-error=game_password]')).toBeNull();
  });

  it('adds and removes admins, checking names as they are typed', async () => {
    const { q, text, type, click, save, backend, render } = await setup();
    await type('[data-admin-name]', 'a b');
    expect(text(q('[data-error=admin]'))).toBe('Names are 1 to 60 letters, digits, _, . or -.');
    expect(q<HTMLButtonElement>('[data-admin-add]').disabled).toBe(true);
    await type('[data-admin-name]', 'ALICE');
    expect(text(q('[data-error=admin]'))).toBe('ALICE is an admin already.');
    await type('[data-admin-name]', 'bob');
    await click('[data-admin-add]');
    await click('[data-admin=alice] button');
    save().click();
    await render();
    const req = backend.expectOne('/api/servers/space/settings');
    expect(req.request.body.admins).toEqual(['bob']);
    req.flush({ applied: ['admins'], pending: [] });
    await render();
  });
});

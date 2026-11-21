import { TestBed } from '@angular/core/testing';
import { dialog, dialogButton } from '../testing';
import { CARD, STATE, setup } from './settings.testing';

afterEach(() => dialog() && dialogButton('cancel').click());

describe('server settings tab', () => {
  it('shows the rolled-back, stopped, unreadable and extra-keys states', async () => {
    const { q, text } = await setup(
      { ...STATE, settings: null, problem: 'Unexpected end of file', extra: ['tags', 'max_upload_slots'], rolledBack: 'Value (-1) outside of range' },
      { ...CARD, online: false, service: { id: 'factorio', state: 'inactive' } },
    );
    expect(text(q('[data-rolled-back]'))).toBe("The server didn't start with the settings saved last, so the Agent put back the ones it last started with: Value (-1) outside of range");
    expect(text(q('[data-stopped]'))).toBe('The server is stopped: changes are written now and apply when it starts.');
    expect(text(q('[data-problem]'))).toBe("server-settings.json can't be read (Unexpected end of file). Saving writes a new one from these fields.");
    expect(text(q('[data-extra]'))).toBe('Saving rewrites server-settings.json without: tags, max_upload_slots.');
    expect(q<HTMLInputElement>('[data-field=name]').value).toBe('orrery Factorio');
    expect(text(q('[data-password-state]'))).toBe('Not set');
    expect(q('[data-restart]')).toBeNull();
  });

  it("an older Agent's deploy text, and an Agent that hasn't reported, show no values; a disconnected one shows the last report read-only", async () => {
    const old = "This server's Agent runs agent-v1.1.1, which can't change game settings. Deploy agent-v1.2.0 or later from the Host page (Releases).";
    const none = { ...STATE, settings: null, admins: [] };
    const a = await setup({ ...none, blocked: old });
    expect(a.text(a.q('[data-old-agent]'))).toBe(old);
    expect(a.q('[data-card]'), 'no made-up values').toBeNull();
    expect(a.q('[data-save]')).toBeNull();
    TestBed.resetTestingModule();
    const unheard = await setup({ ...none, blocked: "Space's Agent hasn't reported its game settings yet." });
    expect(unheard.text(unheard.q('[data-read-only]'))).toBe("Space's Agent hasn't reported its game settings yet.");
    expect(unheard.q('[data-card]')).toBeNull();
    expect(unheard.q('[data-footer]')).toBeNull();
    TestBed.resetTestingModule();
    const away = await setup({ ...none, blocked: "The Agent isn't connected." });
    expect(away.text(away.q('[data-read-only]'))).toBe("The Agent isn't connected.");
    expect(away.q('[data-card]')).toBeNull();
    TestBed.resetTestingModule();
    const b = await setup({ ...STATE, blocked: "The Agent isn't connected." });
    expect(b.text(b.q('[data-read-only]'))).toBe("The Agent isn't connected. The fields show its last report.");
    expect(b.q<HTMLFieldSetElement>('[data-card=admins]').disabled).toBe(true);
    expect(b.save().disabled).toBe(true);
    TestBed.resetTestingModule();
    const c = await setup({ ...STATE, blocked: 'The server is starting or stopping: try again in a minute.' });
    expect(c.q<HTMLFieldSetElement>('[data-card=server]').disabled).toBe(false);
    await c.type('[data-field=max_players]', '4');
    expect(c.save().disabled).toBe(true);
    expect(c.text(c.q('[data-blocked]'))).toBe('The server is starting or stopping: try again in a minute.');
  });

  it('asks again on a settings notice, and Restart… asks before it restarts', async () => {
    const { q, click, notice, reload, backend, render } = await setup({ ...STATE, pending: ['autosave_slots'] }, { ...CARD, players: ['Sam'] });
    await notice({ kind: 'settings', severity: 'info' });
    await reload({ ...STATE, pending: ['autosave_slots'] });
    await click('[data-restart]');
    await render(50);
    expect(dialog()?.textContent).toContain('the restart counts down 5 minutes in game first');
    dialogButton('ok').click();
    await render();
    const req = backend.expectOne('/api/servers/space/restart');
    expect(req.request.body).toEqual({ minutes: 5 });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await render();
    expect(q('[data-restart]')).not.toBeNull();
  });
});

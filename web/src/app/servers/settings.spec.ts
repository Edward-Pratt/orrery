import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { GameSettingsState, Notice, ServerCard, ServerDetail } from '@hub/api';
import { FETCH, RETRY_MS } from '../events';
import { Feedback } from '../feedback';
import { dialog, dialogButton, fakeEvents, loggedIn, settle } from '../testing';
import routes from './routes';
import { generatePassword } from './settings';

const CARD: ServerCard = {
  id: 'space',
  name: 'Space',
  game: 'factorio',
  rate: { label: 'UPS', max: 60 },
  online: true,
  hung: false,
  paused: false,
  tps: 60,
  players: [],
  uptimeDay: 1,
  restart: null,
  lagging: false,
  service: { id: 'factorio', state: 'active' },
  features: { chat: true, tps: true, quests: false, console: true, update: true, settings: true },
  packUpdate: null,
};
const DETAIL = { card: CARD, service: null, top: { day: [], week: [], all: [] }, backups: { configured: false }, pack: false, logs: false } as unknown as ServerDetail;
const VALUES = {
  name: 'orrery Factorio',
  description: '',
  max_players: 0,
  game_password_set: true,
  require_user_verification: true,
  autosave_interval: 10,
  autosave_slots: 5,
  afk_autokick_interval: 0,
  auto_pause: true,
  auto_pause_when_players_connect: false,
  only_admins_can_pause_the_game: true,
  allow_commands: 'admins-only' as const,
};
const STATE: GameSettingsState = { settings: VALUES, admins: ['alice'], problem: null, pending: [], extra: [], rolledBack: null, blocked: null };
const { game_password_set: _, ...FIELDS } = VALUES;

/** Opens the server's Settings tab and answers its detail and settings (or fails them with `status`). */
async function setup(state: GameSettingsState | number = STATE, card: ServerCard = CARD) {
  const events = fakeEvents();
  TestBed.configureTestingModule({
    providers: [loggedIn(), provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }, { provide: RETRY_MS, useValue: 0 }],
  });
  const harness = await RouterTestingHarness.create();
  const backend = TestBed.inject(HttpTestingController);
  await harness.navigateByUrl('/space/settings');
  backend.expectOne('/api/servers/space').flush({ ...DETAIL, card });
  await settle();
  harness.fixture.detectChanges();
  await settle();
  const first = backend.expectOne('/api/servers/space/settings');
  if (typeof state === 'number') first.flush('', { status: state, statusText: 'x' });
  else first.flush(state);
  const el = harness.routeNativeElement as HTMLElement;
  const render = async (ms = 10) => (await new Promise((r) => setTimeout(r, ms)), harness.fixture.detectChanges(), await harness.fixture.whenStable());
  await render();
  const text = (e: Element | null | undefined) => e?.textContent?.replace(/\s+/g, ' ').trim();
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
  const type = async (sel: string, value: string) => {
    const input = q<HTMLInputElement>(sel);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render();
  };
  const choose = async (sel: string, value: string) => {
    const select = q<HTMLSelectElement>(sel);
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await render();
  };
  const tick = async (sel: string) => {
    q<HTMLInputElement>(sel).click();
    await render();
  };
  const click = async (sel: string) => {
    q(sel).click();
    await render();
  };
  const save = () => q<HTMLButtonElement>('[data-save]');
  /** Answers the reload a save or an event asks for (debounced). */
  const reload = async (next: GameSettingsState) => {
    await render(70);
    backend.expectOne('/api/servers/space/settings').flush(next);
    await render();
  };
  let n = 1;
  const notice = async (e: Notice) => {
    events.push(n++, { ...e, type: 'notice', serverId: 'space' });
    await render();
  };
  return { harness, backend, el, render, text, q, type, choose, tick, click, save, reload, notice };
}

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

  it("an older hub's 404 says which hub to deploy", async () => {
    const { q, text } = await setup(404);
    expect(text(q('[data-missing]'))).toBe('This hub has no game settings yet: deploy hub-v2.16.0 or later.');
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

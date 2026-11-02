import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { ModerationState, PlayerLists, ServerCard, ServerDetail } from '@hub/api';
import { FETCH, RETRY_MS } from '../events';
import { Feedback } from '../feedback';
import { dialogButton, fakeEvents, settle, until } from '../testing';
import routes from './routes';

const CARD = {
  id: 'space',
  name: 'Space',
  game: 'factorio',
  rate: { label: 'UPS', max: 60 },
  online: true,
  players: ['alice', 'Bob', 'bad name'],
  features: { chat: true, tps: true, quests: false, console: true, update: true },
} as unknown as ServerCard;
const DETAIL = { card: CARD, service: null, top: { day: [], week: [], all: [] }, backups: { configured: false }, pack: false, logs: false } as unknown as ServerDetail;
const LISTS: PlayerLists = { bans: [{ name: 'griefer_1', reason: 'stealing iron' }, { name: 'noreason', reason: null }], bansTotal: 2, hidden: 0, admins: ['alice'], verification: true, problem: null };
const STATE: ModerationState = { online: ['alice', 'Bob', 'bad name'], lists: LISTS, blocked: null };
const URL = '/api/servers/space/moderation';

/** Opens the server's Players tab and answers its detail and the moderation state (404: an older hub). */
async function setup(state: ModerationState | 404 = STATE, card: ServerCard = CARD) {
  const events = fakeEvents();
  TestBed.configureTestingModule({
    providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }, { provide: RETRY_MS, useValue: 0 }],
  });
  const harness = await RouterTestingHarness.create();
  const backend = TestBed.inject(HttpTestingController);
  await harness.navigateByUrl('/space/players');
  backend.expectOne('/api/servers/space').flush({ ...DETAIL, card });
  const render = async (ms = 10) => (await new Promise((r) => setTimeout(r, ms)), harness.fixture.detectChanges(), await harness.fixture.whenStable());
  await settle();
  await render();
  const el = harness.routeNativeElement as HTMLElement;
  if (card.game === 'factorio') {
    let found: ReturnType<HttpTestingController['match']> = [];
    await until(() => (found = backend.match(URL)).length > 0, render);
    for (const r of found) state === 404 ? r.flush('Not Found', { status: 404, statusText: 'Not Found' }) : r.flush(state);
  }
  await render();
  const q = <T extends HTMLElement = HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
  const text = (e: Element | null | undefined) => e?.textContent?.replace(/\s+/g, ' ').trim();
  const type = async (sel: string, value: string) => {
    const input = q<HTMLInputElement>(sel);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await render();
  };
  /** The action the section just sent, answered with `outcome` and `lists`. */
  const answer = async (outcome: string, lists: PlayerLists = LISTS) => {
    let found: ReturnType<HttpTestingController['match']> = [];
    await until(() => (found = backend.match((r) => r.url === URL && r.method === 'POST')).length > 0, render);
    const body = found[0]!.request.body;
    found[0]!.flush({ outcome, lists });
    await render();
    return body;
  };
  const feedback = TestBed.inject(Feedback);
  const ok = vi.spyOn(feedback, 'ok');
  const notice = vi.spyOn(feedback, 'notice');
  return { el, q, text, type, render, answer, backend, events, ok, notice };
}

describe('Moderation', () => {
  it('shows who is on with the Admin badge, the bans and the admins; a name the rule refuses gets no buttons', async () => {
    const { el, text } = await setup();
    expect(text(el.querySelector('[data-online="alice"] [data-admin-badge]'))).toBe('Admin');
    expect(el.querySelector('[data-online="alice"] [data-demote]')).not.toBeNull();
    expect(el.querySelector('[data-online="Bob"] [data-promote]')).not.toBeNull();
    const bad = el.querySelector<HTMLButtonElement>('[data-online="bad name"] [data-kick]')!;
    expect(bad.disabled).toBe(true);
    expect(bad.title).toBe("This name can't be moderated from the dashboard: use the Console tab.");
    expect([...el.querySelectorAll('[data-banned]')].map((b) => b.getAttribute('data-banned'))).toEqual(['griefer_1', 'noreason']);
    expect(text(el.querySelector('[data-banned="noreason"] span.truncate'))).toBe('(no reason)');
    expect(el.querySelector('[data-admin="alice"]')).not.toBeNull();
  });

  it('Ban… asks with a reason and its counter, then sends it; the toast says the outcome', async () => {
    const { el, q, text, type, render, answer, ok } = await setup();
    q('[data-online="Bob"] [data-ban]').click();
    await render();
    expect(text(q('[data-form] b'))).toBe('Ban Bob?');
    expect(q('[data-form-go]').getAttribute('data-variant') ?? q('[data-form-go]').className).toContain('destructive');
    await type('[data-reason]', 'stealing iron');
    expect(text(q('[data-reason-count]'))).toBe('13/200');
    q('[data-form-go]').click();
    await render();
    expect(await answer('done')).toEqual({ action: 'ban', player: 'Bob', reason: 'stealing iron' });
    expect(el.querySelector('[data-form]')).toBeNull();
    expect(ok).toHaveBeenCalledWith('Bob is banned.');
  });

  it('the reason is refused inline as the hub would; Kick sends without one', async () => {
    const { q, type, render, answer, notice } = await setup();
    q('[data-online="Bob"] [data-kick]').click();
    await render();
    await type('[data-reason]', 'x'.repeat(201));
    expect(q('[data-reason-error]')).not.toBeNull();
    expect(q<HTMLButtonElement>('[data-form-go]').disabled).toBe(true);
    await type('[data-reason]', '');
    q('[data-form-go]').click();
    await render();
    expect(await answer('unconfirmed')).toEqual({ action: 'kick', player: 'Bob' });
    expect(notice).toHaveBeenCalledWith('Sent, but Bob is still online: check the Console tab.');
  });

  it('Unban and Demote send at once; Promote asks first; the lists come from the answer', async () => {
    const { el, q, render, answer, type, ok } = await setup();
    q('[data-banned="griefer_1"] [data-unban]').click();
    expect(await answer('done', { ...LISTS, bans: [LISTS.bans[1]!], bansTotal: 1 })).toEqual({ action: 'unban', player: 'griefer_1' });
    expect(el.querySelector('[data-banned="griefer_1"]')).toBeNull();
    await type('[data-admin-name]', 'a b');
    expect(q('[data-admin-error]')).not.toBeNull();
    await type('[data-admin-name]', 'carol');
    q('[data-admin-add]').click();
    await until(() => !!document.querySelector('[data-confirm-ok]'), render);
    dialogButton('ok').click();
    expect(await answer('already')).toEqual({ action: 'promote', player: 'carol' });
    expect(ok).toHaveBeenCalledWith('carol was an admin already.');
  });

  it('says why: verification off, blocked, a file problem, and an older hub', async () => {
    const off = await setup({ ...STATE, blocked: 'Space is stopped: start it to kick, ban, unban or change admins here.', lists: { ...LISTS, verification: false, problem: "server-banlist.json can't be read: not a JSON list." } });
    expect(off.el.querySelector('[data-verification-off]')).not.toBeNull();
    expect(off.text(off.el.querySelector('[data-blocked]'))).toContain('is stopped');
    expect(off.text(off.el.querySelector('[data-problem]'))).toBe("server-banlist.json can't be read: not a JSON list.");
    expect(off.q<HTMLButtonElement>('[data-banned="griefer_1"] [data-unban]').disabled).toBe(true);
    TestBed.resetTestingModule();
    const old = await setup(404);
    expect(old.text(old.el.querySelector('[data-old-hub]'))).toBe('This hub has no player moderation yet: deploy hub-v2.20.0 or later.');
  });

  it('says how many bans are cut or hidden', async () => {
    const { el, text } = await setup({ ...STATE, lists: { ...LISTS, bansTotal: 1234, hidden: 2 } });
    expect(text(el.querySelector('[data-bans-cut]'))).toBe(`Showing 2 of ${(1234).toLocaleString()} bans, by name.`);
    expect(text(el.querySelector('[data-bans-hidden]'))).toBe("2 bans have names the dashboard can't show: see /bans in the Console tab.");
  });

  it('is not there for a Minecraft server', async () => {
    const { el } = await setup(STATE, { ...CARD, game: 'minecraft' } as ServerCard);
    expect(el.querySelector('[data-moderation]')).toBeNull();
  });
});

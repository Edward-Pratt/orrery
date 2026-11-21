// What the Settings tab's specs stand on (`settings.spec.ts`, `settings-form.spec.ts`, `settings-banners.spec.ts`): a
// factorio server's card and detail, its game settings report, and `setup()`, the server's Settings tab opened through
// the routes with the helpers its tests read and drive it through.

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { GameSettingsState, Notice, ServerCard, ServerDetail } from '@hub/api';
import { FETCH, RETRY_MS } from '../events';
import { fakeEvents, loggedIn, settle } from '../testing';
import routes from './routes';

export const CARD: ServerCard = {
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
export const DETAIL = { card: CARD, service: null, top: { day: [], week: [], all: [] }, backups: { configured: false }, pack: false, logs: false } as unknown as ServerDetail;
export const VALUES = {
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
export const STATE: GameSettingsState = { settings: VALUES, admins: ['alice'], problem: null, pending: [], extra: [], rolledBack: null, blocked: null };
const { game_password_set: _, ...FIELDS } = VALUES;
export { FIELDS };

/** Opens the server's Settings tab and answers its detail and settings (or fails them with `status`). */
export async function setup(state: GameSettingsState | number = STATE, card: ServerCard = CARD) {
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

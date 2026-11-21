import type { PlayerAnswer, ServerDetail } from '@hub/api';
import { dialog, dialogButton } from '../testing';
import { CARD, setup } from './server.testing';

describe('server stats section', () => {
  const H = 3_600_000;
  const TOP: ServerDetail['top'] = {
    day: [{ player: 'Steve', ms: 2 * H + 5 * 60_000 }, { player: 'Alex', ms: 45_000 }],
    week: [{ player: 'Steve', ms: 30 * H }],
    all: [],
  };
  const lists = (el: HTMLElement) =>
    Object.fromEntries(
      [...el.querySelectorAll('[data-top]')].map((l) => [
        l.getAttribute('data-top'),
        [...l.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim()).join(' ')),
      ]),
    );
  const lookup = async (el: HTMLElement, name: string) => {
    el.querySelector<HTMLInputElement>('[data-lookup] input')!.value = name;
    el.querySelector('[data-lookup]')!.dispatchEvent(new Event('submit'));
  };
  const found = (el: Element) => {
    const card = el.querySelector('[data-player]');
    return card ? [...card.querySelectorAll('h3, dt, dd')].map((e) => e.textContent?.trim()).join(' ') : undefined;
  };
  const STEVE: PlayerAnswer = { found: true, player: 'Steve', totalMs: 30 * H, weekMs: 3 * H, lastSeen: { online: true } };

  it('lists the most-played for the last day, week and all time, with durations', async () => {
    const { el, tabs } = await setup('/gtnh/players', CARD, null, { top: TOP });
    expect(tabs()).toContain('Players');
    expect(lists(el)).toEqual({
      day: ['1 Steve 2 h 5 m', '2 Alex 45 s'],
      week: ['1 Steve 1 d 6 h'],
      all: ['No playtime recorded.'],
    });
  });

  it('says what goes here while nobody has played', async () => {
    const { el } = await setup('/gtnh/players');
    expect(el.querySelector('[data-empty]')?.textContent).toContain('Nobody has played yet');
    expect(el.querySelector('[data-top]')).toBeNull();
  });

  it('shows one list at a time on a phone, chosen with the Day / Week / All control', async () => {
    const { el, render } = await setup('/gtnh/players', CARD, null, { top: TOP });
    const hidden = () => [...el.querySelectorAll('[data-list]')].filter((l) => l.classList.contains('max-sm:hidden')).map((l) => l.getAttribute('data-list'));
    expect(hidden()).toEqual(['week', 'all']);
    el.querySelector<HTMLButtonElement>('[data-show=week]')!.click();
    await render();
    expect(hidden()).toEqual(['day', 'all']);
  });

  it('looks a player up as a card: playtime and last seen, online or not; a name never seen is said so', async () => {
    const { backend, el, render } = await setup('/gtnh/players', CARD, null, { top: TOP });
    await lookup(el, 'Steve');
    await render();
    expect(el.querySelector('[data-skeleton]')).not.toBeNull();
    backend.expectOne('/api/servers/gtnh/players/Steve').flush(STEVE);
    await render();
    expect(found(el)).toBe('Steve Total 1 d 6 h Last 7 days 3 h Last seen online now');

    const seen = new Date(2026, 8, 20, 21, 15).getTime();
    await lookup(el, 'alex');
    backend.expectOne('/api/servers/gtnh/players/alex').flush({ found: true, player: 'Alex', totalMs: 60_000, weekMs: 0, lastSeen: seen } satisfies PlayerAnswer);
    await render();
    expect(found(el)).toBe('Alex Total 1 m Last 7 days 0 s Last seen 2026-09-20 21:15');

    await lookup(el, 'Nobody');
    backend.expectOne('/api/servers/gtnh/players/Nobody').flush('Not Found', { status: 404, statusText: 'Not Found' });
    await render();
    expect(found(el)).toBeUndefined();
    expect(el.querySelector('[data-never]')?.textContent?.trim()).toBe('Nobody: never seen here.');
  });

  it('opens a top player in the lookup', async () => {
    const { backend, el } = await setup('/gtnh/players', CARD, null, { top: TOP });
    el.querySelector<HTMLButtonElement>('[data-top=day] button')!.click();
    backend.expectOne('/api/servers/gtnh/players/Steve');
  });

  describe('player card anywhere', () => {
    const card = () => found(dialog()!);

    it('opens from a name in the Overview’s online list', async () => {
      const { backend, el, render } = await setup('/gtnh');
      el.querySelector<HTMLButtonElement>('[data-player-name] button')!.click();
      await render();
      backend.expectOne('/api/servers/gtnh/players/Steve').flush(STEVE);
      await render();
      expect(card()).toBe('Steve Total 1 d 6 h Last 7 days 3 h Last seen online now');
      dialogButton('cancel').click();
    });

    it('opens from a name in chat, and says when the name was never seen', async () => {
      const { backend, events, el, render } = await setup('/gtnh/chat');
      events.push(1, { serverId: 'gtnh', type: 'chat', player: 'Nobody', message: 'hi' });
      await render();
      el.querySelector<HTMLButtonElement>('[data-chat] button')!.click();
      await render();
      backend.expectOne('/api/servers/gtnh/players/Nobody').flush('Not Found', { status: 404, statusText: 'Not Found' });
      await render();
      expect(dialog()?.querySelector('[data-never]')?.textContent?.trim()).toBe('Nobody: never seen here.');
      dialogButton('cancel').click();
    });
  });
});

import { FACTORIO, setup } from './server.testing';

describe('server chat section', () => {
  it('shows recent chat from the replay, then live lines, for this server only', async () => {
    const { events, render, chat } = await setup('/gtnh/chat');
    events.push(1, { serverId: 'gtnh', type: 'join', player: 'Steve' });
    events.push(2, { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' });
    events.push(3, { serverId: 'other', type: 'chat', player: 'Alex', message: 'elsewhere' });
    events.push(4, { serverId: 'gtnh', type: 'tps', tps: 19 });
    await render();
    expect(chat()).toEqual(['Steve joined', 'Steve: hi']);
    events.push(5, { serverId: 'gtnh', type: 'say', author: 'alex', message: 'hello from Discord', source: 'discord' });
    events.push(6, { serverId: 'gtnh', type: 'death', player: 'Steve', message: 'Steve fell' });
    await render();
    expect(chat()).toEqual(['Steve joined', 'Steve: hi', 'alex Discord: hello from Discord', 'Steve fell']);
  });

  it("shows a factorio server's milestones, with the player and a force other than the default", async () => {
    const { el, events, render, chat } = await setup('/space/chat', FACTORIO);
    events.push(1, { serverId: 'space', type: 'milestone', kind: 'research', text: 'Mining productivity 12' });
    events.push(2, { serverId: 'space', type: 'milestone', kind: 'rocket', text: 'Nauvis' });
    events.push(3, { serverId: 'space', type: 'milestone', kind: 'rocket', text: '', force: 'red' });
    events.push(4, { serverId: 'space', type: 'milestone', kind: 'platform', text: 'Platform 1' });
    events.push(5, { serverId: 'space', type: 'milestone', kind: 'landing', text: 'Vulcanus', player: 'alice' });
    events.push(6, { serverId: 'space', type: 'milestone', kind: 'landing', text: 'Fulgora', player: 'bob', force: 'red' });
    await render();
    expect(chat()).toEqual([
      'Research finished: Mining productivity 12',
      'First rocket launched from Nauvis',
      'First rocket launched (force red)',
      'First space platform in orbit: Platform 1',
      'First landing on Vulcanus by alice',
      'First landing on Fulgora by bob (force red)',
    ]);
    // A player's name opens their card, as in any other line.
    expect([...el.querySelectorAll('[data-milestone] button')].map((b) => b.textContent)).toEqual(['alice', 'bob']);
  });

  it('tags each sent line with where it came from, and leaves game chat untagged', async () => {
    const { el, events, render } = await setup('/gtnh/chat');
    events.push(1, { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' });
    events.push(2, { serverId: 'gtnh', type: 'say', author: 'bob', message: 'from Discord', source: 'discord' });
    events.push(3, { serverId: 'gtnh', type: 'say', author: 'alex', message: 'from here', source: 'dashboard' });
    await render();
    const tags = [...el.querySelectorAll('[data-chat] li')].map((li) => li.querySelector('[data-source]')?.textContent?.trim() ?? null);
    expect(tags).toEqual([null, 'Discord', 'Dashboard']);
  });

  it("starts each line with its local time, the day too before today, and the full date on hover", async () => {
    // Local-time dates, so the expected times hold in any zone.
    vi.useFakeTimers({ now: new Date(2026, 8, 30, 15, 0), toFake: ['Date'] });
    try {
      const { el, events, render } = await setup('/gtnh/chat');
      const earlier = new Date(2026, 8, 29, 23, 30).getTime();
      const today = new Date(2026, 8, 30, 9, 5).getTime();
      events.push(1, { serverId: 'gtnh', type: 'join', player: 'Steve' }, earlier);
      events.push(2, { serverId: 'gtnh', type: 'chat', player: 'Steve', message: 'hi' }, today);
      await render();
      const times = [...el.querySelectorAll('[data-chat] li time')];
      expect(times.map((t) => t.textContent?.trim())).toEqual(['29 Sep 23:30', '09:05']);
      expect(times.map((t) => t.getAttribute('datetime'))).toEqual([new Date(earlier).toISOString(), new Date(today).toISOString()]);
      expect(times[1]!.getAttribute('title')).toBe('Wednesday 30 September 2026, 09:05:00');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends a message as JSON, and explains a 409 as the server being offline', async () => {
    const { backend, el, render } = await setup('/gtnh/chat');
    const input = el.querySelector<HTMLInputElement>('[data-chat-form] input')!;
    const form = el.querySelector('[data-chat-form]')!;
    input.value = 'hello';
    form.dispatchEvent(new Event('submit'));
    const req = backend.expectOne('/api/servers/gtnh/chat');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ message: 'hello' });
    expect(req.request.headers.get('content-type') ?? req.request.detectContentTypeHeader()).toBe('application/json');
    req.flush(null, { status: 204, statusText: 'No Content' });
    expect(input.value).toBe('');

    input.value = 'anyone?';
    form.dispatchEvent(new Event('submit'));
    backend.expectOne('/api/servers/gtnh/chat').flush('GTNH is offline', { status: 409, statusText: 'Conflict' });
    await render();
    expect(el.querySelector('[role=alert]')?.textContent).toContain("GTNH is offline: the message wasn't sent.");
  });
});

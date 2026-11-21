import { FACTORIO, NO_MOD, setup } from './server.testing';

describe('server console section', () => {
  const submit = (el: HTMLElement, command: string) => {
    el.querySelector<HTMLInputElement>('[data-console-form] input')!.value = command;
    el.querySelector('[data-console-form]')!.dispatchEvent(new Event('submit'));
  };
  const entries = (el: HTMLElement) =>
    [...el.querySelectorAll('[data-console] > li')].map((li) => [...li.querySelectorAll('b, [data-by], [data-line]')].map((e) => e.textContent).join(' | '));

  it('posts a command and shows its output, then later output and others\' commands from the stream', async () => {
    const { backend, events, el, render, tabs } = await setup('/gtnh/console');
    expect(tabs()).toContain('Console');
    events.push(1, { serverId: 'gtnh', type: 'console', command: 'list', by: 'discord:bob (2)', output: ['1 player online'] });
    submit(el, 'spark profiler');
    const req = backend.expectOne('/api/servers/gtnh/command');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ command: 'spark profiler' });
    // The hub puts the output on the stream too, just before it answers: that copy is the one shown.
    events.push(2, { serverId: 'gtnh', type: 'console', command: 'spark profiler', by: 'web:alex (5)', output: ['Profiler started'] });
    req.flush({ output: ['Profiler started'] });
    await render();
    expect(el.querySelector<HTMLInputElement>('[data-console-form] input')!.value).toBe('');
    events.push(3, { serverId: 'gtnh', type: 'console', command: 'spark profiler', by: 'web:alex (5)', output: ['https://spark.lucko.me/abc'], late: true });
    await render();
    expect(entries(el)).toEqual([
      '> list | discord:bob (2) | 1 player online',
      '> spark profiler | web:alex (5) | Profiler started',
      '> spark profiler (later) | web:alex (5) | https://spark.lucko.me/abc',
    ]);
  });

  it('explains offline, timed out and empty commands', async () => {
    const { backend, el, render } = await setup('/gtnh/console');
    const alert = () => el.querySelector('[role=alert]')?.textContent?.trim();
    for (const [status, body, shown] of [
      [409, 'GTNH is offline', 'GTNH is offline: the command wasn\'t run.'],
      [502, 'Command timed out', 'No answer from GTNH: Command timed out'],
      [400, 'Give a command', 'Give a command.'],
      [400, 'A Factorio console command is at most 256 characters', 'A Factorio console command is at most 256 characters.'], // the hub's why
    ] as const) {
      submit(el, 'list');
      backend.expectOne('/api/servers/gtnh/command').flush(body, { status, statusText: 'Error' });
      await render();
      expect(alert()).toBe(shown);
    }
  });

  describe('history and saved commands', () => {
    const KEY = 'orrery.console.gtnh';
    const box = (el: HTMLElement) => el.querySelector<HTMLInputElement>('[data-console-form] input')!;
    const key = (el: HTMLElement, k: 'ArrowUp' | 'ArrowDown') => (box(el).dispatchEvent(new KeyboardEvent('keydown', { key: k })), box(el).value);
    const ran = async (s: Awaited<ReturnType<typeof setup>>, command: string, status = 200) => {
      submit(s.el, command);
      const req = s.backend.expectOne('/api/servers/gtnh/command');
      if (status === 200) req.flush({ output: [] });
      else req.flush('no', { status, statusText: 'Error' });
      await s.render();
    };
    const stored = () => JSON.parse(localStorage.getItem(KEY) ?? 'null');
    const chips = (el: HTMLElement) => [...el.querySelectorAll('[data-chip]')].map((c) => c.textContent?.trim());
    beforeEach(() => localStorage.clear());
    afterEach(() => (vi.restoreAllMocks(), localStorage.clear()));

    it('steps through the commands run with ↑/↓, dropping repeats, and ↓ past the newest restores the draft', async () => {
      const s = await setup('/gtnh/console');
      for (const c of ['list', 'forge tps', 'forge tps', 'spark tps']) await ran(s, c);
      expect(stored().history).toEqual(['list', 'forge tps', 'spark tps']);
      expect(key(s.el, 'ArrowDown')).toBe('');
      box(s.el).value = 'say hi';
      expect([key(s.el, 'ArrowUp'), key(s.el, 'ArrowUp'), key(s.el, 'ArrowUp'), key(s.el, 'ArrowUp')]).toEqual(['spark tps', 'forge tps', 'list', 'list']);
      expect([key(s.el, 'ArrowDown'), key(s.el, 'ArrowDown'), key(s.el, 'ArrowDown'), key(s.el, 'ArrowDown')]).toEqual(['forge tps', 'spark tps', 'say hi', 'say hi']);
    });

    it('keeps the last 50, and remembers them across a reload', async () => {
      localStorage.setItem(KEY, JSON.stringify({ history: Array.from({ length: 50 }, (_, i) => `c${i}`), saved: [] }));
      const s = await setup('/gtnh/console');
      expect(key(s.el, 'ArrowUp')).toBe('c49');
      await ran(s, 'list');
      expect(stored().history).toHaveLength(50);
      expect(stored().history[0]).toBe('c1');
      expect(stored().history.at(-1)).toBe('list');
    });

    it('records no command the hub refused', async () => {
      const s = await setup('/gtnh/console');
      await ran(s, 'list', 409);
      await ran(s, 'nonsense', 400);
      expect(stored()).toBeNull();
      expect(key(s.el, 'ArrowUp')).toBe('nonsense'); // still in the box, not from the history
      box(s.el).value = '';
      expect(key(s.el, 'ArrowUp')).toBe('');
    });

    it('saves the box\'s command as a chip that runs it, and removes it with its close button', async () => {
      const s = await setup('/gtnh/console');
      box(s.el).value = ' spark tps ';
      s.el.querySelector<HTMLButtonElement>('[data-save]')!.click();
      s.el.querySelector<HTMLButtonElement>('[data-save]')!.click();
      await s.render();
      expect(chips(s.el)).toEqual(['spark tps']);
      expect(stored().saved).toEqual(['spark tps']);
      s.el.querySelector<HTMLButtonElement>('[data-chip]')!.click();
      await s.render();
      expect(s.el.querySelector<HTMLButtonElement>('[data-chip]')!.disabled).toBe(true);
      const req = s.backend.expectOne('/api/servers/gtnh/command');
      expect(req.request.body).toEqual({ command: 'spark tps' });
      req.flush({ output: [] });
      await s.render();
      expect(stored().history).toEqual(['spark tps']);
      s.el.querySelector<HTMLButtonElement>('[data-unsave]')!.click();
      await s.render();
      expect(chips(s.el)).toEqual([]);
      expect(stored().saved).toEqual([]);
    });

    it('still works when storage throws: the history lasts until a reload and there is no Save command', async () => {
      vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
        throw new Error('blocked');
      });
      const s = await setup('/gtnh/console');
      expect(s.el.querySelector('[data-save]')).toBeNull();
      await ran(s, 'list');
      expect(key(s.el, 'ArrowUp')).toBe('list');
    });
  });

  it("runs a factorio server's command as typed, its leading / included", async () => {
    const { backend, el, tabs } = await setup('/space/console', FACTORIO);
    expect(tabs()).toContain('Console');
    expect(el.querySelector<HTMLInputElement>('[data-console-form] input')!.placeholder).toBe('A console command, e.g. /players');
    submit(el, '/players');
    expect(backend.expectOne('/api/servers/space/command').request.body).toEqual({ command: '/players' });
  });

  it('has no Console section for a server without the mod', async () => {
    const { el, tabs } = await setup('/site/console', NO_MOD);
    expect(tabs()).not.toContain('Console');
    expect(el.querySelector('[data-console-form]')).toBeNull();
  });
});

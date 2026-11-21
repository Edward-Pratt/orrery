import { TestBed } from '@angular/core/testing';
import type { ServerHistory } from '@hub/api';
import { FACTORIO, NO_MOD, setup } from './server.testing';

const HISTORY: ServerHistory = {
  tps: [{ ts: 1, tps: 19.5 }, { ts: 2, tps: 12 }],
  players: [{ ts: 0, count: 0 }, { ts: 1, count: 1 }, { ts: 3, count: 1 }],
  uptime: [{ ts: 0, state: 'unknown' }, { ts: 1, state: 'up' }, { ts: 2, state: 'hung' }],
  asOf: 10,
};

describe('server history section', () => {
  it('graphs TPS, players and uptime for the last 24 hours, then the chosen period', async () => {
    const { backend, el, render, chart, tabs } = await setup('/gtnh/history');
    expect(tabs()).toContain('History');
    backend.expectOne('/api/servers/gtnh/history?hours=24').flush(HISTORY);
    await render();
    expect(chart('TPS')).toEqual([['TPS', [[1, 19.5], [2, 12]]]]);
    expect(chart('Players')).toEqual([['Players', [[0, 0], [1, 1], [3, 1]]]]);
    // Up 1, hung 0.5, down 0, unknown a gap; the last state lasts until now.
    const [[, uptime]] = chart('Uptime')! as [string, [number, number][]][];
    expect(uptime.slice(0, 3)).toEqual([[0, NaN], [1, 1], [2, 0.5]]);
    expect(uptime.at(-1)![1]).toBe(0.5);

    [...el.querySelectorAll<HTMLButtonElement>('[data-period]')].find((b) => b.textContent?.trim() === '7 d')!.click();
    await render();
    backend.expectOne('/api/servers/gtnh/history?hours=168').flush({ ...HISTORY, tps: [] });
    await render();
    expect(chart('TPS')).toEqual([['TPS', []]]);
  });

  it('extends the graphs from live events newer than the history, ignoring the replay it already holds', async () => {
    const { backend, events, render, chart } = await setup('/gtnh/history');
    events.push(9, { serverId: 'gtnh', type: 'join', player: 'Old' }); // counted in the history already
    backend.expectOne('/api/servers/gtnh/history?hours=24').flush(HISTORY);
    events.push(10, { serverId: 'gtnh', type: 'tps', tps: 19 });
    events.push(11, { serverId: 'gtnh', type: 'tps', tps: 18 });
    events.push(12, { serverId: 'gtnh', type: 'join', player: 'Alex' });
    events.push(13, { serverId: 'other', type: 'join', player: 'Elsewhere' });
    events.push(14, { serverId: 'gtnh', type: 'recovered' });
    events.push(15, { serverId: 'gtnh', type: 'leave', player: 'Steve' });
    events.push(16, { serverId: 'gtnh', type: 'crashed' });
    await render();
    const values = (title: string) => (chart(title)![0]![1] as [number, number][]).map((p) => p[1]);
    expect(values('TPS')).toEqual([19.5, 12, 18]);
    expect(values('Players')).toEqual([0, 1, 1, 2, 1, 0]);
    expect(values('Uptime')).toEqual([NaN, 1, 0.5, 1, 0, 0]);
    backend.expectNone('/api/servers/gtnh/history?hours=24');
  });

  it("graphs a factorio server's UPS out of 60", async () => {
    const { backend, render, chart, chartMax } = await setup('/space/history', FACTORIO);
    backend.expectOne('/api/servers/space/history?hours=24').flush(HISTORY);
    await render();
    expect(chart('UPS')).toEqual([['UPS', [[1, 19.5], [2, 12]]]]);
    expect(chartMax('UPS')).toBe(60);
    expect(chart('TPS')).toBeUndefined();
  });

  it("shows a factorio server's last 24 h of UPS on the overview", async () => {
    const { backend, render, chart, chartMax } = await setup('/space', FACTORIO);
    backend.expectOne('/api/servers/space/history?hours=24').flush(HISTORY);
    await render();
    expect(chart('UPS')).toEqual([['UPS', [[1, 19.5], [2, 12]]]]);
    expect(chartMax('UPS')).toBe(60);
  });

  it("leaves uptime a gap and clears the players once a server's Agent left (lost)", async () => {
    const { backend, events, render, chart } = await setup('/space/history', FACTORIO);
    backend.expectOne('/api/servers/space/history?hours=24').flush(HISTORY);
    events.push(11, { serverId: 'space', type: 'join', player: 'alice' });
    events.push(12, { serverId: 'space', type: 'lost' });
    await render();
    const values = (title: string) => (chart(title)![0]![1] as [number, number][]).map((p) => p[1]);
    expect(values('Players')).toEqual([0, 1, 1, 2, 0]);
    expect(values('Uptime')).toEqual([NaN, 1, 0.5, NaN, NaN]); // unknown, as the hub records it, until now
  });

  it("shows Paused beside a paused factorio server's UPS, in History and on the overview", async () => {
    const paused = { ...FACTORIO, paused: true };
    const history = await setup('/space/history', paused);
    history.backend.expectOne('/api/servers/space/history?hours=24').flush(HISTORY);
    await history.render();
    expect(history.text(history.el.querySelector('[data-chart=UPS] h2'))).toBe('UPS Paused');
    expect(history.el.querySelectorAll('[data-paused]')).toHaveLength(1);
    TestBed.resetTestingModule();

    const overview = await setup('/space', paused);
    overview.backend.expectOne('/api/servers/space/history?hours=24').flush(HISTORY);
    await overview.render();
    expect(overview.text(overview.el.querySelector('[data-chart=UPS] h2'))).toBe('UPS 24 h · Paused');
    TestBed.resetTestingModule();

    const running = await setup('/space', FACTORIO);
    running.backend.expectOne('/api/servers/space/history?hours=24').flush(HISTORY);
    await running.render();
    expect(running.text(running.el.querySelector('[data-chart=UPS] h2'))).toBe('UPS 24 h');
  });

  it('has no TPS graph without the mod', async () => {
    const { backend, render, chart } = await setup('/site/history', NO_MOD);
    backend.expectOne('/api/servers/site/history?hours=24').flush({ ...HISTORY, tps: null });
    await render();
    expect(chart('TPS')).toBeUndefined();
    expect(chart('Players')).toBeDefined();
  });
});

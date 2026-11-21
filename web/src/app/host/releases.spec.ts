import type { DeploysAnswer, Release } from '@hub/api';
import { dialog, dialogButton } from '../testing';
import { ON, SAMPLE, setup } from './host-testing';

const DAY = 24 * 60 * 60_000;
const rel = (tag: string, daysAgo = 1): Release => ({ tag, publishedAt: Date.now() - daysAgo * DAY, assets: [] });
const ANSWER: DeploysAnswer = {
  hub: { running: 'hub-v2.5.0', latest: 'hub-v2.6.0', releases: [rel('hub-v2.6.0'), rel('hub-v2.5.0'), rel('hub-v2.4.0')] },
  web: { running: 'web-v0.5.0', latest: 'web-v0.5.0', releases: [rel('web-v0.5.0'), rel('web-v0.4.1')] },
  mod: { latest: 'mod-v1.4.0', releases: [rel('mod-v1.4.0'), rel('mod-v1.3.0')], servers: [{ id: 'gtnh', name: 'GTNH', running: 'mod-v1.3.0' }] },
  agent: { latest: null, releases: [], hosts: [] },
  checkedAt: Date.now(),
  error: null,
  newerAfterDays: 14,
  history: [{ id: 1, part: 'web', target: 'production', from: 'web-v0.4.1', to: 'web-v0.5.0', by: 'web:alex (5)', started: 1, finished: 2, outcome: 'ok', log: 'installed' }],
  older: false,
  packing: [],
};

describe('host page releases', () => {
  async function releases(answer: DeploysAnswer = ANSWER) {
    const h = await setup(SAMPLE, true, { ...ON, github: true, agents: false, library: false });
    h.backend.expectOne('/api/hosts/oracle/samples?hours=24').flush([]);
    await h.render();
    h.backend.expectOne('/api/deploys').flush(answer);
    await h.render();
    const row = (key: string) => h.el.querySelector<HTMLElement>(`[data-row="${key}"]`)!;
    const rowText = (key: string) => row(key).textContent!.replace(/\s+/g, ' ').trim();
    /** Opens a row's picker, picks `tag` (else the preselected latest) and asks to deploy. */
    const deploy = async (key: string, tag?: string) => {
      row(key).querySelector<HTMLButtonElement>('[data-deploy]')!.click();
      await h.render();
      const select = row(key).querySelector<HTMLSelectElement>('[data-pick]')!;
      if (tag) {
        select.value = tag;
        select.dispatchEvent(new Event('change'));
        await h.render();
      }
      row(key).querySelector<HTMLButtonElement>('[data-next]')!.click();
      await h.render();
      return select;
    };
    return { ...h, row, rowText, deploy };
  }

  afterEach(() => dialog() && dialogButton('cancel').click());

  it('shows running against latest for the hub, the dashboard and each Mod, with a badge when newer', async () => {
    const { row, text, el } = await releases();
    const shown = (key: string) => ['[data-running]', '[data-latest]', '[data-newer]'].map((sel) => row(key).querySelector(sel)?.textContent?.trim());
    expect(shown('hub')).toEqual(['hub-v2.5.0', 'hub-v2.6.0', 'newer available']);
    expect(shown('web')).toEqual(['web-v0.5.0', 'web-v0.5.0', undefined]);
    expect(shown('mod:gtnh')).toEqual(['mod-v1.3.0', 'mod-v1.4.0', 'newer available']);
    expect(text('[data-row="mod:gtnh"] span')).toBe('Mod on GTNH');
    expect(text('[data-history] [data-outcome]')).toBe('ok');
    expect(el.querySelector('[data-history]')!.textContent).toContain('web-v0.4.1 → web-v0.5.0');
    expect(text('[data-log]')).toBe('installed');
  });

  it('a dev hub has no badge, and a failed check shows its error', async () => {
    const { row, text } = await releases({ ...ANSWER, hub: { ...ANSWER.hub, running: 'dev' }, error: 'GitHub: HTTP 503' });
    expect(row('hub').querySelector('[data-newer]')).toBeNull();
    expect(text('[data-error]')).toBe('Last check failed: GitHub: HTTP 503');
  });

  it('Deploy picks the latest, marks older releases, names the change and posts once confirmed', async () => {
    const { deploy, backend, render } = await releases();
    const select = await deploy('hub');
    expect([...select.options].map((o) => o.textContent)).toEqual(['hub-v2.6.0', 'hub-v2.5.0 (running)', 'hub-v2.4.0 (older)']);
    expect(dialog()!.textContent).toContain('Deploy hub v2.5.0 → v2.6.0?');
    dialogButton('ok').click();
    await render();
    const req = backend.expectOne('/api/deploys');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ part: 'hub', tag: 'hub-v2.6.0' });
  });

  it('going back says so', async () => {
    const { deploy } = await releases();
    await deploy('hub', 'hub-v2.4.0');
    expect(dialog()!.textContent).toContain('Deploy hub v2.5.0 → v2.4.0 (older release)?');
  });

  it('the dashboard posts its part, a Mod its server', async () => {
    const { deploy, backend, render } = await releases();
    await deploy('web', 'web-v0.4.1');
    dialogButton('ok').click();
    await render();
    const web = backend.expectOne((r) => r.method === 'POST' && r.url === '/api/deploys');
    expect(web.request.body).toEqual({ part: 'web', tag: 'web-v0.4.1' });
    web.flush({ id: 2 });
    backend.expectOne('/api/deploys').flush(ANSWER);
    await new Promise((r) => setTimeout(r, 350)); // the first dialog has gone
    await render();
    await deploy('mod:gtnh');
    dialogButton('ok').click();
    await render();
    expect(backend.match((r) => r.method === 'POST' && r.url === '/api/deploys').map((r) => r.request.body)).toEqual([{ part: 'mod', tag: 'mod-v1.4.0', server: 'gtnh' }]);
  });

  it('a running deploy spins on its row, and a live deployFinished brings the outcome', async () => {
    const running = { ...ANSWER.history[0]!, id: 2, part: 'hub' as const, from: 'hub-v2.5.0', to: 'hub-v2.6.0', finished: null, outcome: 'running' as const, log: '' };
    const { events, backend, render, rowText, row, el } = await releases({ ...ANSWER, history: [running, ...ANSWER.history] });
    expect(rowText('hub')).toContain('deploying hub-v2.6.0');
    expect(row('web').querySelector('[data-deploy]')!.hasAttribute('disabled')).toBe(true);
    const finished = { target: 'deploy', id: 'production', type: 'notice', severity: 'good', kind: 'deployFinished', part: 'hub', from: 'hub-v2.5.0', to: 'hub-v2.6.0', outcome: 'ok' } as const;
    events.push(1, finished);
    await new Promise((r) => setTimeout(r, 80));
    backend.expectOne('/api/deploys').flush({ ...ANSWER, hub: { ...ANSWER.hub, running: 'hub-v2.6.0' }, history: [{ ...running, outcome: 'ok', log: 'stayed up' }, ...ANSWER.history] });
    await render();
    expect(row('hub').querySelector('[data-running]')!.textContent).toBe('hub-v2.6.0');
    expect(row('hub').querySelector('[data-newer]')).toBeNull();
    expect(el.querySelector('[data-history] [data-outcome]')!.textContent!.trim()).toBe('ok');
  });

  it('Check now asks the hub to look again', async () => {
    const { el, backend, render, rowText } = await releases();
    el.querySelector<HTMLButtonElement>('[data-check]')!.click();
    const req = backend.expectOne('/api/deploys/check');
    expect(req.request.method).toBe('POST');
    req.flush({ ...ANSWER, web: { ...ANSWER.web, latest: 'web-v0.6.0', releases: [rel('web-v0.6.0', 0), ...ANSWER.web.releases] } });
    await render();
    expect(rowText('web')).toContain('newer available');
  });

  it('no Mod deploy onto a server while a pack update runs on it, and no hub deploy meanwhile', async () => {
    const { row } = await releases({ ...ANSWER, packing: ['gtnh'] });
    expect(row('mod:gtnh').querySelector<HTMLButtonElement>('[data-deploy]')!.disabled).toBe(true);
    expect(row('mod:gtnh').querySelector('[data-why]')?.textContent?.trim()).toBe('A pack update is running on GTNH.');
    expect(row('hub').querySelector<HTMLButtonElement>('[data-deploy]')!.disabled).toBe(true);
    expect(row('hub').querySelector('[data-why]')?.textContent?.trim()).toBe('A pack or game update is running.');
    expect(row('web').querySelector<HTMLButtonElement>('[data-deploy]')!.disabled).toBe(false);
  });

  it("still deploys from a hub below release 1: no /api/hosts, and an answer with no agent part", async () => {
    const h = await setup(SAMPLE, false, { ...ON, github: true, agents: false, library: false });
    h.backend.expectOne('/api/hosts').flush('Not Found', { status: 404, statusText: 'Not Found' }); // it serves /api/host
    await h.render();
    const { agent: _, ...older } = ANSWER;
    h.backend.expectOne('/api/deploys').flush(older);
    await h.render();
    const row = (key: string) => h.el.querySelector<HTMLElement>(`[data-row="${key}"]`)!;
    expect([...h.el.querySelectorAll('[data-row]')].map((r) => r.getAttribute('data-row'))).toEqual(['hub', 'web', 'mod:gtnh']);
    expect(row('hub').querySelector<HTMLButtonElement>('[data-deploy]')!.disabled).toBe(false); // rolled forward from here
    // Or the dashboard back, to one that reads the older hub's API.
    row('web').querySelector<HTMLButtonElement>('[data-deploy]')!.click();
    await h.render();
    const select = row('web').querySelector<HTMLSelectElement>('[data-pick]')!;
    select.value = 'web-v0.4.1';
    select.dispatchEvent(new Event('change'));
    await h.render();
    row('web').querySelector<HTMLButtonElement>('[data-next]')!.click();
    await h.render();
    dialogButton('ok').click();
    await h.render();
    expect(h.backend.expectOne((r) => r.method === 'POST' && r.url === '/api/deploys').request.body).toEqual({ part: 'web', tag: 'web-v0.4.1' });
  });

  const AGENTS: DeploysAnswer = {
    ...ANSWER,
    agent: {
      latest: 'agent-v1.1.0',
      releases: [rel('agent-v1.1.0'), rel('agent-v1.0.0')],
      hosts: [
        { id: 'vm', name: 'Friend VM', server: 'space', running: 'agent-v1.0.0' },
        { id: 'pi', name: 'Pi', server: 'tiny', running: null },
      ],
    },
  };

  it("shows a row per Host's Agent; its Deploy names the Agent and posts its part with the Host", async () => {
    const { row, rowText, deploy, backend, render } = await releases(AGENTS);
    const shown = (key: string) => ['[data-running]', '[data-latest]', '[data-newer]'].map((sel) => row(key).querySelector(sel)?.textContent?.trim());
    expect(shown('agent:vm')).toEqual(['agent-v1.0.0', 'agent-v1.1.0', 'newer available']);
    expect(shown('agent:pi')).toEqual(['unknown', 'agent-v1.1.0', undefined]); // never connected
    expect(rowText('agent:vm')).toContain('Agent on Friend VM');
    const select = await deploy('agent:vm');
    expect([...select.options].map((o) => o.textContent)).toEqual(['agent-v1.1.0', 'agent-v1.0.0 (running)']);
    expect(dialog()!.textContent).toContain('Deploy Agent on Friend VM v1.0.0 → v1.1.0?');
    dialogButton('ok').click();
    await render();
    const req = backend.expectOne((r) => r.method === 'POST' && r.url === '/api/deploys');
    expect(req.request.body).toEqual({ part: 'agent', tag: 'agent-v1.1.0', host: 'vm' });
  });

  it("no Agent deploy while a game update runs on its server; another Host's Agent can deploy", async () => {
    const { row } = await releases({ ...AGENTS, packing: ['space'] });
    expect(row('agent:vm').querySelector<HTMLButtonElement>('[data-deploy]')!.disabled).toBe(true);
    expect(row('agent:vm').querySelector('[data-why]')?.textContent?.trim()).toBe('A game update is running on space.');
    expect(row('agent:pi').querySelector<HTMLButtonElement>('[data-deploy]')!.disabled).toBe(false);
    expect(row('hub').querySelector('[data-why]')?.textContent?.trim()).toBe('A pack or game update is running.');
  });

  it("a running Agent deploy spins on its own Host's row, and the history names the Agent", async () => {
    const running = { id: 3, part: 'agent' as const, target: 'vm', from: 'agent-v1.0.0', to: 'agent-v1.1.0', by: 'web:alex (5)', started: 1, finished: null, outcome: 'running' as const, log: '' };
    const { rowText, row, el } = await releases({ ...AGENTS, history: [running, ...ANSWER.history] });
    expect(rowText('agent:vm')).toContain('deploying agent-v1.1.0');
    expect(row('agent:pi').querySelector('[data-deploying]')).toBeNull();
    expect(row('agent:pi').querySelector<HTMLButtonElement>('[data-deploy]')!.disabled).toBe(true); // one deploy at a time
    expect(el.querySelector('[data-deploy-row="3"]')!.textContent).toContain('Agent on vm: agent-v1.0.0 → agent-v1.1.0');
  });

  it('has no section with the GitHub integration off', async () => {
    const { el, backend, render } = await setup();
    backend.expectOne('/api/hosts/oracle/samples?hours=24').flush([]);
    await render();
    expect(el.querySelector('[data-releases]')).toBeNull();
    backend.verify();
  });
});

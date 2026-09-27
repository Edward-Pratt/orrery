import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { ServiceStatus } from '@hub/api';
import { settle } from '../testing';
import { ServiceActions } from './actions';

const GTNH: ServiceStatus = { id: 'gtnh', unit: 'gtnh.service', state: 'active', sub: 'running', checks: [] };

async function setup() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  const fixture = TestBed.createComponent(ServiceActions);
  fixture.componentRef.setInput('service', GTNH);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const click = (verb: string) => el.querySelector<HTMLButtonElement>(`[data-action=${verb}]`)!.click();
  const render = async () => (await settle(), await fixture.whenStable());
  return { backend: TestBed.inject(HttpTestingController), el, click, render };
}

describe('service actions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('calls the API only after confirmation', async () => {
    const { backend, el, click, render } = await setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    click('stop');
    expect(confirm).toHaveBeenCalledWith('Stop gtnh.service?');
    backend.expectNone('/api/services/gtnh/stop');

    confirm.mockReturnValue(true);
    click('restart');
    const req = backend.expectOne('/api/services/gtnh/restart');
    expect(req.request.method).toBe('POST');
    expect(req.request.detectContentTypeHeader()).toBe('application/json');
    req.flush({ at: null });
    await render();
    expect(el.querySelector('[data-result]')?.textContent?.trim()).toBe('Restart sent to gtnh.service.');
  });

  it('says when a countdown runs first, and shows a failure', async () => {
    const { backend, el, click, render } = await setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    click('stop');
    backend.expectOne('/api/services/gtnh/stop').flush({ at: new Date(2026, 8, 27, 12, 5, 0).getTime() });
    await render();
    expect(el.querySelector('[data-result]')?.textContent).toContain('it happens at 12:05:00');
    click('start');
    backend.expectOne('/api/services/gtnh/start').flush('systemctl failed: permission denied', { status: 502, statusText: 'Bad Gateway' });
    await render();
    expect(el.querySelector('[role=alert]')?.textContent?.trim()).toBe('Start failed (HTTP 502): systemctl failed: permission denied');
  });
});

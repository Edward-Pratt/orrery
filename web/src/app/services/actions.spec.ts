import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ServiceStatus } from '@hub/api';
import { HlmToaster } from '@spartan-ng/helm/sonner';
import { dialog, dialogButton, settle, toasts } from '../testing';
import { ServiceActions } from './actions';

const GTNH: ServiceStatus = { id: 'gtnh', unit: 'gtnh.service', state: 'active', sub: 'running', checks: [] };

@Component({ imports: [HlmToaster, ServiceActions], template: `<hlm-toaster /><app-service-actions [service]="service" />` })
class Page {
  service = GTNH;
}

async function setup() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  const fixture = TestBed.createComponent(Page);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const button = (verb: string) => el.querySelector<HTMLButtonElement>(`[data-action=${verb}]`)!;
  const render = async () => (await settle(), fixture.detectChanges(), await fixture.whenStable(), await settle());
  return { backend: TestBed.inject(HttpTestingController), button, render };
}

describe('service actions', () => {
  afterEach(() => {
    document.querySelectorAll('[data-sonner-toaster], .cdk-overlay-container > *').forEach((n) => n.remove());
  });

  it('sends nothing until the dialog naming the target is confirmed', async () => {
    const { backend, button, render } = await setup();
    button('stop').click();
    await render();
    expect(dialog()?.textContent).toContain('Stop gtnh.service?');
    expect(dialogButton('ok').textContent?.trim()).toBe('Stop gtnh.service');
    backend.expectNone('/api/services/gtnh/stop');
    dialogButton('cancel').click();
    await render();
    backend.expectNone('/api/services/gtnh/stop');
    expect(dialog()).toBeNull();

    button('restart').click();
    await render();
    dialogButton('ok').click();
    await render();
    const req = backend.expectOne('/api/services/gtnh/restart');
    expect(req.request.method).toBe('POST');
    expect(req.request.detectContentTypeHeader()).toBe('application/json');
    req.flush({ at: null });
    await render();
    expect(toasts()).toEqual(['Restart sent to gtnh.service.']);
  });

  it('starts without asking, and disables the buttons while the request is pending', async () => {
    const { backend, button, render } = await setup();
    button('start').click();
    await render();
    expect(dialog()).toBeNull();
    expect(button('start').disabled).toBe(true);
    expect(button('stop').disabled).toBe(true);
    button('start').click();
    const req = backend.expectOne('/api/services/gtnh/start');
    req.flush({ at: null });
    await render();
    expect(button('start').disabled).toBe(false);
  });

  it("toasts a failure with the hub's message, and it stays", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { backend, button, render } = await setup();
      button('start').click();
      backend.expectOne('/api/services/gtnh/start').flush('systemctl failed: permission denied', { status: 502, statusText: 'Bad Gateway' });
      await render();
      expect(toasts()[0]).toContain('Start of gtnh.service failed: systemctl failed: permission denied');
      vi.advanceTimersByTime(60_000);
      await render();
      expect(toasts()[0]).toContain('permission denied');
    } finally {
      vi.useRealTimers();
    }
  });
});

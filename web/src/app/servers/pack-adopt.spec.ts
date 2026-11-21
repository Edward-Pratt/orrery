import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { CompareReport } from '@hub/api';
import { FETCH } from '../events';
import { dialog, fakeEvents, loggedIn, settle } from '../testing';
import { DETAIL, EMPTY, INSTALLED, setup } from './pack.testing';
import routes from './routes';

describe('server pack tab', () => {
  it('appears last, only for a server that can have a pack, in a tab row that scrolls on a phone', async () => {
    const { el, text } = await setup();
    const tabs = [...el.querySelectorAll('[data-sections] a')].map(text);
    expect(tabs.at(-1)).toBe('Pack');
    expect(el.querySelector('[data-sections]')!.className).toContain('overflow-x-auto');
    TestBed.resetTestingModule();
    const events = fakeEvents();
    TestBed.configureTestingModule({ providers: [loggedIn(), provideRouter(routes), provideHttpClient(), provideHttpClientTesting(), { provide: FETCH, useValue: events.fetch }] });
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl('/gtnh');
    TestBed.inject(HttpTestingController).expectOne('/api/servers/gtnh').flush({ ...DETAIL, pack: false });
    await settle();
    harness.fixture.detectChanges();
    expect([...(harness.routeNativeElement as HTMLElement).querySelectorAll('[data-sections] a')].map((a) => a.textContent?.trim())).not.toContain('Pack');
  });

  it('starts with Adopt, the Kept path chips (this server first) and an empty history', async () => {
    const { el, text } = await setup(EMPTY);
    expect(text(el.querySelector('[data-adopt]'))).toContain("orrery doesn't know this server's pack yet");
    expect([...el.querySelectorAll('[data-kept-server]')].map(text)).toEqual(['config/JourneyMapServer', 'journeymap/']);
    expect([...el.querySelectorAll('[data-kept-builtin]')].map(text)).toEqual(['World/', 'server.properties', 'logs/']);
    expect(text(el.querySelector('[data-kept]'))).toContain('config.json');
    expect(el.querySelector('[data-no-history]')).not.toBeNull();
    expect(el.querySelector('[data-summary]')).toBeNull();
  });

  it('adopts: a version picked from the library, Compare, the report with keep boxes, then the summary card', async () => {
    const { el, q, text, render, backend, pick, library } = await setup(EMPTY);
    await library();
    expect([...el.querySelectorAll('[data-pick] option')].map(text)).toEqual(['Choose a version…', 'GT New Horizons 2.7.5 · Minecraft 1.7.10', 'GT New Horizons 2.7.4 · Minecraft 1.7.10']);
    expect(q<HTMLButtonElement>('[data-compare]').disabled).toBe(true);
    await pick(1);
    q('[data-compare]').click();
    await render();
    const compare = backend.expectOne('/api/servers/gtnh/pack/compare');
    expect(compare.request.body).toEqual({ library: 1 });
    const report: CompareReport = {
      name: 'GT New Horizons',
      version: '2.7.4',
      matching: 2241,
      mod: ['mods/gtnhdiscord-1.4.0.jar'],
      notInPack: [
        { path: 'config/custom.cfg', size: 14 },
        { path: 'mods/journeymap-fairplay.jar', size: 2_000_000 },
      ],
      different: [{ path: 'config/forge.cfg', size: 2048 }],
    };
    compare.flush(report);
    await render();
    expect(text(el.querySelector('[data-matching]'))).toContain('2,241 files match the pack');
    expect(text(el.querySelector('[data-report-mod]'))).toContain('mods/gtnhdiscord-1.4.0.jar');
    expect(el.querySelector('[data-report-mod] input')).toBeNull(); // locked
    expect(text(el.querySelector('[data-report]'))).toContain('a Config edit is better');
    expect(text(q('[data-adopt-keep]'))).toBe('Adopt, keep 0 files'); // nothing ticked to start
    expect([...el.querySelectorAll<HTMLInputElement>('[data-report] input[type=checkbox]')].some((i) => i.checked)).toBe(false);
    el.querySelector<HTMLInputElement>('[data-group=different] input')!.click();
    await render();
    el.querySelectorAll<HTMLInputElement>('[data-group=notInPack] input')[1]!.click();
    await render();
    expect(text(q('[data-adopt-keep]'))).toBe('Adopt, keep 2 files');
    q('[data-adopt-keep]').click();
    await render();
    expect(dialog()).toBeNull(); // no confirm: nothing on disk changes
    const adopt = backend.expectOne('/api/servers/gtnh/pack/adopt');
    expect(new Set(adopt.request.body.keep)).toEqual(new Set(['mods/journeymap-fairplay.jar', 'config/forge.cfg']));
    adopt.flush(INSTALLED);
    await render();
    expect(text(el.querySelector('[data-installed]'))).toBe('GT New Horizons 2.7.4');
    expect(text(el.querySelector('[data-installed-by]'))).toContain('adopted by alex');
    expect(el.querySelector<HTMLAnchorElement>('[data-installed-by] a')!.href).toBe(INSTALLED.installed!.source);
    expect(text(el.querySelector('[data-installed-by]'))).toContain('sha256 9f2c1e012345…');
  });

  it('links to the Library page, and says so when the library is empty', async () => {
    const { el, library } = await setup(EMPTY);
    await library({ packs: [], runtimes: [], running: null });
    expect(el.querySelector('[data-pick]')).toBeNull();
    expect(el.querySelector('[data-library-empty]')).not.toBeNull();
    expect(el.querySelector<HTMLAnchorElement>('[data-library-link]')!.getAttribute('href')).toBe('/library');
    expect(el.querySelector('[data-url]')).toBeNull(); // no URL or upload: the library is the only way in
  });
});

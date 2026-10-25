import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, withNavigationErrorHandler } from '@angular/router';
import { RELOAD, reloadOnStaleBuild } from './reload';

@Component({ template: 'ok' })
class Ok {}

/** A router whose `/gone` page fails to load with `error`, as a deleted chunk does. */
function setup(error: Error) {
  const reload = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideRouter(
        [
          { path: '', component: Ok },
          { path: 'gone', loadComponent: () => Promise.reject(error) },
        ],
        withNavigationErrorHandler(reloadOnStaleBuild),
      ),
      { provide: RELOAD, useValue: reload },
    ],
  });
  return { router: TestBed.inject(Router), reload };
}

const STALE = new TypeError('Failed to fetch dynamically imported module: https://dash.orrery.run/chunk-ABC.js');

describe('reloadOnStaleBuild', () => {
  it('loads the link as a whole page when its chunk is gone', async () => {
    const { router, reload } = setup(STALE);
    await router.navigateByUrl('/');
    await router.navigateByUrl('/gone?x=1').catch(() => {});
    expect(reload).toHaveBeenCalledWith('/gone?x=1');
  });

  it('does the same for a lazy route of child routes', async () => {
    const reload = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            { path: '', component: Ok },
            { path: 'gone', loadChildren: () => Promise.reject(STALE) },
          ],
          withNavigationErrorHandler(reloadOnStaleBuild),
        ),
        { provide: RELOAD, useValue: reload },
      ],
    });
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');
    await router.navigateByUrl('/gone/x').catch(() => {});
    expect(reload).toHaveBeenCalledWith('/gone/x');
  });

  it('knows Firefox and Safari words too', async () => {
    for (const message of ['error loading dynamically imported module', 'Importing a module script failed.']) {
      TestBed.resetTestingModule();
      const { router, reload } = setup(new TypeError(message));
      await router.navigateByUrl('/');
      await router.navigateByUrl('/gone').catch(() => {});
      expect(reload).toHaveBeenCalledWith('/gone');
    }
  });

  it('leaves other errors to the router', async () => {
    const { router, reload } = setup(new Error('a bug'));
    await router.navigateByUrl('/');
    await router.navigateByUrl('/gone').catch(() => {});
    expect(reload).not.toHaveBeenCalled();
  });

  it('never reloads on the first navigation: that page is the new build already', async () => {
    const { router, reload } = setup(STALE);
    await router.navigateByUrl('/gone').catch(() => {});
    expect(reload).not.toHaveBeenCalled();
  });
});

import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withNavigationErrorHandler } from '@angular/router';
import { routes } from './app.routes';
import { reloadOnStaleBuild } from './reload';
import { loggedOutOn401 } from './session';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes, withNavigationErrorHandler(reloadOnStaleBuild)),
    provideHttpClient(withFetch(), withInterceptors([loggedOutOn401])),
  ],
};

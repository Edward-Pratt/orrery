import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { isStatusPath, PUBLIC_CONFIG, StatusPage } from './app/public/status-page';

// The Status page boots alone (no shell, no session); every other path is the dashboard.
(isStatusPath(location.pathname) ? bootstrapApplication(StatusPage, PUBLIC_CONFIG) : bootstrapApplication(App, appConfig))
  .catch((err) => console.error(err));

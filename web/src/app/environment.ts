import { HttpClient } from '@angular/common/http';
import { Component, inject, Injectable } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import type { EnvironmentInfo } from '@hub/api';
import { HlmBadge } from '@spartan-ng/helm/badge';
import { catchError, map, of } from 'rxjs';

/** Whether this dashboard's hub is Staging, asked once (no session needed); Production when the hub can't say. */
@Injectable({ providedIn: 'root' })
export class Environment {
  readonly staging = toSignal(
    inject(HttpClient)
      .get<EnvironmentInfo>('/api/environment')
      .pipe(
        map((e) => e.environment === 'staging'),
        catchError(() => of(false)),
      ),
    { initialValue: false },
  );
}

/** "Staging" next to the name on Staging, amber so it can't pass as the brand; nothing on Production. */
@Component({
  selector: 'app-staging-badge',
  imports: [HlmBadge],
  template: `
    @if (env.staging()) {
      <span hlmBadge class="bg-amber-500 text-black" data-staging>Staging</span>
    }
  `,
})
export class StagingBadge {
  protected readonly env = inject(Environment);
}

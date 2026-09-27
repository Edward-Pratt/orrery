import { HttpClient } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { CheckStatus } from '@hub/api';
import { catchError, debounceTime, EMPTY, filter, startWith, switchMap } from 'rxjs';
import { LiveEvents, ofTarget } from '../events';

@Component({
  selector: 'app-checks',
  imports: [RouterLink],
  template: `
    <h1 class="mb-4 text-lg font-semibold">Checks</h1>
    <table class="w-full max-w-3xl text-sm">
      <thead class="text-left text-muted-foreground">
        <tr><th class="py-1 font-normal">Check</th><th class="font-normal">State</th><th class="font-normal">Response</th></tr>
      </thead>
      <tbody>
        @for (c of checks(); track c.id) {
          <tr class="border-t" [attr.data-check]="c.id">
            <td class="py-2">
              <div class="font-medium">{{ c.id }}</div>
              <a class="text-muted-foreground hover:underline" [href]="c.url" target="_blank" rel="noopener">{{ c.url }}</a>
              @if (c.service; as s) {
                <div class="text-muted-foreground" data-service>Service: <a routerLink="/services" [fragment]="s" class="hover:underline">{{ s }}</a></div>
              }
            </td>
            <td data-state [class.text-destructive]="c.up === false">
              {{ c.up === null ? 'Not checked yet' : c.up ? 'Up' : 'Down: ' + c.error }}
            </td>
            <td data-ms>{{ c.ms === null ? '–' : c.ms + ' ms' }}</td>
          </tr>
        } @empty {
          <tr><td class="py-2 text-muted-foreground">No checks.</td></tr>
        }
      </tbody>
    </table>
  `,
})
export default class Checks {
  readonly checks = signal<CheckStatus[]>([]);

  constructor() {
    const http = inject(HttpClient);
    // Fetched again when a check goes down or comes back up (debounced: the replay can hold several).
    inject(LiveEvents)
      .all$.pipe(
        filter(ofTarget('check')),
        debounceTime(50),
        startWith(undefined),
        switchMap(() => http.get<CheckStatus[]>('/api/checks').pipe(catchError(() => EMPTY))),
        takeUntilDestroyed(),
      )
      .subscribe((checks) => this.checks.set(checks));
  }
}

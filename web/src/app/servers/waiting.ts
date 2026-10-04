import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { PendingServers } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCopy } from '@ng-icons/lucide';
import { HlmBadge } from '@spartan-ng/helm/badge';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { firstValueFrom } from 'rxjs';
import { Feedback } from '../feedback';

const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * A Pending server's page (`/servers/waiting/<id>`): installed, waiting for the setup command to run as root. It shows
 * that command with a copy button (after the line that installs the script's root copy, when the hub says it's
 * missing) and Discard (typed id), which deletes the folder and Java link.
 */
@Component({
  selector: 'app-waiting',
  imports: [DatePipe, RouterLink, NgIcon, HlmBadge, HlmButton, HlmSkeleton],
  viewProviders: [provideIcons({ lucideCopy })],
  template: `
    @if (server(); as p) {
      <div class="flex max-w-3xl flex-col gap-4">
        <div class="flex flex-wrap items-center gap-3">
          <h1 class="text-lg font-semibold">{{ p.name }}</h1>
          <span hlmBadge variant="outline" class="border-status-warn/50 text-status-warn" data-badge>Waiting for setup</span>
          <button hlmBtn variant="ghost" size="sm" class="ml-auto text-status-down" [disabled]="busy()" (click)="discard()" data-discard>Discard</button>
        </div>
        <p class="text-sm text-muted-foreground" data-meta>
          <span class="font-mono">{{ p.id }}</span> · port {{ p.gamePort }} · {{ p.runtime ?? 'system java' }} · installed by {{ p.by }}
          {{ p.at | date: 'd MMM y HH:mm' }}
        </p>
        <p class="text-sm">
          Its pack is installed in <code class="break-all">{{ p.dir }}</code>. One step is left: as root on the host, run the setup script. It adds the
          server to config.json, writes its systemd unit, socket and polkit rule, enables them and restarts the hub. Then start the server here.
        </p>
        @for (step of steps(); track step.command) {
          <div class="flex flex-col gap-1" [attr.data-step]="step.what">
            <p class="text-sm font-medium">{{ step.label }}</p>
            <div class="flex items-start gap-2 rounded-lg border bg-muted p-3">
              <code class="min-w-0 flex-1 break-all font-mono text-xs" data-command>{{ step.command }}</code>
              <button hlmBtn variant="ghost" size="sm" (click)="copy(step.command)" aria-label="Copy" data-copy><ng-icon name="lucideCopy" /></button>
            </div>
          </div>
        }
      </div>
    } @else if (missing()) {
      <p class="text-muted-foreground" data-missing>
        No Pending server {{ id() }}. If its setup ran, it is <a [routerLink]="['/servers', id()]" class="underline">a server now</a>.
      </p>
    } @else {
      <hlm-skeleton class="h-32 max-w-3xl rounded-lg" data-skeleton />
    }
  `,
})
export default class Waiting {
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  readonly #router = inject(Router);
  protected readonly id = signal(inject(ActivatedRoute).snapshot.paramMap.get('id')!);
  protected readonly state = signal<PendingServers | null>(null);
  protected readonly server = computed(() => this.state()?.pending.find((p) => p.id === this.id()) ?? null);
  protected readonly missing = computed(() => this.state() !== null && !this.server());
  protected readonly busy = signal(false);
  protected readonly steps = computed(() => {
    const p = this.server();
    if (!p) return [];
    const run = { what: 'run', label: p.installScript ? '2. Run it for this server:' : 'Run, as root:', command: p.command };
    return p.installScript ? [{ what: 'install', label: '1. Install the setup script (once; its root copy is missing):', command: p.installScript }, run] : [run];
  });

  constructor() {
    void firstValueFrom(this.#http.get<PendingServers>('/api/servers/pending')).then(
      (s) => this.state.set(s),
      (err: HttpErrorResponse) => {
        this.state.set({ pending: [], installing: null });
        this.#feedback.failed('Reading the Pending servers', err);
      },
    );
  }

  protected async copy(command: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command);
      this.#feedback.ok('Copied.');
    } catch {
      this.#feedback.ok('Copy failed: select the command instead.');
    }
  }

  protected async discard(): Promise<void> {
    const p = this.server()!;
    const ok = await this.#feedback.confirm({
      title: `Discard ${p.name}?`,
      verb: `Discard ${p.name}`,
      description: `Its folder (${p.dir}) and Java link are deleted from the host.`,
      destructive: true,
      typeName: p.id,
    });
    if (!ok) return;
    this.busy.set(true);
    try {
      await firstValueFrom(this.#http.delete(`/api/servers/pending/${encodeURIComponent(p.id)}`, { headers: JSON_HEADERS }));
      this.#feedback.ok(`Discarded ${p.name}.`);
      await this.#router.navigate(['/servers']);
    } catch (err) {
      if (err instanceof HttpErrorResponse) this.#feedback.failed(`Discarding ${p.name}`, err);
      else throw err;
    } finally {
      this.busy.set(false);
    }
  }
}

import { DatePipe } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import type { Backup, CommandOutput, RestoreRequest } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideEllipsis } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { Feedback } from '../feedback';
import { formatBytes } from '../units';
import { BackupProgress } from './backup-progress';
import ServerPage from './server';

/**
 * A server's Backups section (only with a backup folder), as Discord's `/backup status` and `/backup start`, and
 * restoring one while the linked service is stopped (after typing the server's name). The list is the server's
 * detail, fetched again by the page on each backup notice, so a finished backup shows up; progress comes from the
 * live feed (`BackupProgress`), not the requests' reply text.
 */
@Component({
  selector: 'app-server-backups',
  imports: [DatePipe, NgIcon, HlmButton, HlmDropdownMenuImports, HlmSpinner],
  viewProviders: [provideIcons({ lucideEllipsis })],
  template: `
    @if (backups(); as b) {
      <section class="max-w-4xl">
        <div class="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4" data-backup-summary>
          @for (t of tiles(); track t.key) {
            <section class="rounded-xl border bg-card p-4" [attr.data-tile]="t.key" [attr.data-state]="t.warn ? 'warn' : 'ok'">
              <h2 class="text-xs font-medium text-muted-foreground">{{ t.label }}</h2>
              <p class="mt-1 text-2xl font-semibold" [class.text-status-warn]="t.warn" data-value>{{ t.value }}</p>
              @if (t.detail) {
                <p class="text-xs" [class]="t.warn ? 'text-status-warn' : 'text-muted-foreground'" data-detail>{{ t.detail }}</p>
              }
            </section>
          }
        </div>
        <div class="mb-4 flex flex-wrap items-center gap-3">
          <button hlmBtn size="sm" [disabled]="!online() || !!progress() || starting()" (click)="start()" data-backup-start>
            @if (starting() || progress() === 'backup') {
              <hlm-spinner />
            }
            {{ progress() === 'backup' ? 'Backing up…' : 'Start backup' }}
          </button>
          @if (progress() === 'restore') {
            <span class="text-sm text-muted-foreground" data-progress>Restoring {{ restoring() ?? 'a backup' }}…</span>
          } @else if (progress() === 'backup') {
            <span class="text-sm text-muted-foreground" data-progress>Backup running: this updates when it finishes.</span>
          } @else if (!online()) {
            <span class="text-sm text-muted-foreground">{{ offline() }}</span>
          }
        </div>
        @if (b.backups.length) {
          <table class="w-full text-left text-sm">
            <thead class="text-muted-foreground">
              <tr><th class="py-1 pr-4 font-normal">Name</th><th class="pr-4 font-normal">Finished</th><th class="pr-4 font-normal">Size</th><th></th></tr>
            </thead>
            <tbody>
              @for (backup of b.backups; track backup.name) {
                <tr class="border-t" data-backup>
                  <td class="py-1 pr-4 font-mono">{{ backup.name }}</td>
                  <td class="pr-4">{{ backup.mtimeMs | date: 'yyyy-MM-dd HH:mm' }}</td>
                  <td class="pr-4">{{ bytes(backup.size) }}</td>
                  <td class="py-1 text-right">
                    <button hlmBtn variant="outline" size="sm" aria-label="More actions" [hlmDropdownMenuTrigger]="menu" data-backup-more>
                      <ng-icon name="lucideEllipsis" />
                    </button>
                    <ng-template #menu>
                      <div hlmDropdownMenu class="w-56">
                        <button hlmDropdownMenuItem type="button" [disabled]="!!restoreWhy() || !!progress()" (click)="restore(backup.name)" data-restore>Restore</button>
                        @if (restoreWhy(); as why) {
                          <p class="px-2 pb-1.5 text-xs text-muted-foreground" data-restore-why>{{ why }}</p>
                        }
                      </div>
                    </ng-template>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <div class="rounded-xl border border-dashed p-8 text-center" data-empty>
            <p class="font-medium">No backups yet</p>
            <p class="mb-3 text-sm text-muted-foreground">Backups the server makes, and ones started here, are listed with their size.</p>
            <button hlmBtn size="sm" [disabled]="!online() || !!progress()" (click)="start()" data-backup-start-empty>Start backup</button>
          </div>
        }
      </section>
    } @else {
      <p class="text-muted-foreground">This server has no backup folder.</p>
    }
  `,
})
export default class Backups {
  readonly #server = inject(ServerPage);
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  readonly #progress = inject(BackupProgress);
  protected readonly bytes = formatBytes;
  protected readonly backups = computed(() => {
    const b = this.#server.detail()!.backups;
    return b.configured ? b : null;
  });
  protected readonly tiles = computed(() => {
    const b = this.backups()!;
    const total = b.backups.reduce((sum: number, x: Backup) => sum + x.size, 0);
    const low = b.free !== null && b.free < b.minFree;
    return [
      { key: 'count', label: 'Backups', value: String(b.backups.length), detail: '', warn: false },
      { key: 'total', label: 'Total size', value: formatBytes(total), detail: '', warn: false },
      { key: 'free', label: 'Free', value: b.free === null ? 'unknown' : formatBytes(b.free), detail: low ? `under the ${formatBytes(b.minFree)} minimum` : '', warn: low },
      { key: 'growth', label: 'Growth', value: b.growth === null ? 'unknown' : `${b.growth < 0 ? '−' : '+'}${formatBytes(Math.abs(b.growth))}/day`, detail: '', warn: false },
    ];
  });
  protected readonly online = computed(() => this.#server.card()!.online);
  protected readonly offline = computed(() => `${this.#server.card()!.name} is offline: a backup needs it running.`);
  protected readonly serverName = computed(() => this.#server.card()!.name);
  /** What is running on this server, from the live feed. */
  protected readonly progress = computed(() => this.#progress.running()[this.#server.id]);
  /** Why a backup can't be restored now: only with the linked service stopped (it follows live state). */
  protected readonly restoreWhy = computed(() => {
    const service = this.#server.service();
    if (!service) return `${this.serverName()} has no linked service: restore it on the host with deploy/restore-backup.sh.`;
    return service.state === 'inactive' || service.state === 'failed' ? null : `To restore a backup, stop ${service.unit} first.`;
  });
  /** The backup being restored. */
  readonly restoring = signal<string | null>(null);
  /** The backup request is in flight. */
  readonly starting = signal(false);

  async restore(name: string): Promise<void> {
    const ok = await this.#feedback.confirm({
      title: `Restore ${name}?`,
      verb: `Restore ${name}`,
      description: `This puts the backup back as ${this.serverName()}'s world. The current world isn't deleted: it's kept next to it as a pre-restore copy (World.pre-restore-<time>), to remove by hand later. Start the server again afterwards.`,
      destructive: true,
      typeName: this.serverName(),
    });
    if (!ok) return;
    const id = this.#server.id;
    this.restoring.set(name);
    this.#progress.begin(id, 'restore');
    this.#http.post<CommandOutput>(`/api/servers/${encodeURIComponent(id)}/restore`, { name } satisfies RestoreRequest).subscribe({
      next: () => {
        this.#progress.end(id);
        this.restoring.set(null);
        this.#feedback.ok(`Restored ${name}. Start ${this.serverName()} again.`);
      },
      error: (err: HttpErrorResponse) => {
        this.#progress.end(id);
        this.restoring.set(null);
        this.#feedback.failed(`Restoring ${name}`, err);
      },
    });
  }

  /** Runs without asking. The finished (or failed) notice follows on the stream, which ends the progress; the page then fetches the list again. */
  start(): void {
    const id = this.#server.id;
    this.starting.set(true);
    this.#http.post<CommandOutput>(`/api/servers/${encodeURIComponent(id)}/backup`, {}).subscribe({
      next: () => {
        this.starting.set(false);
        this.#progress.begin(id, 'backup');
      },
      error: (err: HttpErrorResponse) => {
        this.starting.set(false);
        this.#feedback.failed('Starting the backup', err);
      },
    });
  }
}

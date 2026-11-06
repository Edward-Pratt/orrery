// The Roles tab: every role (`GET /api/roles`) with its note and its permissions in words (`GET /api/permissions`'s
// labels; "Reads only" for none), Owner as "Everything, everywhere" and never editable. An owner gets New role… and,
// per role, Edit… (`role-sheet.ts`'s `RoleSheet`) and Delete… (refused while a user holds it: the hub's 409 is the
// toast); anyone else sees the list read only. Fetched again after each change.

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import type { PermissionInfo, RoleView } from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucidePlus } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSkeleton } from '@spartan-ng/helm/skeleton';
import { catchError, firstValueFrom, of } from 'rxjs';
import { Feedback } from '../feedback';
import { Session } from '../session';
import { RoleSheet } from './role-sheet';

@Component({
  selector: 'app-roles',
  imports: [NgIcon, HlmButton, HlmSkeleton, RoleSheet],
  viewProviders: [provideIcons({ lucidePlus })],
  template: `
    <div class="mb-4 flex items-center gap-3">
      <p class="text-sm text-muted-foreground">
        @if (owner()) {
          A role is a set of permissions; users are given roles on the Users tab.
        } @else {
          Only an owner changes roles.
        }
      </p>
      @if (owner()) {
        <button hlmBtn size="sm" class="ml-auto" (click)="editing.set('new')" data-new-role><ng-icon name="lucidePlus" /> New role…</button>
      }
    </div>
    @if (roles(); as list) {
      <div class="flex flex-col gap-2">
        @for (r of list; track r.id) {
          <div class="flex flex-wrap items-center gap-3 rounded-lg border p-3" [attr.data-role]="r.name">
            <div class="min-w-0 flex-1">
              <span class="font-medium">{{ r.name }}</span>
              @if (r.note) {
                <span class="ms-2 text-sm text-muted-foreground">{{ r.note }}</span>
              }
              <p class="text-sm text-muted-foreground" data-permissions>{{ words(r) }}</p>
            </div>
            @if (owner() && r.id !== 'owner') {
              <button hlmBtn variant="outline" size="sm" (click)="editing.set(r)" data-edit>Edit…</button>
              <button hlmBtn variant="ghost" size="sm" class="text-status-down" (click)="remove(r)" data-delete>Delete…</button>
            }
          </div>
        }
      </div>
    } @else {
      <hlm-skeleton class="h-32 w-full" data-skeleton />
    }
    @if (editing(); as e) {
      <app-role-sheet [role]="e === 'new' ? null : e" [permissions]="permissions()" (closed)="editing.set(null)" (saved)="saved()" />
    }
  `,
})
export default class Roles {
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  readonly #session = inject(Session);
  protected readonly owner = () => this.#session.owner();
  protected readonly roles = signal<RoleView[] | null>(null);
  protected readonly permissions = signal<PermissionInfo[]>([]);
  protected readonly editing = signal<RoleView | 'new' | null>(null);
  readonly #labels = computed(() => new Map(this.permissions().map((p) => [p.name, p.label])));

  constructor() {
    this.fetch();
    this.#http.get<PermissionInfo[]>('/api/permissions').pipe(catchError(() => of([]))).subscribe((p) => this.permissions.set(p));
  }

  protected words(r: RoleView): string {
    if (r.id === 'owner') return 'Everything, everywhere';
    return r.permissions.map((p) => this.#labels().get(p) ?? p).join(', ') || 'Reads only';
  }

  protected fetch(): void {
    this.#http.get<RoleView[]>('/api/roles').subscribe({
      next: (r) => this.roles.set(r),
      error: (err: HttpErrorResponse) => (this.roles.set(this.roles() ?? []), this.#feedback.failed('Reading the roles', err)),
    });
  }

  protected saved(): void {
    this.editing.set(null);
    this.fetch();
  }

  protected async remove(r: RoleView): Promise<void> {
    const ok = await this.#feedback.confirm({ title: `Delete the role ${r.name}?`, description: 'Only a role nobody holds can be deleted.', verb: `Delete ${r.name}`, destructive: true });
    if (!ok) return;
    try {
      await firstValueFrom(this.#http.delete(`/api/roles/${encodeURIComponent(r.id)}`, { headers: { 'content-type': 'application/json' } }));
      this.#feedback.ok(`${r.name} is deleted.`);
    } catch (err) {
      if (!(err instanceof HttpErrorResponse)) throw err;
      this.#feedback.failed(`Deleting ${r.name}`, err);
    } finally {
      this.fetch();
    }
  }
}

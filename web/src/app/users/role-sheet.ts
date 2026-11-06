// `RoleSheet`: a full-height sheet that creates a role (`POST /api/roles`) or changes one (`PUT /api/roles/:id`): its
// name (1 to 32 characters), a note (at most 200) and its permissions, a checkbox each with the hub's label and
// description, a server permission marked "per server" (it holds only on the servers a grant names). Owners only, as
// the hub has it. `saved` once the hub took it; its refusals are toasts.

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, input, OnInit, output, signal } from '@angular/core';
import type { Permission, PermissionInfo, RoleRequest, RoleView } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSheetImports } from '@spartan-ng/helm/sheet';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { firstValueFrom } from 'rxjs';
import { Feedback } from '../feedback';

const NAME_MAX = 32;
const NOTE_MAX = 200;

@Component({
  selector: 'app-role-sheet',
  imports: [HlmButton, HlmInput, HlmSheetImports, HlmSpinner],
  template: `
    <hlm-sheet side="right" state="open" (closed)="closed.emit()">
      <hlm-sheet-content *hlmSheetPortal="let ctx" class="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md" data-sheet>
        <hlm-sheet-header>
          <h2 hlmSheetTitle>{{ role() ? 'Edit ' + role()!.name : 'New role' }}</h2>
        </hlm-sheet-header>
        <div class="flex flex-col gap-4 px-4 pb-4 text-sm">
          <label>Name <input hlmInput class="mt-1 w-full" [attr.maxlength]="nameMax" [value]="name()" (input)="name.set($any($event.target).value)" data-name /></label>
          <label>Note <input hlmInput class="mt-1 w-full" [attr.maxlength]="noteMax" [value]="note()" (input)="note.set($any($event.target).value)" data-note /></label>
          <fieldset class="flex flex-col gap-2">
            <legend class="mb-1 font-medium">Permissions</legend>
            @for (p of permissions(); track p.name) {
              <label class="flex items-start gap-2" [attr.data-permission]="p.name">
                <input type="checkbox" class="mt-0.5 size-4 accent-[var(--brand)]" [checked]="picked().has(p.name)" (change)="toggle(p.name)" />
                <span>
                  <b>{{ p.label }}</b>
                  @if (p.scoped) {
                    <span class="text-xs text-muted-foreground"> per server</span>
                  }
                  <span class="block text-muted-foreground">{{ p.description }}</span>
                </span>
              </label>
            }
            @if (!picked().size) {
              <p class="text-xs text-muted-foreground">None: a holder can read what the dashboard shows, and do nothing.</p>
            }
          </fieldset>
          <button hlmBtn [disabled]="busy() || !ready()" (click)="save()" data-save>
            @if (busy()) {
              <hlm-spinner />
            }
            {{ role() ? 'Save' : 'Create' }}
          </button>
        </div>
      </hlm-sheet-content>
    </hlm-sheet>
  `,
})
export class RoleSheet implements OnInit {
  readonly #http = inject(HttpClient);
  readonly #feedback = inject(Feedback);
  /** The role to change; null to create one. */
  readonly role = input.required<RoleView | null>();
  readonly permissions = input.required<PermissionInfo[]>();
  readonly closed = output<void>();
  readonly saved = output<void>();
  protected readonly nameMax = NAME_MAX;
  protected readonly noteMax = NOTE_MAX;
  protected readonly name = signal('');
  protected readonly note = signal('');
  protected readonly picked = signal(new Set<Permission>());
  protected readonly busy = signal(false);
  protected readonly ready = computed(() => this.name().trim().length >= 1 && this.name().trim().length <= NAME_MAX && this.note().length <= NOTE_MAX);

  ngOnInit(): void {
    const r = this.role();
    this.name.set(r?.name ?? '');
    this.note.set(r?.note ?? '');
    this.picked.set(new Set(r?.permissions ?? []));
  }

  protected toggle(p: Permission): void {
    const next = new Set(this.picked());
    if (!next.delete(p)) next.add(p);
    this.picked.set(next);
  }

  protected async save(): Promise<void> {
    const body: RoleRequest = { name: this.name().trim(), note: this.note().trim(), permissions: [...this.picked()] };
    const r = this.role();
    const headers = { 'content-type': 'application/json' };
    this.busy.set(true);
    try {
      await firstValueFrom(r ? this.#http.put(`/api/roles/${encodeURIComponent(r.id)}`, body, { headers }) : this.#http.post('/api/roles', body, { headers }));
      this.#feedback.ok(r ? `${body.name} is saved.` : `${body.name} is created.`);
      this.saved.emit();
    } catch (err) {
      if (!(err instanceof HttpErrorResponse)) throw err;
      this.#feedback.failed(r ? `Saving ${r.name}` : 'Creating the role', err);
    } finally {
      this.busy.set(false);
    }
  }
}

import { DatePipe, DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type {
  CompareReport,
  ConfigEdit,
  EditPreview,
  EditRequest,
  Extra,
  LibraryState,
  PackFinished,
  PackRuntimeRequest,
  PackState,
  PackStep,
  PackUpdateAnswer,
  PackUpdateRequest,
  RunningPackUpdate,
} from '@hub/api';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideCircleAlert, lucideEllipsis, lucideLoaderCircle, lucideLock, lucidePackage, lucidePlus, lucideX } from '@ng-icons/lucide';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmDropdownMenuImports } from '@spartan-ng/helm/dropdown-menu';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSheetImports } from '@spartan-ng/helm/sheet';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { catchError, debounceTime, defer, EMPTY, filter, firstValueFrom, map, Observable, of, startWith, Subject, switchMap } from 'rxjs';
import { LiveEvents, ofServer, ofTarget } from '../events';
import { Feedback } from '../feedback';
import { formatBytes, formatDuration } from '../units';
import { Uploader } from '../uploads';
import ServerPage from './server';

const STEP_LABELS: Record<PackStep, string> = { prepare: 'Prepare', backup: 'Backup', stop: 'Stop', swap: 'Swap', gate: 'Health gate', rollback: 'Rollback' };
const RESULT: Record<PackFinished | 'running', string> = {
  running: 'text-muted-foreground',
  ok: 'text-status-ok',
  'rolled back': 'text-status-down',
  failed: 'text-status-down',
  'failed before swap': 'text-status-down',
  'failed in staging': 'text-muted-foreground',
  cancelled: 'text-muted-foreground',
};
const FLOW =
  'The pack is prepared while the server runs; then a backup, a 5-minute countdown if players are online, the swap, and up to 10 minutes for the Mod to say hello, or it rolls back.';
const PENDING_TOAST = 'Saved: changes pending, not on the server until you apply them.';

type Sheet = { kind: 'update' } | { kind: 'extra'; extra?: Extra; replace?: boolean } | { kind: 'edit'; edit?: ConfigEdit };

/**
 * A server's Pack section (only for a server that can have one): Adopt as the empty state, then the installed pack
 * with its one primary action, Extras, Config edits, Kept paths and the history; the running update's steps in place
 * of the summary, followed live from `packUpdateStep` notices. Adding or changing an Extra or edit asks nothing: it
 * only marks changes pending. An update or apply asks once (a dialog); restoring after a rollback is the Backups
 * tab's typed restore.
 */
@Component({
  selector: 'app-server-pack',
  imports: [DatePipe, DecimalPipe, NgTemplateOutlet, RouterLink, NgIcon, HlmButton, HlmDropdownMenuImports, HlmInput, HlmSheetImports, HlmSpinner],
  viewProviders: [provideIcons({ lucideCheck, lucideCircleAlert, lucideEllipsis, lucideLoaderCircle, lucideLock, lucidePackage, lucidePlus, lucideX })],
  template: `
    @if (state(); as p) {
      <div class="flex max-w-4xl flex-col gap-8">
        @if (!p.installed) {
          @if (!report()) {
            <div class="rounded-xl border border-dashed p-8 text-center" data-adopt>
              <ng-icon name="lucidePackage" class="text-3xl text-muted-foreground" />
              <p class="mt-2 font-medium">orrery doesn't know this server's pack yet</p>
              <p class="mx-auto mb-4 max-w-md text-sm text-muted-foreground">
                Pick the pack version the server runs now from the library. It compares the two: nothing on the server changes.
              </p>
              <div class="mx-auto flex max-w-md flex-col gap-2 text-left text-sm">
                <ng-container [ngTemplateOutlet]="sourceFields" />
                <button hlmBtn class="mt-2" [disabled]="busy() || !picked()" (click)="compare()" data-compare>
                  @if (busy()) {
                    <hlm-spinner />
                  }
                  Compare with the server
                </button>
              </div>
            </div>
          } @else {
            <section data-report>
              <h2 class="text-base font-semibold">Adopt {{ report()!.name }} {{ report()!.version }}</h2>
              <p class="mb-4 text-sm text-muted-foreground" data-matching>
                {{ report()!.matching.toLocaleString('en') }} files match the pack. These don't. Ticked files are kept as Extras and put back on every
                update; unticked ones are left alone now and dropped by the next update.
              </p>
              <h3 class="mt-4 mb-1 text-sm font-medium">Recognised</h3>
              <p class="mb-2 text-xs text-muted-foreground">The orrery Mod: put back on every update, never an Extra.</p>
              <ul class="divide-y rounded-lg border">
                @for (m of report()!.mod; track m) {
                  <li class="flex items-center gap-3 px-3 py-2 text-sm" data-report-mod>
                    <ng-icon name="lucideLock" class="text-muted-foreground" />
                    <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ m }}</span>
                    <span class="text-xs text-muted-foreground">the orrery Mod</span>
                  </li>
                } @empty {
                  <li class="px-3 py-2 text-sm text-muted-foreground">No Mod jar in mods/.</li>
                }
              </ul>
              @for (g of groups; track g.key) {
                <h3 class="mt-4 mb-1 text-sm font-medium">{{ g.title }}</h3>
                <p class="mb-2 text-xs text-muted-foreground">{{ g.hint }}</p>
                <ul class="divide-y rounded-lg border" [attr.data-group]="g.key">
                  @for (f of report()![g.key]; track f.path) {
                    <li class="flex items-center gap-3 px-3 py-2 text-sm">
                      <input type="checkbox" class="size-4 accent-[var(--brand)]" [checked]="keep().has(f.path)" (change)="toggle(f.path)" [attr.aria-label]="'Keep ' + f.path" />
                      <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ f.path }}</span>
                      <span class="text-xs text-muted-foreground">{{ bytes(f.size) }}</span>
                    </li>
                  } @empty {
                    <li class="px-3 py-2 text-sm text-muted-foreground">None.</li>
                  }
                </ul>
              }
              <div class="mt-4 flex items-center gap-3">
                <button hlmBtn [disabled]="busy()" (click)="adopt()" data-adopt-keep>Adopt, keep {{ keep().size }} file{{ keep().size === 1 ? '' : 's' }}</button>
                <button hlmBtn variant="ghost" (click)="report.set(null)">Back</button>
              </div>
            </section>
          }
        } @else {
          @if (p.rolledBack; as rb) {
            <div class="-mx-4 flex flex-wrap items-center gap-3 border-y border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm md:mx-0 md:rounded-lg md:border" data-rolled-back>
              <ng-icon name="lucideCircleAlert" class="text-status-warn" />
              <span class="flex-1">
                Pack update to {{ rb.to }} <b>rolled back</b>: no hello in time. {{ p.installed.version }} is running again, but the world may have been changed
                on load.
              </span>
              @if (rb.backup) {
                <a hlmBtn size="sm" variant="outline" routerLink="../backups" [queryParams]="{ restore: rb.backup }" data-restore-offer>Restore pre-update backup</a>
              }
            </div>
          }

          @if (running(); as r) {
            <section class="rounded-xl border bg-card p-5" data-updating>
              <h2 class="font-semibold">Updating to {{ r.name }} {{ r.version }}</h2>
              <p class="mb-4 text-sm text-muted-foreground">Started by {{ r.by }} at {{ r.started | date: 'HH:mm' }}. You can leave this page.</p>
              <ol class="flex flex-col gap-3">
                @for (s of r.steps; track s.step; let i = $index) {
                  <li class="flex gap-3" [attr.data-step]="s.step" [attr.data-state]="s.state">
                    <span
                      class="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-xs"
                      [class]="s.state === 'done' ? 'bg-status-ok text-white' : s.state === 'failed' ? 'bg-status-down text-white' : s.state === 'running' ? 'text-brand' : 'border text-muted-foreground'"
                    >
                      @switch (s.state) {
                        @case ('done') {
                          <ng-icon name="lucideCheck" />
                        }
                        @case ('failed') {
                          <ng-icon name="lucideX" />
                        }
                        @case ('running') {
                          <ng-icon name="lucideLoaderCircle" class="animate-spin" />
                        }
                        @default {
                          {{ i + 1 }}
                        }
                      }
                    </span>
                    <div class="min-w-0 flex-1 text-sm" [class.text-muted-foreground]="s.state === 'waiting'">
                      <p class="font-medium">{{ stepLabels[s.step] }}</p>
                      @if (s.detail) {
                        <p class="text-muted-foreground" data-detail>{{ s.detail }}</p>
                      }
                      @if (s.state === 'running' && r.cancellable) {
                        <button hlmBtn size="sm" variant="outline" class="mt-2" [disabled]="busy()" (click)="cancel()" data-cancel>Cancel update</button>
                      }
                    </div>
                  </li>
                }
              </ol>
            </section>
          } @else {
            <section class="rounded-xl border bg-card p-5" data-summary>
              @if (done(); as d) {
                <p class="mb-3 flex items-center gap-1 text-sm font-medium text-status-ok" data-done><ng-icon name="lucideCheck" /> Done: {{ d }} is running.</p>
              }
              <div class="flex flex-wrap items-start justify-between gap-4">
                <div class="min-w-0">
                  <p class="text-xs font-medium text-muted-foreground">Installed pack</p>
                  <h2 class="text-xl font-semibold" data-installed>{{ p.installed.name }} {{ p.installed.version }}</h2>
                  <p class="text-sm break-all text-muted-foreground" data-installed-by>
                    {{ p.installed.how }} by {{ p.installed.by }}, {{ p.installed.at | date: 'd MMM y' }} ·
                    @if (isUrl(p.installed.source)) {
                      <a class="underline" [href]="p.installed.source" target="_blank" rel="noopener">source</a>
                    } @else {
                      {{ p.installed.source }}
                    }
                    · sha256 <span class="font-mono text-xs" [title]="p.installed.sha256">{{ p.installed.sha256.slice(0, 12) }}…</span>
                  </p>
                </div>
                <div class="flex flex-col items-end gap-1">
                  <div class="flex gap-2">
                    <button hlmBtn [variant]="p.pending.length ? 'outline' : 'default'" [disabled]="!!blocked() || busy()" (click)="openSheet({ kind: 'update' })" data-update>
                      Update pack
                    </button>
                    @if (p.pending.length) {
                      <button hlmBtn [disabled]="!!blocked() || busy()" (click)="apply()" data-apply>Apply {{ p.pending.length }} change{{ p.pending.length === 1 ? '' : 's' }}</button>
                    }
                  </div>
                  @if (blocked(); as why) {
                    <p class="text-xs text-muted-foreground" data-update-why>{{ why }}</p>
                  }
                </div>
              </div>
              @if (p.pending.length) {
                <div class="mt-4 rounded-lg bg-amber-500/10 px-3 py-2 text-sm" data-pending>
                  <b class="text-status-warn">{{ p.pending.length }} change{{ p.pending.length === 1 ? '' : 's' }} pending</b>, not on the server until applied (a
                  restart, with a backup first):
                  <ul class="mt-1 list-inside list-disc text-muted-foreground">
                    @for (c of p.pending; track c.kind + c.path) {
                      <li>
                        <span class="font-mono text-xs">{{ c.path }}</span> {{ c.kind === 'edit' ? 'edits ' : '' }}{{ c.change }}
                      </li>
                    }
                  </ul>
                </div>
              }
              <div class="mt-4 border-t pt-3 text-sm" data-runtime-row>
                <p class="text-xs font-medium text-muted-foreground">Java runtime</p>
                @if (p.runtime.unitLines; as lines) {
                  <p data-runtime-now>{{ runtimeLabel(p.runtime.name) }}</p>
                  <p class="mt-1 text-xs text-muted-foreground">To pick a runtime here, add these two lines to the server's unit as root, then restart it:</p>
                  <pre class="mt-1 overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs" data-unit-lines>{{ lines.join('\n') }}</pre>
                } @else {
                  <div class="flex flex-wrap items-center gap-2">
                    <select
                      class="h-8 rounded-md border bg-background px-2 text-sm"
                      [disabled]="busy() || !library()"
                      [value]="p.runtime.name ?? ''"
                      (change)="setRuntime($any($event.target).value || null)"
                      aria-label="Java runtime"
                      data-runtime-select
                    >
                      <option value="">System java</option>
                      @for (r of library()?.runtimes ?? []; track r.name) {
                        <option [value]="r.name">{{ r.label }}</option>
                      }
                    </select>
                    @if (p.runtime.pending) {
                      <span class="rounded-full bg-amber-500/15 px-2 text-xs text-status-warn" data-runtime-pending>pending restart</span>
                    }
                  </div>
                }
              </div>
              @if (failedPrep(); as f) {
                <div class="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm" data-failed-prep>
                  <b class="text-destructive">Update to {{ f.to }} failed while preparing.</b> The server wasn't touched. {{ f.why }}
                </div>
              }
            </section>
          }

          <section data-extras>
            <div class="mb-2 flex items-center justify-between gap-3">
              <div>
                <h2 class="text-base font-semibold">Extras</h2>
                <p class="text-sm text-muted-foreground">Files put on top of the pack on every update: new ones, or replacing the pack's.</p>
              </div>
              <button hlmBtn size="sm" variant="outline" (click)="openSheet({ kind: 'extra' })" data-add-extra><ng-icon name="lucidePlus" /> Add extra</button>
            </div>
            <ul class="divide-y rounded-lg border">
              @for (e of p.extras; track e.id) {
                <li class="flex items-start gap-3 px-3 py-2.5 text-sm" [class.opacity-60]="e.removed" [attr.data-extra]="e.target">
                  <div class="min-w-0 flex-1">
                    <p class="truncate font-mono text-xs" [class.line-through]="e.removed">{{ e.target }}</p>
                    <p class="text-xs text-muted-foreground">
                      <span class="mr-1 rounded-full border px-1.5" data-where>{{ e.replaces ? "replaces the pack's file" : 'new path' }}</span>
                      @if (e.label) {
                        {{ e.label }} ·
                      }
                      {{ e.by }}, {{ e.at | date: 'd MMM y' }}
                      @if (e.note) {
                        · <i>{{ e.note }}</i>
                      }
                    </p>
                  </div>
                  @if (e.change) {
                    <span class="rounded-full bg-amber-500/15 px-2 text-xs text-status-warn" data-change>{{ e.change }}</span>
                  }
                  @if (!e.removed) {
                    <button hlmBtn variant="ghost" size="sm" aria-label="More actions" [hlmDropdownMenuTrigger]="menu" data-more><ng-icon name="lucideEllipsis" /></button>
                    <ng-template #menu>
                      <div hlmDropdownMenu class="w-48">
                        <button hlmDropdownMenuItem (click)="openSheet({ kind: 'extra', extra: e, replace: true })" data-replace>Replace file…</button>
                        <button hlmDropdownMenuItem (click)="openSheet({ kind: 'extra', extra: e })" data-relabel>Edit label and note…</button>
                        <button hlmDropdownMenuItem (click)="removeExtra(e)" data-remove>Remove</button>
                      </div>
                    </ng-template>
                  }
                </li>
              }
              <li class="flex items-center gap-3 bg-muted/40 px-3 py-2.5 text-sm" data-mod-row>
                <ng-icon name="lucideLock" class="text-muted-foreground" />
                <div class="min-w-0 flex-1">
                  <p class="truncate font-mono text-xs">{{ p.mod ?? 'mods/orrery-*.jar' }}</p>
                  <p class="text-xs text-muted-foreground">The orrery Mod: put back on every update. Deployed from Host.</p>
                </div>
              </li>
            </ul>
          </section>

          <section data-edits>
            <div class="mb-2 flex items-center justify-between gap-3">
              <div>
                <h2 class="text-base font-semibold">Config edits</h2>
                <p class="text-sm text-muted-foreground">Find-and-replace in the pack's files, applied last. One that matches nothing stops the update before the server is touched.</p>
              </div>
              <button hlmBtn size="sm" variant="outline" (click)="openSheet({ kind: 'edit' })" data-add-edit><ng-icon name="lucidePlus" /> Add edit</button>
            </div>
            <ul class="divide-y rounded-lg border">
              @for (c of p.edits; track c.id) {
                <li class="flex items-start gap-3 px-3 py-2.5 text-sm" [attr.data-edit]="c.id">
                  <div class="min-w-0 flex-1">
                    <p class="font-mono text-xs">
                      {{ c.path }}
                      @if (c.note) {
                        <span class="font-sans text-muted-foreground">· {{ c.note }}</span>
                      }
                    </p>
                    <p class="mt-1 font-mono text-xs break-all">
                      <span class="rounded bg-muted px-1">{{ c.find }}</span> → <span class="rounded bg-muted px-1">{{ c.replace }}</span>
                    </p>
                    @if (c.failedOn) {
                      <p class="mt-1 flex items-center gap-1 text-xs text-destructive" data-unmatched>
                        <ng-icon name="lucideCircleAlert" /> Matched nothing in {{ c.failedOn }} (the last update tried).
                      </p>
                    }
                  </div>
                  <button hlmBtn variant="ghost" size="sm" aria-label="More actions" [hlmDropdownMenuTrigger]="emenu" data-more><ng-icon name="lucideEllipsis" /></button>
                  <ng-template #emenu>
                    <div hlmDropdownMenu class="w-44">
                      <button hlmDropdownMenuItem (click)="openSheet({ kind: 'edit', edit: c })" data-change-edit>Edit…</button>
                      <button hlmDropdownMenuItem (click)="removeEdit(c)" data-remove>Remove</button>
                    </div>
                  </ng-template>
                </li>
              } @empty {
                <li class="px-3 py-2.5 text-sm text-muted-foreground">None yet.</li>
              }
            </ul>
          </section>
        }

        <section data-kept>
          <h2 class="text-base font-semibold">Kept paths</h2>
          <p class="mb-2 text-sm text-muted-foreground">
            Never deleted or overwritten by an update. This server's own are set in <span class="font-mono text-xs">config.json</span> (<span
              class="font-mono text-xs"
              >keep</span
            >).
          </p>
          <div class="flex flex-wrap gap-1.5">
            @for (k of p.kept.server; track k) {
              <span class="rounded-md border px-2 py-0.5 font-mono text-xs" data-kept-server>{{ k }}</span>
            }
            @for (k of p.kept.builtIn; track k) {
              <span class="rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground" data-kept-builtin>{{ k }}</span>
            }
          </div>
        </section>

        <section data-history>
          <h2 class="mb-2 text-base font-semibold">History</h2>
          @if (p.history.length) {
            <table class="w-full text-left text-sm">
              <thead class="text-muted-foreground">
                <tr>
                  <th class="py-1 pr-4 font-normal">When</th>
                  <th class="pr-4 font-normal">Version</th>
                  <th class="pr-4 font-normal">Result</th>
                  <th class="hidden pr-4 font-normal sm:table-cell" data-by-column>By</th>
                </tr>
              </thead>
              <tbody>
                @for (h of p.history; track h.id) {
                  <tr class="border-t align-top" [attr.data-update-row]="h.id">
                    <td class="py-1.5 pr-4 whitespace-nowrap">{{ h.started | date: 'd MMM, HH:mm' }}</td>
                    <td class="pr-4">
                      {{ h.from === h.to ? h.to : h.from + ' → ' + h.to }}
                      @if (h.changes) {
                        <span class="block text-xs text-muted-foreground">changes applied: {{ h.changes.join(', ') }}</span>
                      }
                    </td>
                    <td class="pr-4" [class]="result[h.outcome]">
                      {{ h.outcome }}
                      @if (h.finished) {
                        <span class="text-xs text-muted-foreground">{{ took(h.finished - h.started) }}</span>
                      }
                    </td>
                    <td class="hidden pr-4 sm:table-cell">{{ h.by }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <p class="text-sm text-muted-foreground" data-no-history>No pack updates yet.</p>
          }
        </section>
      </div>
    } @else if (missing(); as why) {
      <p class="text-muted-foreground">{{ why }}</p>
    }

    <ng-template #uploading>
      @if (uploaded() !== null) {
        <p class="text-xs text-muted-foreground" data-uploaded>Uploading… {{ uploaded()! * 100 | number: '1.0-0' }}%</p>
      }
    </ng-template>
    <ng-template #sourceFields>
      @if (library()?.packs; as packs) {
        @if (packs.length) {
          <label
            >Pack version
            <select class="mt-1 h-9 w-full rounded-md border bg-background px-2 text-sm" [value]="pick() ?? ''" (change)="pick.set(+$any($event.target).value || null)" data-pick>
              <option value="">Choose a version…</option>
              @for (e of packs; track e.id) {
                <option [value]="e.id">{{ e.name }} {{ e.version }} · Minecraft {{ e.mc }}</option>
              }
            </select>
          </label>
        } @else {
          <p class="text-muted-foreground" data-library-empty>The library has no pack versions yet.</p>
        }
      }
      <p class="text-xs text-muted-foreground">Not there? <a routerLink="/library" class="underline" data-library-link>Add it on the Library page</a> first.</p>
    </ng-template>

    @if (sheet(); as s) {
      <hlm-sheet side="right" state="open" (closed)="sheet.set(null)">
        <hlm-sheet-content *hlmSheetPortal="let ctx" class="data-[side=right]:w-full data-[side=right]:sm:max-w-md" data-sheet>
          <hlm-sheet-header>
            <h2 hlmSheetTitle>{{ sheetTitle() }}</h2>
          </hlm-sheet-header>
          <div class="flex flex-col gap-3 px-4 pb-4 text-sm">
            @switch (s.kind) {
              @case ('update') {
                <ng-container [ngTemplateOutlet]="sourceFields" />
                <p class="text-xs text-muted-foreground">{{ flow }}</p>
                <button hlmBtn [disabled]="busy() || !picked()" (click)="update()" data-update-go>Update to {{ picked()?.version ?? '…' }}…</button>
              }
              @case ('extra') {
                @if (!s.extra || s.replace) {
                  <label>File <input type="file" hlmInput class="mt-1 w-full" (change)="setExtraFile($any($event.target).files?.[0])" data-extra-file /></label>
                }
                @if (!s.extra) {
                  <label>Put at <input hlmInput class="mt-1 w-full font-mono" [value]="target()" (input)="target.set($any($event.target).value)" data-target /></label>
                  @if (replacesPack()) {
                    <p class="text-xs text-status-warn" data-replaces>The pack has this file: this Extra replaces it.</p>
                  }
                }
                @if (!s.replace) {
                  <label>Version label <input hlmInput class="mt-1 w-full" placeholder="optional" [value]="label()" (input)="label.set($any($event.target).value)" data-label /></label>
                  <label>Note <input hlmInput class="mt-1 w-full" placeholder="why it's here" [value]="note()" (input)="note.set($any($event.target).value)" data-note /></label>
                }
                <button hlmBtn [disabled]="busy() || ((!s.extra || s.replace) && !extraFile()) || (!s.extra && !target().trim())" (click)="saveExtra(s)" data-save>
                  {{ s.extra ? 'Save' : 'Add' }}
                </button>
                <ng-container [ngTemplateOutlet]="uploading" />
                <p class="text-xs text-muted-foreground">Nothing changes on the server until you apply.</p>
              }
              @case ('edit') {
                <label>File <input hlmInput class="mt-1 w-full font-mono" [value]="editPath()" (input)="editPath.set($any($event.target).value); previewSoon()" data-edit-path /></label>
                <label>Find (regex) <input hlmInput class="mt-1 w-full font-mono" [value]="find()" (input)="find.set($any($event.target).value); previewSoon()" data-find /></label>
                <label>Replace with <input hlmInput class="mt-1 w-full font-mono" [value]="replace()" (input)="replace.set($any($event.target).value)" data-replace-with /></label>
                <label>Note <input hlmInput class="mt-1 w-full" placeholder="optional" [value]="note()" (input)="note.set($any($event.target).value)" data-note /></label>
                @if (preview(); as pv) {
                  <p class="rounded bg-muted px-2 py-1 text-xs" data-preview>Against the installed {{ state()?.installed?.version }}: {{ pv }}</p>
                }
                <button hlmBtn [disabled]="busy() || !editPath().trim() || !find()" (click)="saveEdit(s.edit)" data-save>Save</button>
              }
            }
          </div>
        </hlm-sheet-content>
      </hlm-sheet>
    }
  `,
})
export default class Pack {
  readonly #server = inject(ServerPage);
  readonly #http = inject(HttpClient);
  readonly #uploader = inject(Uploader);
  readonly #feedback = inject(Feedback);
  readonly #base = `/api/servers/${encodeURIComponent(this.#server.id)}/pack`;
  protected readonly stepLabels = STEP_LABELS;
  protected readonly result = RESULT;
  protected readonly flow = FLOW;
  protected readonly bytes = formatBytes;
  protected readonly groups = [
    { key: 'notInPack', title: 'Not in the pack', hint: 'Keep → an Extra at the same path.' },
    {
      key: 'different',
      title: 'Different from the pack',
      hint: "Keep → an Extra replacing the pack's file. For a one-line change a Config edit is better: add it after adopting.",
    },
  ] as const;

  readonly state = signal<PackState | null>(null);
  protected readonly missing = signal<string | null>(null);
  /** The update under way, kept current from the stream. */
  protected readonly running = signal<RunningPackUpdate | null>(null);
  /** The version an update watched here just put in place, for the summary card's "Done" line. */
  protected readonly done = signal<string | null>(null);
  protected readonly busy = signal(false);
  /** The share of a file sent so far while one uploads. */
  protected readonly uploaded = signal<number | null>(null);
  protected readonly sheet = signal<Sheet | null>(null);
  protected readonly report = signal<CompareReport | null>(null);
  protected readonly keep = signal(new Set<string>());

  // The library version picked (Adopt and Update pack).
  protected readonly library = signal<LibraryState | null>(null);
  protected readonly pick = signal<number | null>(null);
  protected readonly picked = computed(() => this.library()?.packs.find((e) => e.id === this.pick()) ?? null);
  // The Extra and Config edit sheets.
  protected readonly extraFile = signal<File | null>(null);
  protected readonly target = signal('');
  protected readonly label = signal('');
  protected readonly note = signal('');
  protected readonly editPath = signal('');
  protected readonly find = signal('');
  protected readonly replace = signal('');
  protected readonly preview = signal<string | null>(null);
  readonly #previews = new Subject<void>();
  readonly #reload = new Subject<void>();

  protected readonly replacesPack = computed(() => this.state()?.packFiles.includes(this.target().trim()) ?? false);
  /** Why an update can't start now: the hub's reason, or the server being offline (the backup needs it). */
  protected readonly blocked = computed(() => {
    const card = this.#server.card();
    return this.state()?.blocked ?? (card && !card.online ? `${card.name} is offline: an update needs it running, for the backup.` : null);
  });
  /** The latest update, when it failed while preparing: its cause, for the red box. */
  protected readonly failedPrep = computed(() => {
    const last = this.state()?.history[0];
    return last?.outcome === 'failed in staging' ? { to: last.to, why: last.log.split('\n').filter((l) => !/^\w+: (done|failed)/.test(l)).at(-1) ?? '' } : null;
  });
  protected readonly sheetTitle = computed(() => {
    const s = this.sheet();
    if (s?.kind === 'update') return 'Update pack';
    if (s?.kind === 'edit') return s.edit ? 'Config edit' : 'Add config edit';
    return s?.extra ? (s.replace ? `Replace ${s.extra.target}` : `Label and note of ${s.extra.target}`) : 'Add extra';
  });

  constructor() {
    this.#reload
      .pipe(
        debounceTime(50),
        startWith(undefined),
        switchMap(() =>
          this.#http.get<PackState>(this.#base).pipe(
            catchError((err: HttpErrorResponse) => {
              if (!this.state()) this.missing.set(err.status === 404 ? 'This server has no pack.' : `The hub didn't answer (HTTP ${err.status}).`);
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((p) => {
        this.#show(p);
        if (!this.library()) this.#fetchLibrary();
      });
    const events = inject(LiveEvents).all$;
    // A Mod deploy starting or ending changes why an update can't start.
    events.pipe(filter(ofTarget('deploy')), takeUntilDestroyed()).subscribe(() => this.#reload.next());
    events
      .pipe(filter(ofServer(this.#server.id)), takeUntilDestroyed())
      .subscribe(({ event: e }) => {
        if (e.type !== 'notice') return;
        if (e.kind === 'packUpdateStep') {
          const r = this.running();
          if (!r) return this.#reload.next(); // started elsewhere: fetch it with its steps
          const steps = r.steps.some((s) => s.step === e.step) ? r.steps.map((s) => (s.step === e.step ? { step: e.step, state: e.state, detail: e.detail } : s)) : [...r.steps, { step: e.step, state: e.state, detail: e.detail }];
          this.running.set({ ...r, steps, cancellable: e.cancellable });
        } else if (e.kind === 'packUpdateStarted') {
          this.done.set(null);
          this.#reload.next();
        } else if (e.kind === 'packUpdateFinished') {
          if (e.outcome === 'ok' && this.running()) this.done.set(e.to);
          this.#reload.next();
        }
      });
    this.#previews
      .pipe(
        debounceTime(300),
        switchMap(() => {
          const path = this.editPath().trim();
          if (!path || !this.find()) return of(null);
          return this.#http.post<EditPreview>(`${this.#base}/edits/preview`, { path, find: this.find() }).pipe(
            map((p) => `${p.matches} match${p.matches === 1 ? '' : 'es'}`),
            catchError((err: HttpErrorResponse) => of(typeof err.error === 'string' && err.error ? err.error : `HTTP ${err.status}`)),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((text) => this.preview.set(text));
  }

  #show(p: PackState): void {
    this.state.set(p);
    this.running.set(p.running);
  }

  protected isUrl = (s: string) => /^https:\/\//.test(s);
  protected runtimeLabel = (name: string | null) => (name ? (this.library()?.runtimes.find((r) => r.name === name)?.label ?? name) : 'System java');
  protected took = (ms: number) => formatDuration(ms);

  /** The library's versions and runtimes, to pick from. */
  #fetchLibrary(): void {
    this.#http.get<LibraryState>('/api/library').subscribe({
      next: (l) => this.library.set(l),
      error: (err: HttpErrorResponse) => this.#feedback.failed('Reading the library', err),
    });
  }

  protected setExtraFile(file: File | undefined): void {
    this.extraFile.set(file ?? null);
    const s = this.sheet();
    if (file && s?.kind === 'extra' && !s.extra) this.target.set(`mods/${file.name}`);
  }

  protected openSheet(s: Sheet): void {
    this.extraFile.set(null);
    this.preview.set(null);
    if (s.kind === 'update') {
      this.pick.set(null);
      this.#fetchLibrary();
    } else if (s.kind === 'extra') {
      this.target.set('');
      this.label.set(s.extra?.label ?? '');
      this.note.set(s.extra?.note ?? '');
    } else if (s.kind === 'edit') {
      this.editPath.set(s.edit?.path ?? '');
      this.find.set(s.edit?.find ?? '');
      this.replace.set(s.edit?.replace ?? '');
      this.note.set(s.edit?.note ?? '');
      if (s.edit) this.previewSoon();
    }
    this.sheet.set(s);
  }

  protected previewSoon(): void {
    this.#previews.next();
  }

  protected toggle(path: string): void {
    this.keep.update((k) => {
      const next = new Set(k);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  /** Uploads an Extra for the hub to use once, showing how much is sent; its upload id. */
  async #upload(file: File): Promise<string> {
    this.uploaded.set(0);
    try {
      return await this.#uploader.send(file, (share) => this.uploaded.set(share));
    } finally {
      this.uploaded.set(null);
    }
  }

  /** Runs a request with the buttons disabled; reports a failure as a toast. Resolves with the answer, or undefined. */
  async #request<T>(what: string, run: () => Promise<T>): Promise<T | undefined> {
    this.busy.set(true);
    try {
      return await run();
    } catch (err) {
      if (err instanceof HttpErrorResponse) this.#feedback.failed(what, err);
      else throw err;
      return undefined;
    } finally {
      this.busy.set(false);
    }
  }

  protected async compare(): Promise<void> {
    const report = await this.#request('Comparing', async () => firstValueFrom(this.#http.post<CompareReport>(`${this.#base}/compare`, { library: this.pick()! })));
    if (!report) return;
    this.keep.set(new Set()); // nothing kept unless ticked
    this.report.set(report);
  }

  protected async adopt(): Promise<void> {
    const p = await this.#request('Adopting', () => firstValueFrom(this.#http.post<PackState>(`${this.#base}/adopt`, { keep: [...this.keep()] })));
    if (!p) return;
    this.report.set(null);
    this.#show(p);
    this.#feedback.ok(`Adopted ${p.installed!.name} ${p.installed!.version}.`);
  }

  #confirmText(): string {
    const players = this.#server.card()?.players.length ?? 0;
    return `Backs up, then stops the server${players ? ` (a 5-minute countdown: ${players} player${players === 1 ? '' : 's'} online)` : ''}, swaps the files, and rolls back if the Mod doesn't say hello within 10 minutes.`;
  }

  protected async update(): Promise<void> {
    const server = this.#server.card()!.name;
    const { id, name, version } = this.picked()!;
    this.sheet.set(null);
    const ok = await this.#feedback.confirm({ title: `Update ${server} to ${name} ${version}?`, description: this.#confirmText(), verb: `Update to ${version}` });
    if (ok) await this.#start(async () => ({ library: id }));
  }

  protected async apply(): Promise<void> {
    const n = this.state()!.pending.length;
    const ok = await this.#feedback.confirm({
      title: `Apply ${n} change${n === 1 ? '' : 's'} to ${this.#server.card()!.name}?`,
      description: this.#confirmText(),
      verb: 'Apply and restart',
    });
    if (ok) await this.#start(async () => ({ pending: true }));
  }

  async #start(body: () => Promise<PackUpdateRequest>): Promise<void> {
    const answer = await this.#request('Starting the update', async () => firstValueFrom(this.#http.post<PackUpdateAnswer>(`${this.#base}/update`, await body())));
    if (answer) this.#reload.next();
  }

  /** Points the server's Java link at a runtime (null: the host's own java), from its next start. */
  protected async setRuntime(name: string | null): Promise<void> {
    const body: PackRuntimeRequest = { runtime: name };
    const p = await this.#request('Setting the Java runtime', () => firstValueFrom(this.#http.put<PackState>(`${this.#base}/runtime`, body)));
    if (!p) return;
    this.#show(p);
    this.#feedback.ok(`Set to ${this.runtimeLabel(name)}: it applies at the server's next restart.`);
  }

  protected async cancel(): Promise<void> {
    const done = await this.#request('Cancelling the update', () => firstValueFrom(this.#http.post(`${this.#base}/update/cancel`, {})));
    if (done !== undefined) this.#feedback.ok('Cancelling: the server is not touched.');
  }

  /** Saves a change to the pack's Extras or edits, which only marks changes pending. */
  async #change(what: string, run: () => Observable<PackState>): Promise<void> {
    const p = await this.#request(what, () => firstValueFrom(run()));
    if (!p) return;
    this.sheet.set(null);
    this.#show(p);
    this.#feedback.ok(PENDING_TOAST);
  }

  protected saveExtra(s: Extract<Sheet, { kind: 'extra' }>): Promise<void> {
    const file = this.extraFile();
    const upload = (): Observable<string | undefined> => (file ? defer(() => this.#upload(file)) : of(undefined));
    if (!s.extra) {
      return this.#change('Adding the Extra', () =>
        upload().pipe(switchMap((up) => this.#http.post<PackState>(`${this.#base}/extras`, { upload: up, target: this.target().trim(), label: this.label(), note: this.note() }))),
      );
    }
    const id = s.extra.id;
    return this.#change('Saving the Extra', () =>
      upload().pipe(
        switchMap((up) => this.#http.put<PackState>(`${this.#base}/extras/${id}`, s.replace ? { upload: up } : { label: this.label(), note: this.note() })),
      ),
    );
  }

  protected removeExtra(e: Extra): Promise<void> {
    return this.#change(`Removing ${e.target}`, () => this.#http.delete<PackState>(`${this.#base}/extras/${e.id}`, { headers: { 'content-type': 'application/json' } }));
  }

  protected saveEdit(edit: ConfigEdit | undefined): Promise<void> {
    const body: EditRequest = { path: this.editPath().trim(), find: this.find(), replace: this.replace(), note: this.note() };
    return this.#change('Saving the Config edit', () =>
      edit ? this.#http.put<PackState>(`${this.#base}/edits/${edit.id}`, body) : this.#http.post<PackState>(`${this.#base}/edits`, body),
    );
  }

  protected removeEdit(c: ConfigEdit): Promise<void> {
    return this.#change(`Removing the edit of ${c.path}`, () => this.#http.delete<PackState>(`${this.#base}/edits/${c.id}`, { headers: { 'content-type': 'application/json' } }));
  }
}

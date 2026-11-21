import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { ConfigEdit, EditPreview, EditRequest, LibraryPack, LibraryState, PackState } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSheetImports } from '@spartan-ng/helm/sheet';
import { catchError, debounceTime, defer, map, Observable, of, Subject, switchMap } from 'rxjs';
import { Uploader } from '../uploads';
import type { Sheet } from './pack-rules';
import { PackSource } from './pack-source';

const FLOW =
  'The pack is prepared while the server runs; then a backup, a 5-minute countdown if players are online, the swap, and up to 10 minutes for the Mod to say hello, or it rolls back.';

/** A change a sheet saves: what it is, for the toast, and its request, which the page runs. */
export type SheetSave = { what: string; run: () => Observable<PackState> };

/**
 * The Pack tab's sheets (full screen on a phone), the one `sheet` names: Update pack (the library picker, then
 * `update`, which the page confirms), an Extra (a file uploaded through `Uploader`, where to put it with a line when the
 * pack has that path, a label and note) and a Config edit (with a match preview against the installed pack, asked 300 ms
 * after typing stops). It holds the Extra and edit forms: the page's `open` fills them as it opens a sheet, and Save
 * hands the change up as a `SheetSave`, as the page runs every request with its buttons disabled.
 */
@Component({
  selector: 'app-pack-sheet',
  host: { class: 'contents' },
  imports: [DecimalPipe, NgTemplateOutlet, HlmButton, HlmInput, HlmSheetImports, PackSource],
  template: `
    <ng-template #uploading>
      @if (uploaded() !== null) {
        <p class="text-xs text-muted-foreground" data-uploaded>Uploading… {{ uploaded()! * 100 | number: '1.0-0' }}%</p>
      }
    </ng-template>
    @if (sheet(); as s) {
      <hlm-sheet side="right" state="open" (closed)="closed.emit()">
        <hlm-sheet-content *hlmSheetPortal="let ctx" class="data-[side=right]:w-full data-[side=right]:sm:max-w-md" data-sheet>
          <hlm-sheet-header>
            <h2 hlmSheetTitle>{{ sheetTitle() }}</h2>
          </hlm-sheet-header>
          <div class="flex flex-col gap-3 px-4 pb-4 text-sm">
            @switch (s.kind) {
              @case ('update') {
                <app-pack-source [library]="library()" [pick]="pick()" (pickChange)="pickChange.emit($event)" />
                <p class="text-xs text-muted-foreground">{{ flow }}</p>
                <button hlmBtn [disabled]="busy() || !picked()" (click)="update.emit()" data-update-go>Update to {{ picked()?.version ?? '…' }}…</button>
              }
              @case ('extra') {
                @if (!s.extra || s.replace) {
                  <label>File <input type="file" hlmInput class="mt-1 w-full" (change)="setExtraFile($any($event.target).files?.[0])" data-extra-file /></label>
                }
                @if (!s.extra) {
                  <label>Put at <input hlmInput class="mt-1 w-full ar-input--mono" [value]="target()" (input)="target.set($any($event.target).value)" data-target /></label>
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
                <label>File <input hlmInput class="mt-1 w-full ar-input--mono" [value]="editPath()" (input)="editPath.set($any($event.target).value); previewSoon()" data-edit-path /></label>
                <label>Find (regex) <input hlmInput class="mt-1 w-full ar-input--mono" [value]="find()" (input)="find.set($any($event.target).value); previewSoon()" data-find /></label>
                <label>Replace with <input hlmInput class="mt-1 w-full ar-input--mono" [value]="replace()" (input)="replace.set($any($event.target).value)" data-replace-with /></label>
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
export class PackSheet {
  readonly #http = inject(HttpClient);
  readonly #uploader = inject(Uploader);
  protected readonly flow = FLOW;

  readonly sheet = input.required<Sheet | null>();
  /** The server's `…/pack` route. */
  readonly base = input.required<string>();
  readonly state = input.required<PackState | null>();
  readonly busy = input.required<boolean>();
  readonly library = input.required<LibraryState | null>();
  readonly pick = input.required<number | null>();
  readonly picked = input.required<LibraryPack | null>();
  readonly pickChange = output<number | null>();
  readonly closed = output();
  readonly update = output();
  readonly save = output<SheetSave>();

  /** The share of a file sent so far while one uploads. */
  protected readonly uploaded = signal<number | null>(null);
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

  protected readonly replacesPack = computed(() => this.state()?.packFiles.includes(this.target().trim()) ?? false);
  protected readonly sheetTitle = computed(() => {
    const s = this.sheet();
    if (s?.kind === 'update') return 'Update pack';
    if (s?.kind === 'edit') return s.edit ? 'Config edit' : 'Add config edit';
    return s?.extra ? (s.replace ? `Replace ${s.extra.target}` : `Label and note of ${s.extra.target}`) : 'Add extra';
  });

  constructor() {
    this.#previews
      .pipe(
        debounceTime(300),
        switchMap(() => {
          const path = this.editPath().trim();
          if (!path || !this.find()) return of(null);
          return this.#http.post<EditPreview>(`${this.base()}/edits/preview`, { path, find: this.find() }).pipe(
            map((p) => `${p.matches} match${p.matches === 1 ? '' : 'es'}`),
            catchError((err: HttpErrorResponse) => of(typeof err.error === 'string' && err.error ? err.error : `HTTP ${err.status}`)),
          );
        }),
        takeUntilDestroyed(),
      )
      .subscribe((text) => this.preview.set(text));
  }

  /** Fills the forms for the sheet the page is opening. */
  open(s: Sheet): void {
    this.extraFile.set(null);
    this.preview.set(null);
    if (s.kind === 'extra') {
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
  }

  protected setExtraFile(file: File | undefined): void {
    this.extraFile.set(file ?? null);
    const s = this.sheet();
    if (file && s?.kind === 'extra' && !s.extra) this.target.set(`mods/${file.name}`);
  }

  protected previewSoon(): void {
    this.#previews.next();
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

  protected saveExtra(s: Extract<Sheet, { kind: 'extra' }>): void {
    const file = this.extraFile();
    const upload = (): Observable<string | undefined> => (file ? defer(() => this.#upload(file)) : of(undefined));
    if (!s.extra) {
      this.save.emit({
        what: 'Adding the Extra',
        run: () =>
          upload().pipe(switchMap((up) => this.#http.post<PackState>(`${this.base()}/extras`, { upload: up, target: this.target().trim(), label: this.label(), note: this.note() }))),
      });
      return;
    }
    const id = s.extra.id;
    this.save.emit({
      what: 'Saving the Extra',
      run: () =>
        upload().pipe(
          switchMap((up) => this.#http.put<PackState>(`${this.base()}/extras/${id}`, s.replace ? { upload: up } : { label: this.label(), note: this.note() })),
        ),
    });
  }

  protected saveEdit(edit: ConfigEdit | undefined): void {
    const body: EditRequest = { path: this.editPath().trim(), find: this.find(), replace: this.replace(), note: this.note() };
    this.save.emit({
      what: 'Saving the Config edit',
      run: () => (edit ? this.#http.put<PackState>(`${this.base()}/edits/${edit.id}`, body) : this.#http.post<PackState>(`${this.base()}/edits`, body)),
    });
  }
}

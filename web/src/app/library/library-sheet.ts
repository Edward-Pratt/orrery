import { DecimalPipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, input, output, signal } from '@angular/core';
import type { LibraryAddAnswer, LibraryAddRequest, RuntimeAddRequest } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmInput } from '@spartan-ng/helm/input';
import { HlmSheetImports } from '@spartan-ng/helm/sheet';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { HlmToggleGroupImports } from '@spartan-ng/helm/toggle-group';
import { firstValueFrom } from 'rxjs';
import { Uploader } from '../uploads';
import { ARTIFACT, fromFileName } from './library-rules';

/** A pack add the sheet hands up: what it is, for the toast, and its request, which the page runs. */
export type SheetSave = { what: string; run: () => Promise<LibraryAddAnswer> };

/**
 * The Library page's sheets, the one `sheet` names: Add runtime (a Java version, handed up as `addRuntime`) and Add
 * pack (a link, an Actions artifact or an upload through `Uploader`, name and version guessed from the file name). It
 * holds their forms: the page's `open` resets them as it opens a sheet, and Add to library hands the add up as a
 * `SheetSave`, as the page runs every request with its buttons disabled.
 */
@Component({
  selector: 'app-library-sheet',
  host: { class: 'contents' },
  imports: [DecimalPipe, HlmButton, HlmInput, HlmSheetImports, HlmSpinner, HlmToggleGroupImports],
  template: `
    @if (sheet() === 'runtime') {
      <hlm-sheet side="right" state="open" (closed)="closed.emit()">
        <hlm-sheet-content *hlmSheetPortal="let ctx" class="data-[side=right]:w-full data-[side=right]:sm:max-w-md" data-sheet>
          <hlm-sheet-header>
            <h2 hlmSheetTitle>Add runtime</h2>
          </hlm-sheet-header>
          <div class="flex flex-col gap-3 px-4 pb-4 text-sm">
            <p>Java version</p>
            <hlm-toggle-group type="single" [value]="feature()" (valueChange)="feature.set($any($event) || feature())" class="w-full">
              @for (f of features; track f) {
                <button hlmToggleGroupItem [value]="f" class="flex-1" [attr.data-feature]="f">{{ f }}</button>
              }
            </hlm-toggle-group>
            <p class="text-xs text-muted-foreground">
              The latest GA Temurin JDK of that version for this host, checked against Adoptium's sha256 and installed only once java -version runs here.
              A newer build becomes its own entry.
            </p>
            <button hlmBtn [disabled]="busy()" (click)="addRuntime.emit(feature())" data-go>
              @if (busy()) {
                <hlm-spinner />
              }
              Add Temurin {{ feature() }}
            </button>
          </div>
        </hlm-sheet-content>
      </hlm-sheet>
    }

    @if (sheet() === 'pack') {
      <hlm-sheet side="right" state="open" (closed)="closed.emit()">
        <hlm-sheet-content *hlmSheetPortal="let ctx" class="data-[side=right]:w-full data-[side=right]:sm:max-w-md" data-sheet>
          <hlm-sheet-header>
            <h2 hlmSheetTitle>Add pack</h2>
          </hlm-sheet-header>
          <div class="flex flex-col gap-3 px-4 pb-4 text-sm">
            <hlm-toggle-group type="single" [value]="from()" (valueChange)="from.set($any($event) || from())" class="w-full">
              <button hlmToggleGroupItem value="url" class="flex-1" data-from-url>Link</button>
              <button hlmToggleGroupItem value="artifact" class="flex-1" data-from-artifact>Actions artifact</button>
              <button hlmToggleGroupItem value="upload" class="flex-1" data-from-upload>Upload</button>
            </hlm-toggle-group>
            @if (from() === 'url') {
              <label>Pack URL <input hlmInput class="mt-1 w-full" [value]="url()" (input)="setUrl($any($event.target).value)" data-url /></label>
            } @else if (from() === 'artifact') {
              <label
                >Artifact link
                <input
                  hlmInput
                  class="mt-1 w-full"
                  placeholder="https://github.com/…/actions/runs/…/artifacts/…"
                  [value]="artifact()"
                  (input)="artifact.set($any($event.target).value)"
                  data-artifact
              /></label>
              <p class="text-xs text-muted-foreground">The hub fetches it with its own GitHub token: no expiring blob link to copy.</p>
            } @else {
              <label>Zip <input type="file" accept=".zip" hlmInput class="mt-1 w-full" (change)="setFile($any($event.target).files?.[0])" data-file /></label>
            }
            <div class="grid grid-cols-2 gap-2">
              <label>Name <input hlmInput class="mt-1 w-full" [value]="name()" (input)="name.set($any($event.target).value)" data-name /></label>
              <label>Version <input hlmInput class="mt-1 w-full" [value]="version()" (input)="version.set($any($event.target).value)" data-version /></label>
              <label>Minecraft <input hlmInput class="mt-1 w-full" placeholder="from the zip" [value]="mc()" (input)="mc.set($any($event.target).value)" data-mc /></label>
              <label>Loader <input hlmInput class="mt-1 w-full" placeholder="from the zip" [value]="loader()" (input)="loader.set($any($event.target).value)" data-loader /></label>
            </div>
            <p class="text-xs text-muted-foreground">
              Name and version are read from the file name; fix them if wrong. Left blank, the Minecraft version and loader are read from the zip's Forge jar.
            </p>
            <button hlmBtn [disabled]="busy() || !ready()" (click)="add()" data-go>
              @if (busy()) {
                <hlm-spinner />
              }
              Add to library
            </button>
            @if (uploaded() !== null) {
              <p class="text-xs text-muted-foreground" data-uploaded>Uploading… {{ uploaded()! * 100 | number: '1.0-0' }}%</p>
            }
            <p class="text-xs text-muted-foreground">It runs in the background: you can leave the page.</p>
          </div>
        </hlm-sheet-content>
      </hlm-sheet>
    }
  `,
})
export class LibrarySheet {
  readonly #http = inject(HttpClient);
  readonly #uploader = inject(Uploader);

  readonly sheet = input.required<'pack' | 'runtime' | null>();
  readonly busy = input.required<boolean>();
  readonly closed = output();
  readonly save = output<SheetSave>();
  readonly addRuntime = output<RuntimeAddRequest['feature']>();

  protected readonly uploaded = signal<number | null>(null);
  protected readonly features: RuntimeAddRequest['feature'][] = [8, 17, 21, 25];
  protected readonly feature = signal<RuntimeAddRequest['feature']>(21);
  protected readonly from = signal<'url' | 'artifact' | 'upload'>('url');
  protected readonly url = signal('');
  protected readonly artifact = signal('');
  protected readonly file = signal<File | null>(null);
  protected readonly name = signal('');
  protected readonly version = signal('');
  protected readonly mc = signal('');
  protected readonly loader = signal('');
  protected readonly ready = computed(
    () =>
      (this.from() === 'url' ? /^https:\/\//.test(this.url().trim()) : this.from() === 'artifact' ? ARTIFACT.test(this.artifact().trim()) : !!this.file()) &&
      !!this.name().trim() &&
      !!this.version().trim(),
  );

  /** Resets the form for the sheet the page is opening. */
  open(kind: 'pack' | 'runtime'): void {
    if (kind === 'pack') {
      for (const s of [this.url, this.name, this.version, this.mc, this.loader]) s.set('');
      this.file.set(null);
    } else {
      this.feature.set(21);
    }
  }

  protected setUrl(url: string): void {
    this.url.set(url);
    this.#guess(url);
  }

  protected setFile(file: File | undefined): void {
    this.file.set(file ?? null);
    if (file) this.#guess(file.name);
  }

  #guess(file: string): void {
    const { name, version } = fromFileName(file);
    if (name) this.name.set(name);
    if (version) this.version.set(version);
  }

  protected add(): void {
    const fields = { name: this.name().trim(), version: this.version().trim(), mc: this.mc().trim(), loader: this.loader().trim() };
    this.save.emit({
      what: `Adding ${fields.name} ${fields.version}`,
      run: async () => {
        let body: LibraryAddRequest;
        if (this.from() === 'url') body = { url: this.url().trim(), ...fields };
        else if (this.from() === 'artifact') body = { url: this.artifact().trim(), ...fields };
        else {
          this.uploaded.set(0);
          try {
            body = { upload: await this.#uploader.send(this.file()!, (share) => this.uploaded.set(share)), ...fields };
          } finally {
            this.uploaded.set(null);
          }
        }
        return firstValueFrom(this.#http.post<LibraryAddAnswer>('/api/library/packs', body));
      },
    });
  }
}

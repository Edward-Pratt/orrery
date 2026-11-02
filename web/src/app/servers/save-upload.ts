import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { SaveUploadAnswer, SaveUploadRequest } from '@hub/api';
import { HlmButton } from '@spartan-ng/helm/button';
import { HlmSpinner } from '@spartan-ng/helm/spinner';
import { filter, firstValueFrom } from 'rxjs';
import { LiveEvents, ofServer } from '../events';
import { Uploader } from '../uploads';
import ServerPage from './server';

type UploadState = { state: 'uploading' | 'sending' | 'storing' | 'done' | 'failed'; text: string };

/** The largest save the hub takes. */
const MAX = 1024 ** 3;

/**
 * Upload save… on a factorio server's Saves tab (`features.upload`): the file to the hub (`Uploader`), then
 * `POST …/saves`, which has the hub send it to the server's Agent; how that goes comes as `saveUpload` notes on the
 * stream, shown as one line. A note the stream replays from before the tab opened shows only while it is still
 * running, so an old "Stored as…" never comes back. Loading the stored save is a restore, from the list.
 */
@Component({
  selector: 'app-save-upload',
  imports: [HlmButton, HlmSpinner],
  template: `
    <input #file type="file" accept=".zip,application/zip" class="sr-only" tabindex="-1" aria-hidden="true" (change)="upload(file)" data-upload-file />
    <button hlmBtn size="sm" variant="outline" [disabled]="busy()" (click)="file.click()" data-upload>Upload save…</button>
    @if (state(); as u) {
      <div
        class="mt-3 flex w-full flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-sm"
        [class]="u.state === 'failed' ? 'bg-destructive/10' : u.state === 'done' ? 'bg-emerald-500/10' : 'bg-muted'"
        role="status"
        aria-live="polite"
        data-upload-state
      >
        @if (!ended(u)) {
          <hlm-spinner />
        }
        <span class="flex-1">{{ u.text }}</span>
        @if (ended(u)) {
          <button hlmBtn size="sm" variant="ghost" (click)="state.set(null)" data-upload-dismiss>Dismiss</button>
        }
      </div>
    }
  `,
  host: { class: 'contents' },
})
export class SaveUpload {
  readonly #server = inject(ServerPage);
  readonly #http = inject(HttpClient);
  readonly #uploader = inject(Uploader);
  /** An end the stream replays from before this tab opened is old news. */
  readonly #since = Date.now() - 1000;
  readonly state = signal<UploadState | null>(null);
  protected readonly ended = (u: UploadState) => u.state === 'done' || u.state === 'failed';
  protected readonly busy = () => {
    const u = this.state();
    return u !== null && !this.ended(u);
  };

  constructor() {
    inject(LiveEvents)
      .all$.pipe(filter(ofServer(this.#server.id)), takeUntilDestroyed())
      .subscribe(({ event: e }) => {
        if (e.type !== 'notice' || e.kind !== 'saveUpload') return;
        if ((e.state === 'done' || e.state === 'failed') && e.at < this.#since) return;
        this.state.set({ state: e.state, text: noteText(e) });
        if (e.state === 'done') this.#server.refresh();
      });
  }

  /** Sends the picked file to the hub, then asks it to pass it to the server's Agent; the rest follows on the stream. */
  async upload(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = ''; // the same file can be picked again
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) return this.state.set({ state: 'failed', text: 'A Factorio save is a .zip file.' });
    if (file.size > MAX) return this.state.set({ state: 'failed', text: 'Saves are at most 1 GiB.' });
    const id = this.#server.id;
    const progress = (share: number) => this.state.set({ state: 'uploading', text: `Uploading ${file.name}: ${Math.floor(share * 100)}%` });
    progress(0);
    try {
      const upload = await this.#uploader.send(file, progress);
      await firstValueFrom(this.#http.post<SaveUploadAnswer>(`/api/servers/${encodeURIComponent(id)}/saves`, { upload } satisfies SaveUploadRequest));
      // Until the stream's first note, the hub has the file.
      if (this.state()?.state === 'uploading') this.state.set({ state: 'sending', text: `Sending ${file.name} to the server…` });
    } catch (err) {
      this.state.set({ state: 'failed', text: `Uploading ${file.name} failed: ${why(err)}` });
    }
  }
}

/** A `saveUpload` note as one line. */
export function noteText(e: { state: UploadState['state']; file: string; sent: number; size: number; name?: string; error?: string }): string {
  const pct = e.size ? Math.floor((e.sent / e.size) * 100) : 0;
  switch (e.state) {
    case 'sending':
      return `Sending ${e.file} to the server: ${pct}%`;
    case 'storing':
      return `The server is checking ${e.file}…`;
    case 'done':
      return `Stored ${e.file} as ${e.name}. To load it: stop the server, then Restore it from the list below.`;
    default:
      return `Uploading ${e.file} failed: ${e.error}`;
  }
}

/** The hub's refusal text, or what went wrong. */
export function why(err: unknown): string {
  if (!(err instanceof HttpErrorResponse)) return (err as Error).message;
  if (typeof err.error === 'string' && err.error) return err.error;
  return err.status === 404 ? 'this hub has no save uploads yet: deploy hub-v2.19.0 or later.' : err.message;
}

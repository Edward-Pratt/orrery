import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import type { UploadAnswer, UploadProgress, UploadRequest } from '@hub/api';
import { firstValueFrom } from 'rxjs';

/** Under Cloudflare's 100 MB body limit, and the hub's 64 MiB chunk limit. */
export const CHUNK = 50 * 1024 ** 2;
export const TRIES = 3;
/** The wait before a chunk's nth retry is n times this. */
export const RETRY_MS = 1_000;

/** Sends a file to the hub in chunks, for a pack source or an Extra; a failed chunk is retried from what arrived. */
@Injectable({ providedIn: 'root' })
export class Uploader {
  readonly #http = inject(HttpClient);

  /** Uploads `file`, reporting the share sent (0–1) after each chunk; resolves with its upload id. */
  async send(file: Blob & { name: string }, progress: (share: number) => void = () => {}): Promise<string> {
    const body: UploadRequest = { fileName: file.name, size: file.size };
    const { upload } = await firstValueFrom(this.#http.post<UploadAnswer>('/api/uploads', body));
    const url = `/api/uploads/${upload}`;
    let at = 0;
    for (let retry = 0; at < file.size; ) {
      try {
        if (retry) at = (await firstValueFrom(this.#http.get<UploadProgress>(url))).received;
        const chunk = file.slice(at, at + CHUNK);
        const sent = this.#http.put<UploadProgress>(url, chunk, { params: { offset: at }, headers: { 'content-type': 'application/octet-stream' } });
        at = (await firstValueFrom(sent)).received;
        retry = 0;
        progress(at / file.size);
      } catch (err) {
        if (!(err instanceof HttpErrorResponse) || err.status === 401 || ++retry > TRIES) throw err;
        await new Promise((resolve) => setTimeout(resolve, retry * RETRY_MS));
      }
    }
    return upload;
  }
}

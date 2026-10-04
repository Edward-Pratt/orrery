import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { CHUNK, RETRY_MS, Uploader } from './uploads';

/** A file of `size` bytes whose slices say which bytes they are. */
const file = (size: number) => ({ name: 'GTNH_2.7.5.zip', size, slice: (a: number, b: number) => `${a}-${Math.min(b, size)}` }) as unknown as File;

function setup() {
  vi.useFakeTimers();
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  return { uploader: TestBed.inject(Uploader), backend: TestBed.inject(HttpTestingController) };
}

describe('Uploader', () => {
  afterEach(() => vi.useRealTimers());

  it('sends chunks in order with progress, and after a failed chunk asks what arrived and resumes from there', async () => {
    const { uploader, backend } = setup();
    const progress: number[] = [];
    const size = 2.5 * CHUNK;
    let done: string | undefined;
    void uploader.send(file(size), (share) => progress.push(share)).then((id) => (done = id));
    const start = backend.expectOne('/api/uploads');
    expect(start.request.body).toEqual({ fileName: 'GTNH_2.7.5.zip', size });
    start.flush({ upload: 'u1' });
    await vi.advanceTimersByTimeAsync(0);
    const first = backend.expectOne('/api/uploads/u1?offset=0');
    expect([first.request.method, first.request.body, first.request.headers.get('content-type')]).toEqual(['PUT', `0-${CHUNK}`, 'application/octet-stream']);
    first.flush({ received: CHUNK });
    await vi.advanceTimersByTimeAsync(0);
    backend.expectOne(`/api/uploads/u1?offset=${CHUNK}`).error(new ProgressEvent('error')); // the connection dropped
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    backend.expectOne((r) => r.method === 'GET' && r.url === '/api/uploads/u1').flush({ received: 2 * CHUNK }); // it had arrived
    await vi.advanceTimersByTimeAsync(0);
    const third = backend.expectOne(`/api/uploads/u1?offset=${2 * CHUNK}`);
    expect(third.request.body).toBe(`${2 * CHUNK}-${size}`);
    third.flush({ received: 2 * CHUNK }, { status: 409, statusText: 'Conflict' }); // a second failure in a row waits longer
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    backend.expectNone((r) => r.method === 'GET');
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    backend.expectOne((r) => r.method === 'GET').flush({ received: 2 * CHUNK });
    await vi.advanceTimersByTimeAsync(0);
    backend.expectOne(`/api/uploads/u1?offset=${2 * CHUNK}`).flush({ received: size });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe('u1');
    expect(progress).toEqual([0.4, 1]);
    backend.verify();
  });

  it('gives up after a chunk fails three retries in a row', async () => {
    const { uploader, backend } = setup();
    let failed: unknown;
    void uploader.send(file(10)).catch((err) => (failed = err));
    backend.expectOne('/api/uploads').flush({ upload: 'u1' });
    await vi.advanceTimersByTimeAsync(0);
    backend.expectOne('/api/uploads/u1?offset=0').error(new ProgressEvent('error'));
    for (let retry = 1; retry <= 3; retry++) {
      await vi.advanceTimersByTimeAsync(retry * RETRY_MS);
      backend.expectOne((r) => r.method === 'GET').flush({ received: 0 });
      await vi.advanceTimersByTimeAsync(0);
      backend.expectOne('/api/uploads/u1?offset=0').error(new ProgressEvent('error'));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toBeDefined();
    backend.verify();
  });
});

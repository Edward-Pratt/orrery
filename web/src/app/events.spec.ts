import { TestBed } from '@angular/core/testing';
import type { LiveEvent } from '@hub/api';
import { FETCH, Live, LiveEvents, ofServer, RETRY_MS } from './events';
import { fakeEvents, settle } from './testing';

const chat = (message: string): LiveEvent => ({ serverId: 'gtnh', type: 'chat', player: 'Steve', message });

describe('LiveEvents', () => {
  it('gives the replay, then live events, then resumes after the last id when the stream drops', async () => {
    const backend = fakeEvents();
    TestBed.configureTestingModule({
      providers: [
        { provide: FETCH, useValue: backend.fetch },
        { provide: RETRY_MS, useValue: 0 },
      ],
    });
    const seen: Live[] = [];
    const sub = TestBed.inject(LiveEvents).all$.subscribe((e) => seen.push(e));
    await settle();
    backend.push(1, chat('replayed'));
    backend.comment();
    backend.push(2, chat('live'));
    await settle();
    backend.drop();
    await settle();
    backend.push(2, chat('live')); // a hub that sends it again: not a duplicate
    backend.push(3, chat('after the drop'));
    await settle();
    sub.unsubscribe();

    expect(backend.requests).toEqual([null, '2']);
    expect(seen).toEqual([
      { id: 1, event: chat('replayed') },
      { id: 2, event: chat('live') },
      { id: 3, event: chat('after the drop') },
    ]);
  });
});

describe('LiveEvents streams', () => {
  it('bypass the HTTP cache, so two open at once (a page and its section) never wait on each other', async () => {
    const backend = fakeEvents();
    const caches: (RequestCache | undefined)[] = [];
    TestBed.configureTestingModule({
      providers: [
        { provide: FETCH, useValue: ((url, init) => (caches.push(init?.cache), backend.fetch(url, init))) as typeof fetch },
        { provide: RETRY_MS, useValue: 0 },
      ],
    });
    const live = TestBed.inject(LiveEvents);
    const seen: string[] = [];
    const subs = ['page', 'section'].map((who) => live.all$.subscribe(() => seen.push(who)));
    await settle();
    backend.push(1, chat('hi'));
    await settle();
    subs.forEach((s) => s.unsubscribe());
    expect(caches).toEqual(['no-store', 'no-store']);
    expect(seen.sort()).toEqual(['page', 'section']);
  });
});

describe('ofServer', () => {
  it("keeps a server's own events, not a check's with the same id", () => {
    const check: LiveEvent = { target: 'check', id: 'gtnh', type: 'notice', severity: 'problem', kind: 'checkDown', url: 'https://x', error: 'HTTP 503' };
    const events: Live[] = [
      { id: 1, event: chat('mine') },
      { id: 2, event: check },
      { id: 3, event: { serverId: 'other', type: 'started' } },
    ];
    expect(events.filter(ofServer('gtnh')).map((l) => l.id)).toEqual([1]);
  });
});

import { TestBed } from '@angular/core/testing';
import type { LiveEvent } from '@hub/api';
import { FETCH, Live, LiveEvents, RETRY_MS } from './events';
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

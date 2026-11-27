import { TestBed } from '@angular/core/testing';
import type { LiveEvent } from '@hub/api';
import { BackupProgress } from './backup-progress';

const finished = (serverId: string): LiveEvent => ({ at: 0, serverId, type: 'notice', severity: 'good', kind: 'backupFinished', detail: 'done' });

describe('BackupProgress', () => {
  it("ignores a replay of the last backup's notice, and ends on the next one", () => {
    const progress = TestBed.inject(BackupProgress);
    progress.seen({ id: 5, event: finished('gtnh') }); // the last backup, before this one began
    progress.begin('gtnh', 'backup');
    progress.seen({ id: 5, event: finished('gtnh') }); // a new stream (the server page opened again) replays it
    expect(progress.running()).toEqual({ gtnh: 'backup' });
    progress.seen({ id: 6, event: finished('other') });
    expect(progress.running()).toEqual({ gtnh: 'backup' });
    progress.seen({ id: 7, event: finished('gtnh') });
    expect(progress.running()).toEqual({});
  });
});

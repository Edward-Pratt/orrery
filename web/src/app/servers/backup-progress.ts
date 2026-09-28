import { Injectable, signal } from '@angular/core';
import type { LiveEvent } from '@hub/api';

/**
 * Backups and restores under way, by server id. A backup runs until its finished or failed notice arrives on the live
 * feed; a restore until its request answers. The hub sends no start event, so only ones started from this browser show.
 */
@Injectable({ providedIn: 'root' })
export class BackupProgress {
  readonly running = signal<Record<string, 'backup' | 'restore'>>({});

  begin(serverId: string, kind: 'backup' | 'restore'): void {
    this.running.update((r) => ({ ...r, [serverId]: kind }));
  }

  end(serverId: string): void {
    this.running.update(({ [serverId]: _, ...rest }) => rest);
  }

  /** Ends a backup a finished or failed notice reports. */
  seen(event: LiveEvent): void {
    if ('serverId' in event && event.type === 'notice' && (event.kind === 'backupFinished' || event.kind === 'backupFailed') && this.running()[event.serverId] === 'backup') {
      this.end(event.serverId);
    }
  }
}

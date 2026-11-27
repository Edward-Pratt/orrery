import { Injectable, signal } from '@angular/core';
import type { Live } from '../events';

/**
 * Backups and restores under way, by server id. A backup runs until its finished or failed notice arrives on the live
 * feed; a restore until its request answers. The hub sends no start event, so only ones started from this browser show.
 * A notice counts only with a stream id above the newest one seen when the backup began: a new stream's replay of the
 * last backup's notice (opening the server page again) must not end one still running. Ids, not times: the hub's ids
 * only rise, and the browser's clock may be off from the hub's.
 */
@Injectable({ providedIn: 'root' })
export class BackupProgress {
  readonly running = signal<Record<string, 'backup' | 'restore'>>({});
  /** The newest stream id `seen` has had, on any stream. */
  #lastId = 0;
  /** By server id: `#lastId` when its backup began. */
  readonly #since = new Map<string, number>();

  begin(serverId: string, kind: 'backup' | 'restore'): void {
    this.#since.set(serverId, this.#lastId);
    this.running.update((r) => ({ ...r, [serverId]: kind }));
  }

  end(serverId: string): void {
    this.running.update(({ [serverId]: _, ...rest }) => rest);
  }

  /** Ends a backup a finished or failed notice newer than its start reports. */
  seen({ id, event }: Live): void {
    const since = 'serverId' in event ? this.#since.get(event.serverId) ?? 0 : 0;
    this.#lastId = Math.max(this.#lastId, id);
    if ('serverId' in event && event.type === 'notice' && (event.kind === 'backupFinished' || event.kind === 'backupFailed') && this.running()[event.serverId] === 'backup' && id > since) {
      this.end(event.serverId);
    }
  }
}

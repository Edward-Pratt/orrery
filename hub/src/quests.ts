import type { QuestDone } from './protocol.ts';

export type QuestMode = 'batched' | 'main' | 'all' | 'off';
export const QUEST_MODES: readonly QuestMode[] = ['batched', 'main', 'all', 'off'];

/** `quests` to name; `count` is the total (greater than quests.length for a batched roll-up). */
export type QuestBatch = { serverId: string; player: string; quests: QuestDone[]; count: number };

/**
 * Decides which quest completions get posted: main quests at once, the rest by mode (`batched` rolls them up per
 * player every 10 minutes). Hub core: works on plain data, `emit` does the posting.
 */
export class QuestAnnouncer {
  #modes: Record<string, QuestMode>;
  #emit: (batch: QuestBatch) => void;
  #pending = new Map<string, { serverId: string; player: string; count: number; latest: QuestDone }>();
  #timer: NodeJS.Timeout | undefined;

  constructor(modes: Record<string, QuestMode>, emit: (batch: QuestBatch) => void) {
    this.#modes = modes;
    this.#emit = emit;
  }

  start(intervalMs = 10 * 60_000): void {
    this.#timer = setInterval(() => this.flush(), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    clearInterval(this.#timer);
  }

  add(serverId: string, player: string, quests: QuestDone[]): void {
    const mode = this.#modes[serverId];
    if (mode === 'off') return;
    const now = mode === 'all' ? quests : quests.filter((q) => q.main);
    if (now.length) this.#emit({ serverId, player, quests: now, count: now.length });
    const later = quests.filter((q) => !q.main);
    if (mode !== 'batched' || !later.length) return;
    const key = `${serverId}\u0000${player}`;
    const p = this.#pending.get(key) ?? { serverId, player, count: 0, latest: later[0] };
    p.count += later.length;
    p.latest = later[later.length - 1];
    this.#pending.set(key, p);
  }

  /** Posts one roll-up line per player with batched quests, then starts over. */
  flush(): void {
    for (const p of this.#pending.values()) this.#emit({ serverId: p.serverId, player: p.player, quests: [p.latest], count: p.count });
    this.#pending.clear();
  }
}

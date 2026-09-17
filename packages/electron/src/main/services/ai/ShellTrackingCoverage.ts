import {
  hasShellCoverageGap,
  type ShellCoverageCounts,
  type ShellCoverageReason,
  type ShellCoverageSummary,
} from '@nimbalyst/runtime/ai/shellTrackingCoverage';

export interface StoredShellCoverage extends ShellCoverageSummary {
  version: 1;
  active: string[];
}
interface Dependencies {
  load(sessionId: string): Promise<StoredShellCoverage | undefined>;
  save(sessionId: string, value: StoredShellCoverage): Promise<void>;
  notify(sessionId: string): void;
}
interface Entry {
  data: StoredShellCoverage;
  dirty: boolean;
  loadFailed?: boolean;
  lastWriteFailed?: boolean;
  writing?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}
/** Returns on timeout without cancelling or starting a competing database write. */
export async function boundedDrain(work: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => false
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Single writer per session; cumulative reasons survive the bounded turn history. */
export class ShellTrackingCoverage {
  private entries = new Map<string, Entry>();
  private loads = new Map<string, Promise<Entry>>();
  private owners = new Map<string, { sessionId: string; turnId?: string }>();
  constructor(private readonly deps: Dependencies) {}

  private async load(sessionId: string): Promise<Entry> {
    const cached = this.entries.get(sessionId);
    if (cached) return cached;
    const existing = this.loads.get(sessionId);
    if (existing) return existing;
    const promise = (async () => {
      let stored: StoredShellCoverage | undefined;
      let failed = false;
      // A stalled diagnostic store must not prevent native tools from running.
      const loaded = await boundedDrain(
        this.deps.load(sessionId).then((value) => {
          stored = value;
        }),
        1000
      );
      failed = !loaded;
      const data: StoredShellCoverage =
        stored?.version === 1
          ? structuredClone(stored)
          : {
              version: 1,
              sessionId,
              state: 'unknown',
              reasons: {},
              turns: [],
              active: [],
            };
      const entry: Entry = { data, dirty: false, loadFailed: failed };
      this.entries.set(sessionId, entry);
      if (failed) this.add(entry, 'coveragePersistence');
      if (data.active.length) {
        this.add(entry, 'interrupted');
        data.active = [];
      }
      // Idle entries are reloadable. Never evict unsaved evidence or live owners.
      if (this.entries.size > 256)
        for (const [id, candidate] of this.entries) {
          if (
            id !== sessionId &&
            !candidate.dirty &&
            !candidate.writing &&
            !candidate.data.active.length &&
            ![...this.owners.values()].some((owner) => owner.sessionId === id)
          ) {
            this.entries.delete(id);
            if (this.entries.size <= 256) break;
          }
        }
      return entry;
    })().finally(() => this.loads.delete(sessionId));
    this.loads.set(sessionId, promise);
    return promise;
  }
  async open(sessionId: string, generation: string): Promise<void> {
    const entry = await this.load(sessionId);
    this.owners.set(generation, { sessionId });
    // Active means unfinished work, not merely an idle cached provider.
    entry.data.state = hasShellCoverageGap(entry.data.reasons) ? 'degraded' : 'no-detected-fault';
    this.touch(entry);
  }
  turn(generation: string, turnId: string): void {
    const owner = this.owners.get(generation);
    if (!owner || owner.turnId === turnId) return;
    const entry = this.entries.get(owner.sessionId)!;
    owner.turnId = turnId;
    if (!entry.data.active.includes(generation)) entry.data.active.push(generation);
    const now = Date.now();
    entry.data.turns.push({ turnId, firstAt: now, lastAt: now, reasons: {} });
    if (entry.data.turns.length > 32) entry.data.turns.shift();
    this.touch(entry);
    // Persist the unfinished marker promptly so restart can reveal interruption.
    void this.write(entry);
  }
  endTurn(generation: string, turnId?: string): void {
    const owner = this.owners.get(generation);
    if (!owner || (turnId && owner.turnId !== turnId)) return;
    const entry = this.entries.get(owner.sessionId)!;
    owner.turnId = undefined;
    entry.data.active = entry.data.active.filter((id) => id !== generation);
    this.touch(entry);
  }
  record(generation: string, reason: ShellCoverageReason, turnId?: string): void {
    const owner = this.owners.get(generation);
    if (!owner) return;
    const entry = this.entries.get(owner.sessionId)!;
    this.add(entry, reason, turnId ?? owner.turnId);
  }
  async reportSession(sessionId: string, reason: ShellCoverageReason): Promise<void> {
    this.add(await this.load(sessionId), reason);
  }
  currentTurn(generation: string): string | undefined {
    return this.owners.get(generation)?.turnId;
  }
  async unavailable(sessionId: string): Promise<void> {
    this.add(await this.load(sessionId), 'unavailable');
  }
  private add(entry: Entry, reason: ShellCoverageReason, turnId?: string): void {
    const now = Date.now();
    const increment = (counts: ShellCoverageCounts) => {
      counts[reason] = Math.min(1_000_000, (counts[reason] ?? 0) + 1);
    };
    increment(entry.data.reasons);
    if (turnId) {
      const turn = [...entry.data.turns].reverse().find((t) => t.turnId === turnId);
      if (turn) {
        increment(turn.reasons);
        turn.lastAt = now;
      }
    }
    entry.data.firstAt ??= now;
    entry.data.lastAt = now;
    if (hasShellCoverageGap(entry.data.reasons))
      entry.data.state = reason === 'unavailable' ? 'unavailable' : 'degraded';
    this.touch(entry);
  }
  private touch(entry: Entry): void {
    entry.dirty = true;
    if (!entry.timer)
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        this.deps.notify(entry.data.sessionId);
        void this.write(entry);
      }, 500);
  }
  private write(entry: Entry): Promise<void> {
    if (entry.writing) return entry.writing;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    if (!entry.dirty) return Promise.resolve();
    entry.writing = (async () => {
      entry.lastWriteFailed = false;
      if (entry.loadFailed) {
        let previous: StoredShellCoverage | undefined;
        if (
          !(await boundedDrain(
            this.deps.load(entry.data.sessionId).then((value) => {
              previous = value;
            }),
            1000
          ))
        ) {
          entry.lastWriteFailed = true;
          return;
        }
        if (previous) {
          for (const [reason, count] of Object.entries(previous.reasons)) {
            const key = reason as ShellCoverageReason;
            entry.data.reasons[key] = Math.min(1_000_000, (entry.data.reasons[key] ?? 0) + (count ?? 0));
          }
          entry.data.turns = [...previous.turns, ...entry.data.turns].slice(-32);
          entry.data.firstAt = previous.firstAt ?? entry.data.firstAt;
          if (previous.active.some((id) => !this.owners.has(id))) this.add(entry, 'interrupted');
        }
        entry.loadFailed = false;
      }
      // One snapshot per background batch; explicit flush drains remaining work.
      if (entry.dirty) {
        entry.dirty = false;
        const snapshot = structuredClone(entry.data);
        let saved = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            await this.deps.save(snapshot.sessionId, snapshot);
            saved = true;
            break;
          } catch {
            if (attempt < 2) await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          }
        }
        if (!saved) {
          entry.data.reasons.coveragePersistence = Math.min(
            1_000_000,
            (entry.data.reasons.coveragePersistence ?? 0) + 1
          );
          entry.data.state = 'degraded';
          entry.dirty = true;
          entry.lastWriteFailed = true;
          this.deps.notify(entry.data.sessionId);
          return;
        }
        this.deps.notify(entry.data.sessionId);
      }
    })().finally(() => {
      entry.writing = undefined;
      if (entry.dirty && !entry.lastWriteFailed) this.touch(entry);
    });
    return entry.writing;
  }
  async flush(sessionIds: string[], timeoutMs = 1500): Promise<boolean> {
    const drained = await boundedDrain(
      Promise.all(
        sessionIds.map(async (id) => {
          const entry = this.entries.get(id);
          if (!entry) return;
          do {
            await this.write(entry);
            if (entry.lastWriteFailed) return;
          } while (entry.dirty);
        })
      ),
      timeoutMs
    );
    return drained && sessionIds.every((id) => !this.entries.get(id)?.dirty);
  }
  async readMany(sessionIds: string[]): Promise<ShellCoverageSummary[]> {
    return Promise.all(
      [...new Set(sessionIds)].slice(0, 256).map(async (id) => {
        const entry = await this.load(id);
        return structuredClone(entry.data);
      })
    );
  }
  async close(generation: string): Promise<void> {
    const owner = this.owners.get(generation);
    if (!owner) return;
    if (owner.turnId) this.record(generation, 'interrupted');
    this.endTurn(generation);
    this.owners.delete(generation);
    await this.flush([owner.sessionId]);
  }
}

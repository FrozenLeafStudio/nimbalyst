// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { ShellFileAttribution, type ShellFileState, type ShellFileEvidence, type ShellPersistenceOutcome } from '../ShellFileAttribution';

function fixture(beforeRead?: () => Promise<void>) {
  let now = 1000;
  let emit: (file: string) => void = () => {};
  const state = new Map<string, ShellFileState>();
  const known = new Map<string, string>();
  const persist = vi.fn(async (_e: ShellFileEvidence): Promise<ShellPersistenceOutcome> => 'persisted');
  const unsubscribe = vi.fn();
  const report = vi.fn();
  const service = new ShellFileAttribution({
    subscribe: async (_w, fn) => {
      emit = fn;
      return unsubscribe;
    },
    read: async (f) => {
      await beforeRead?.();
      return state.get(f) ?? null;
    },
    knownWrite: (f, s) => known.has(f) && known.get(f) === s?.fingerprint,
    otherSessions: () => [],
    persist,
    report,
    retryDelayMs: 0,
    now: () => now,
    settleMs: 0,
  });
  return {
    service,
    report,
    persist,
    known,
    unsubscribe,
    write: (file: string, fingerprint: string) => {
      now++;
      state.set(file, { fingerprint, modifiedAt: now });
      emit(file);
    },
    event: (file: string) => emit(file),
    advance: () => now++,
  };
}
describe('shell hook attribution', () => {
  it('waits for terminal cleanup that arrives while the next pre-hook is flushing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0;
    const f = fixture(() => ++reads === 1 ? gate : Promise.resolve());
    const a = await f.service.register('A', '/workspace');
    await f.service.pre(a, 'lookup', 'mcp__fixture__fail_lookup');
    f.write('/workspace/during-lookup.ts', 'ambiguous');
    const next = f.service.pre(a, 'next-shell', 'Bash');
    await Promise.resolve();
    const completed = f.service.post(a, 'lookup');
    release();
    await next;
    f.write('/workspace/next.ts', 'owned');
    await f.service.post(a, 'next-shell');
    await completed;
    expect(f.persist.mock.calls.map(([e]) => e.filePath)).toEqual(['/workspace/next.ts']);
    await f.service.release(a);
  });

  it('drains a terminal MCP window before the next shell pre-hook, retaining real overlap', async () => {
    const f = fixture(), a = await f.service.register('A', '/workspace');
    await f.service.pre(a, 'lookup', 'mcp__fixture__fail_lookup');
    await f.service.pre(a, 'overlapping-shell', 'Bash');
    f.write('/workspace/overlap.ts', 'ambiguous');
    await f.service.post(a, 'overlapping-shell');
    // The protocol receives completion but cannot await it before the next hook.
    const completed = f.service.completed(a, 'lookup');
    const duplicate = f.service.completed(a, 'lookup');
    await f.service.pre(a, 'next-shell', 'Bash');
    f.write('/workspace/next.ts', 'owned');
    await f.service.post(a, 'next-shell');
    await Promise.all([completed, duplicate]);
    expect(f.persist.mock.calls.map(([e]) => [e.filePath, e.toolUseId])).toEqual([
      ['/workspace/next.ts', 'next-shell'],
    ]);
    expect(f.service.getStats().ambiguous).toBe(1);
    expect(f.report.mock.calls.map(([, r]) => r)).not.toContain('missingPre');
    await f.service.release(a);
  });

  it('records sequential owners without using a dirty Git baseline or inventing a diff', async () => {
    const f = fixture(),
      a = await f.service.register('A', '/workspace'),
      b = await f.service.register('B', '/workspace');
    f.write('/workspace/shared.ts', 'pre-dirty');
    await f.service.flush();
    await f.service.pre(a, 'read', 'Bash');
    f.event('/workspace/shared.ts');
    await f.service.post(a, 'read');
    expect(f.persist).not.toHaveBeenCalled();
    await f.service.pre(a, 'one', 'Bash');
    f.write('/workspace/shared.ts', 'A');
    await f.service.post(a, 'one');
    await f.service.pre(b, 'two', 'Bash');
    f.write('/workspace/shared.ts', 'B');
    await f.service.post(b, 'two');
    expect(f.persist.mock.calls.map(([e]) => e)).toEqual([
      expect.objectContaining({
        sessionId: 'A',
        toolUseId: 'one',
        source: 'shell-hook-inferred',
        filePath: '/workspace/shared.ts',
      }),
      expect.objectContaining({
        sessionId: 'B',
        toolUseId: 'two',
        source: 'shell-hook-inferred',
        filePath: '/workspace/shared.ts',
      }),
    ]);
    await f.service.release(a);
    expect(f.unsubscribe).not.toHaveBeenCalled();
    await f.service.release(b);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('captures ambiguity at event arrival and suppresses known saves and structured tools', async () => {
    const f = fixture(),
      a = await f.service.register('A', '/workspace'),
      b = await f.service.register('B', '/workspace');
    await f.service.pre(a, 'reader', 'Bash');
    await f.service.pre(b, 'writer', 'Bash');
    f.write('/workspace/b.ts', 'B');
    await f.service.post(b, 'writer');
    await f.service.post(a, 'reader');
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.service.getStats().ambiguous).toBe(1);
    await f.service.pre(a, 'shell', 'Bash');
    f.known.set('/workspace/edit.ts', 'editor');
    f.write('/workspace/edit.ts', 'editor');
    await f.service.flush();
    expect(f.persist).not.toHaveBeenCalled();
    f.write('/workspace/edit.ts', 'agent-after-save');
    await f.service.flush();
    expect(f.persist).toHaveBeenCalledTimes(1);
    await f.service.pre(b, 'patch', 'apply_patch');
    f.write('/workspace/patch.ts', 'patch');
    await f.service.post(b, 'patch');
    await f.service.post(a, 'shell');
    expect(f.persist).toHaveBeenCalledTimes(1);
  });
  it('ignores released generations and never credits outside-workspace paths', async () => {
    const f = fixture(),
      a = await f.service.register('A', '/workspace');
    await f.service.pre(a, 'old', 'Bash');
    await f.service.release(a);
    await f.service.pre(a, 'late', 'Bash');
    f.write('/workspace/late.ts', 'late');
    await f.service.flush();
    expect(f.persist).not.toHaveBeenCalled();
    const b = await f.service.register('B', '/workspace');
    await f.service.pre(b, 'new', 'Bash');
    f.write('/workspace-other/file.ts', 'outside');
    await f.service.post(b, 'new');
    expect(f.persist).not.toHaveBeenCalled();
  });
});

it('abstains after registry overflow until turn cleanup and ignores events between turns', async () => {
  const f = fixture(),
    a = await f.service.register('A', '/workspace');
  for (let i = 0; i < 257; i++) await f.service.pre(a, String(i), 'Bash');
  f.write('/workspace/overflow.ts', 'dropped');
  await f.service.flush();
  expect(f.persist).not.toHaveBeenCalled();
  f.service.endTurn(a);
  f.write('/workspace/late.ts', 'late');
  await f.service.flush();
  expect(f.persist).not.toHaveBeenCalled();
  await f.service.pre(a, 'next', 'Bash');
  f.write('/workspace/next.ts', 'next');
  await f.service.post(a, 'next');
  expect(f.persist).toHaveBeenCalledTimes(1);
  await f.service.release(a);
});

it('keeps an overlapping event ambiguous when one candidate exits before the queued read', async () => {
  const f = fixture(),
    a = await f.service.register('A', '/workspace'),
    b = await f.service.register('B', '/workspace');
  await f.service.pre(a, 'one', 'Bash');
  await f.service.pre(b, 'two', 'Bash');
  f.write('/workspace/mixed.ts', 'B');
  await f.service.release(b);
  await f.service.flush();
  expect(f.persist).not.toHaveBeenCalled();
  await f.service.release(a);
});


it('reports lost pre-hooks and rejects delayed pre-hooks after terminal cleanup', async () => {
  const f = fixture(), a = await f.service.register('A', '/workspace');
  f.service.started(a, 'no-hook');
  f.write('/workspace/missed.ts', 'unknown');
  await f.service.completed(a, 'no-hook');
  await f.service.pre(a, 'no-hook', 'Bash');
  f.write('/workspace/late.ts', 'unknown');
  await f.service.flush();
  expect(f.persist).not.toHaveBeenCalled();
  expect(f.report.mock.calls.map(([, reason]) => reason)).toEqual(expect.arrayContaining(['missingPre', 'staleEvent']));
  await f.service.pre(a, 'good', 'Bash');
  f.write('/workspace/good.ts', 'owned');
  await f.service.post(a, 'good');
  expect(f.persist.mock.calls.map(([e]) => e.filePath)).toEqual(['/workspace/good.ts']);
  await f.service.release(a);
});

it('retries original evidence and reports quota or exhausted saves without recording success', async () => {
  const f = fixture(), a = await f.service.register('A', '/workspace');
  f.persist.mockRejectedValueOnce(Error('busy'));
  await f.service.pre(a, 'first', 'Bash');
  f.write('/workspace/retried.ts', 'A');
  await f.service.completed(a, 'first');
  expect(f.persist).toHaveBeenCalledTimes(2);
  expect(f.persist.mock.calls[0][0]).toEqual(f.persist.mock.calls[1][0]);
  f.persist.mockResolvedValue('throttled');
  await f.service.pre(a, 'second', 'Bash');
  f.write('/workspace/dropped.ts', 'B');
  await f.service.completed(a, 'second');
  expect(f.report.mock.calls.map(([, r]) => r)).toContain('throttled');
  f.persist.mockResolvedValue('quota');
  await f.service.pre(a, 'third', 'Bash');
  f.write('/workspace/quota.ts', 'C');
  await f.service.completed(a, 'third');
  expect(f.report.mock.calls.map(([, r]) => r)).toContain('quota');
  f.persist.mockResolvedValue('persisted');
  await f.service.pre(a, 'fourth', 'Bash');
  f.write('/workspace/dropped.ts', 'D');
  await f.service.completed(a, 'fourth');
  expect(f.persist.mock.calls.at(-1)?.[0].toolUseId).toBe('fourth');
  await f.service.release(a);
});

it('bounds commit drains and preserves uncertainty when both completion signals disappear', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(() => gate), a = await f.service.register('A', '/workspace');
  await f.service.pre(a, 'stuck', 'Bash');
  f.write('/workspace/queued.ts', 'A');
  expect(await f.service.drain(['A'], 5)).toBe(false);
  expect(f.report.mock.calls.map(([, r]) => r)).toContain('drainTimeout');
  f.service.endTurn(a);
  expect(f.report.mock.calls.map(([, r]) => r)).toContain('unmatchedTool');
  release();
  await f.service.flush();
  await f.service.release(a);
});


it('reports watcher loss and recovers on the next turn without importing missed changes', async () => {
  const f = fixture(), a = await f.service.register('A', '/workspace');
  await f.service.pre(a, 'before', 'Bash');
  f.service.watcherLost('/workspace');
  f.write('/workspace/lost.ts', 'unobserved');
  await f.service.post(a, 'before');
  expect(f.persist).not.toHaveBeenCalled();
  expect(f.report.mock.calls.map(([, r]) => r)).toContain('watcherLoss');
  f.service.endTurn(a);
  await f.service.pre(a, 'after', 'Bash');
  f.event('/workspace/lost.ts');
  f.write('/workspace/future.ts', 'observed');
  await f.service.post(a, 'after');
  expect(f.persist.mock.calls.map(([e]) => e.filePath)).toEqual(['/workspace/future.ts']);
  await f.service.release(a);
});

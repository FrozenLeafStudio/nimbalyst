// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { ShellTrackingCoverage } from '../ShellTrackingCoverage';

describe('durable shell coverage', () => {
  it('preserves gaps and interrupted turns across restart without overwriting earlier totals', async () => {
    let disk: any;
    const deps = {
      load: async () => structuredClone(disk),
      save: async (_: string, value: any) => {
        disk = structuredClone(value);
      },
      notify: vi.fn(),
    };
    const first = new ShellTrackingCoverage(deps);
    await first.open('A', 'g1');
    first.turn('g1', 't1');
    first.record('g1', 'throttled');
    await first.flush(['A']);
    const second = new ShellTrackingCoverage(deps);
    await second.open('A', 'g2');
    second.turn('g2', 't2');
    second.endTurn('g2');
    await second.close('g2');
    const [coverage] = await second.readMany(['A']);
    expect(coverage.state).toBe('degraded');
    expect(coverage.reasons).toMatchObject({ throttled: 1, interrupted: 1 });
    expect(coverage.turns.some((t: any) => t.turnId === 't1' && t.reasons.throttled === 1)).toBe(true);
    const third = new ShellTrackingCoverage(deps);
    expect((await third.readMany(['A']))[0].reasons.interrupted).toBe(1);
  });

  it('does not let old cleanup erase a new turn and never overwrites history after a failed read', async () => {
    let disk: any;
    let rejectLoad = false;
    const save = vi.fn(async (_: string, value: any) => {
      disk = structuredClone(value);
    });
    const deps = {
      load: async () => {
        if (rejectLoad) throw Error('read busy');
        return structuredClone(disk);
      },
      save,
      notify: vi.fn(),
    };
    const first = new ShellTrackingCoverage(deps);
    await first.open('A', 'g1');
    first.turn('g1', 'old');
    first.record('g1', 'quota');
    await first.close('g1');
    save.mockClear();
    rejectLoad = true;
    const second = new ShellTrackingCoverage(deps);
    await second.open('A', 'g2');
    second.turn('g2', 'new');
    second.endTurn('g2', 'old');
    await second.flush(['A']);
    expect(save).not.toHaveBeenCalled();
    rejectLoad = false;
    await second.flush(['A']);
    expect(disk.reasons.quota).toBe(1);
    expect(disk.active).toContain('g2');
  });

  it('reports failed durability and bounds drains even when the store never responds', async () => {
    const ledger = new ShellTrackingCoverage({
      load: async () => undefined,
      save: async () => {
        throw Error('disk full');
      },
      notify: vi.fn(),
    });
    await ledger.open('A', 'g');
    ledger.record('g', 'quota');
    await ledger.flush(['A']);
    expect((await ledger.readMany(['A']))[0].reasons).toMatchObject({
      quota: 1,
      coveragePersistence: expect.any(Number),
    });
    const hung = new ShellTrackingCoverage({
      load: async () => undefined,
      save: async () => new Promise(() => {}),
      notify: vi.fn(),
    });
    await hung.open('B', 'h');
    expect(await hung.flush(['B'], 5)).toBe(false);
  });
});

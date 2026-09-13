// @vitest-environment node
/**
 * LOCAL DEBUG ONLY -- drops with the debug commit.
 *
 * The point of this logger is the case the older raw-response log could not
 * see: a turn that TIMES OUT never reaches the append, so it produced no
 * record at all. These assert the failure paths write, not the happy path.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AntigravityServerManager } from '../AntigravityServerManager';

type AntigravityEndpoint = Awaited<ReturnType<AntigravityServerManager['ensureRunning']>>;
type Testable = {
  ensureRunning: () => Promise<AntigravityEndpoint>;
  isHealthy: (ep: AntigravityEndpoint) => Promise<boolean>;
  rpc: <T = unknown>(m: string, b: unknown, ep: AntigravityEndpoint, t?: number) => Promise<T>;
};

const EP = { httpsPort: 51717, csrf: 'x', owned: true } as const;

let dir: string;
let logFile: string;

function events(): Array<Record<string, unknown>> {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function freshManager(): AntigravityServerManager {
  (AntigravityServerManager as unknown as { instance: unknown }).instance = null;
  return AntigravityServerManager.shared();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gemini-debuglog-'));
  logFile = join(dir, 'events.jsonl');
  process.env.NIMBALYST_GEMINI_DEBUG_LOG = logFile;
});

afterEach(() => {
  delete process.env.NIMBALYST_GEMINI_DEBUG_LOG;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('gemini debug log', () => {
  it('records a timeout, which is the case the raw-response log could not see', async () => {
    const m = freshManager();
    const tm = m as unknown as Testable;
    vi.spyOn(tm, 'ensureRunning').mockResolvedValue(EP);
    vi.spyOn(tm, 'isHealthy').mockResolvedValue(true);
    vi.spyOn(tm, 'rpc').mockRejectedValue(
      new Error('Antigravity GetModelResponse timed out after 90s'),
    );

    await expect(m.getModelResponse('a'.repeat(22_000), 'MODEL_TEST', 90_000)).rejects.toThrow(
      /timed out/,
    );

    const end = events().find((e) => e.ev === 'rpc_end');
    expect(end).toBeDefined();
    expect(end?.outcome).toBe('timeout');
    // The prompt size and the budget are the two numbers the failure is about.
    expect(end?.promptBytes).toBe(22_000);
    expect(end?.timeoutMs).toBe(90_000);
  });

  it('records the health check that decides whether to retry', async () => {
    const m = freshManager();
    const tm = m as unknown as Testable;
    vi.spyOn(tm, 'ensureRunning').mockResolvedValue(EP);
    vi.spyOn(tm, 'isHealthy').mockResolvedValue(true);
    vi.spyOn(tm, 'rpc').mockRejectedValue(new Error('timed out'));

    await expect(m.getModelResponse('p', 'MODEL_TEST', 1_000)).rejects.toThrow();

    const health = events().find((e) => e.ev === 'health_check');
    expect(health).toBeDefined();
    expect(health?.healthy).toBe(true);
    expect(health?.decision).toBe('give-up');
  });

  it('writes nothing at all when the env var is unset', async () => {
    delete process.env.NIMBALYST_GEMINI_DEBUG_LOG;
    const m = freshManager();
    const tm = m as unknown as Testable;
    vi.spyOn(tm, 'ensureRunning').mockResolvedValue(EP);
    vi.spyOn(tm, 'isHealthy').mockResolvedValue(true);
    vi.spyOn(tm, 'rpc').mockRejectedValue(new Error('timed out'));

    await expect(m.getModelResponse('p', 'MODEL_TEST', 1_000)).rejects.toThrow();
    expect(existsSync(logFile)).toBe(false);
  });
});

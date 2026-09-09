// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntigravityServerManager, AntigravityVersionGateError } from '../AntigravityServerManager';

type AntigravityEndpoint = Awaited<ReturnType<AntigravityServerManager['ensureRunning']>>;
type TestableAntigravityServerManager = {
  ensureRunning: () => Promise<AntigravityEndpoint>;
  isHealthy: (ep: AntigravityEndpoint) => Promise<boolean>;
  rpc: <T = unknown>(
    method: string,
    body: unknown,
    ep: AntigravityEndpoint,
    timeoutMs?: number,
  ) => Promise<T>;
};

// getModelResponse retries the GetModelResponse RPC ONCE on a transport
// timeout, but ONLY when the server turns out to be dead. A timeout says
// nothing on its own: against a server that is still answering it means the
// generation is not finished, and re-running it discards the progress already
// made. It never retries a version-gate error or an HTTP 4xx.
//
// `isHealthy` is the discriminator, so it is stubbed explicitly here. Leaving
// it live is what let an earlier version of this behaviour regress unnoticed:
// mocking only `ensureRunning` hid which server the retry decision was about.
// These spy on the private rpc/ensureRunning/isHealthy so no real language
// server is spawned. Passing a 'MODEL_' key skips resolveModelEnum.
const EP1 = { httpsPort: 1, csrf: 'x', owned: true } as const;
const EP2 = { httpsPort: 2, csrf: 'x', owned: true } as const;

function freshManager(): AntigravityServerManager {
  (AntigravityServerManager as unknown as { instance: unknown }).instance = null;
  return AntigravityServerManager.shared();
}

function testable(manager: AntigravityServerManager): TestableAntigravityServerManager {
  return manager as unknown as TestableAntigravityServerManager;
}

afterEach(() => vi.restoreAllMocks());

describe('AntigravityServerManager.getModelResponse retry', () => {
  it('retries once when the server died and was respawned', async () => {
    const m = freshManager();
    const tm = testable(m);
    vi.spyOn(tm, 'ensureRunning').mockResolvedValueOnce(EP1).mockResolvedValueOnce(EP2);
    vi.spyOn(tm, 'isHealthy').mockResolvedValue(false);
    const rpc = vi
      .spyOn(tm, 'rpc')
      .mockRejectedValueOnce(new Error('Antigravity GetModelResponse timed out'))
      .mockResolvedValueOnce({ response: 'ok answer' });

    await expect(m.getModelResponse('p', 'MODEL_TEST', 1000)).resolves.toBe('ok answer');
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  /**
   * The case a real workload hit: a long generation timed out, was re-run from
   * scratch, and cost double the wait to reach the same answer.
   */
  it('does NOT retry while the server is still answering', async () => {
    const m = freshManager();
    const tm = testable(m);
    vi.spyOn(tm, 'ensureRunning').mockResolvedValue(EP1);
    vi.spyOn(tm, 'isHealthy').mockResolvedValue(true);
    const rpc = vi
      .spyOn(tm, 'rpc')
      .mockRejectedValueOnce(new Error('Antigravity GetModelResponse timed out'))
      .mockResolvedValueOnce({ response: 'never reached' });

    await expect(m.getModelResponse('p', 'MODEL_TEST', 1000)).rejects.toThrow(/timed out/);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('leaves a live server running rather than recycling it on a timeout', async () => {
    // Stopping it would abort every other session's turn in the same process.
    const m = freshManager();
    const tm = testable(m);
    vi.spyOn(tm, 'ensureRunning').mockResolvedValue(EP1);
    vi.spyOn(tm, 'isHealthy').mockResolvedValue(true);
    vi.spyOn(tm, 'rpc').mockRejectedValue(new Error('Antigravity GetModelResponse timed out'));
    const stop = vi.spyOn(m, 'stop');

    await expect(m.getModelResponse('p', 'MODEL_TEST', 1000)).rejects.toThrow(/timed out/);
    expect(stop).not.toHaveBeenCalled();
  });

  it('does not retry an HTTP 4xx', async () => {
    const m = freshManager();
    const tm = testable(m);
    vi.spyOn(tm, 'ensureRunning').mockResolvedValue(EP1);
    const rpc = vi
      .spyOn(tm, 'rpc')
      .mockRejectedValue(new Error('Antigravity GetModelResponse HTTP 403: forbidden'));
    await expect(m.getModelResponse('p', 'MODEL_TEST', 1000)).rejects.toThrow(/HTTP 403/);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not retry a version-gate error', async () => {
    const m = freshManager();
    const tm = testable(m);
    vi.spyOn(tm, 'ensureRunning').mockResolvedValue(EP1);
    const rpc = vi
      .spyOn(tm, 'rpc')
      .mockResolvedValue({ response: 'this build is no longer supported' });
    await expect(m.getModelResponse('p', 'MODEL_TEST', 1000)).rejects.toBeInstanceOf(
      AntigravityVersionGateError,
    );
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('gives up after a second timeout on the respawned server', async () => {
    const m = freshManager();
    const tm = testable(m);
    vi.spyOn(tm, 'ensureRunning').mockResolvedValueOnce(EP1).mockResolvedValueOnce(EP2);
    vi.spyOn(tm, 'isHealthy').mockResolvedValue(false);
    const rpc = vi
      .spyOn(tm, 'rpc')
      .mockRejectedValue(new Error('Antigravity GetModelResponse timed out'));

    await expect(m.getModelResponse('p', 'MODEL_TEST', 1000)).rejects.toThrow(/timed out/);
    expect(rpc).toHaveBeenCalledTimes(2);
  });
});

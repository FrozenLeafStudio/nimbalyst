/**
 * Which version Nimbalyst claims to Antigravity's backend.
 *
 * This is the value that silently decides how many models the account appears
 * to have. A stale one produces a smaller catalog that is still a valid
 * catalog, so these cover the precedence rules rather than any visible output.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AntigravityServerManager } from '../geminiAntigravity/AntigravityServerManager';

const HARDCODED_DEFAULT = '2.1.4';

/**
 * Stub the install probe. Always stubbed, never left live: the real one reads
 * the machine's own Antigravity install, which would make these pass or fail
 * depending on whose laptop runs them.
 */
function stubDetect(mgr: AntigravityServerManager, value: string | null | Error) {
  const spy = vi.spyOn(
    mgr as unknown as { readInstalledIdeVersion: () => Promise<string | null> },
    'readInstalledIdeVersion',
  );
  if (value instanceof Error) spy.mockRejectedValue(value);
  else spy.mockResolvedValue(value);
  return spy;
}

describe('resolveOverrideIdeVersion', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to the hardcoded default when nothing is configured or detectable', async () => {
    const mgr = new AntigravityServerManager();
    stubDetect(mgr, null);
    await expect(mgr.resolveOverrideIdeVersion()).resolves.toBe(HARDCODED_DEFAULT);
  });

  it('uses an explicitly configured version', async () => {
    const mgr = new AntigravityServerManager();
    stubDetect(mgr, null);
    mgr.configure({ overrideIdeVersion: '2.12.2' });
    await expect(mgr.resolveOverrideIdeVersion()).resolves.toBe('2.12.2');
  });

  /**
   * The precedence that could not be expressed before the explicit value was
   * tracked separately: with only one field, "the user pinned a version" and
   * "nobody supplied one" were indistinguishable, so detection would have been
   * free to overwrite a deliberate pin.
   */
  it('lets an explicit setting win over anything detectable', async () => {
    const mgr = new AntigravityServerManager();
    mgr.configure({ overrideIdeVersion: '1.0.0' });
    // An install is present and would detect something much newer.
    const detect = stubDetect(mgr, '9.9.9');

    await expect(mgr.resolveOverrideIdeVersion()).resolves.toBe('1.0.0');
    expect(detect).not.toHaveBeenCalled();
  });

  it('prefers a detected version over the hardcoded default', async () => {
    const mgr = new AntigravityServerManager();
    stubDetect(mgr, '2.12.2');

    await expect(mgr.resolveOverrideIdeVersion()).resolves.toBe('2.12.2');
  });

  it('ignores an empty configured value rather than claiming an empty version', async () => {
    const mgr = new AntigravityServerManager();
    stubDetect(mgr, null);
    mgr.configure({ overrideIdeVersion: '' });
    await expect(mgr.resolveOverrideIdeVersion()).resolves.toBe(HARDCODED_DEFAULT);
  });

  it('probes at most once per process, so a missing install does not re-shell', async () => {
    const mgr = new AntigravityServerManager();
    const detect = stubDetect(mgr, null);

    await mgr.resolveOverrideIdeVersion();
    await mgr.resolveOverrideIdeVersion();
    await mgr.resolveOverrideIdeVersion();

    expect(detect).toHaveBeenCalledTimes(1);
  });

  it('falls back when detection throws, rather than failing the spawn', async () => {
    const mgr = new AntigravityServerManager();
    stubDetect(mgr, new Error('powershell unavailable'));

    await expect(mgr.resolveOverrideIdeVersion()).resolves.toBe(HARDCODED_DEFAULT);
  });
});

describe('version-gate fallback', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * Detection reads the app's file version, which is not guaranteed to be the
   * string the backend gate wants. If it is rejected, staying on it would keep
   * the user behind a gate forever -- worse than being behind on models, since
   * the hardcoded default is known to have worked.
   */
  it('stops trusting a detected version the backend rejected', async () => {
    const mgr = new AntigravityServerManager();
    stubDetect(mgr, '9.9.9');
    expect(await mgr.resolveOverrideIdeVersion()).toBe('9.9.9');

    const internals = mgr as unknown as {
      spawnedIdeVersion: string | null;
      noteVersionGateRejection: () => void;
    };
    internals.spawnedIdeVersion = '9.9.9';
    internals.noteVersionGateRejection();

    expect(await mgr.resolveOverrideIdeVersion()).toBe(HARDCODED_DEFAULT);
  });

  it('keeps an explicit pin in force even when it is rejected', async () => {
    // The user asked for this value. Silently replacing it would hide that
    // their setting is the thing that is wrong.
    const mgr = new AntigravityServerManager();
    stubDetect(mgr, '2.12.2');
    mgr.configure({ overrideIdeVersion: '1.0.0' });

    const internals = mgr as unknown as {
      spawnedIdeVersion: string | null;
      noteVersionGateRejection: () => void;
    };
    internals.spawnedIdeVersion = '1.0.0';
    internals.noteVersionGateRejection();

    expect(await mgr.resolveOverrideIdeVersion()).toBe('1.0.0');
  });
});

describe('appBinaryPath', () => {
  it('is distinct from the language server path', () => {
    // binaryPath() points at the bundled server, which carries the server's
    // version, not the IDE's -- reading the wrong one would defeat detection.
    expect(AntigravityServerManager.appBinaryPath())
      .not.toBe(AntigravityServerManager.binaryPath());
  });
});

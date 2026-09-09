/**
 * Catalog health and version resolution for the Gemini/Antigravity provider.
 *
 * These cover the failure that motivated them: a degraded catalog that looked
 * exactly like a healthy one, so a session pinned to a model the catalog no
 * longer contained failed only at send time with no prior signal.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  discoverGeminiCatalog,
  SEED_GEMINI_MODELS,
  bareGeminiModelKey,
  selectGeminiModels,
  entitledModelEnums,
} from '../geminiAntigravity/geminiAntigravityModels';
import {
  AntigravityVersionGateError,
  normalizeIdeVersion,
  type AntigravityModelInfo,
  type AntigravityServerManager,
} from '../geminiAntigravity/AntigravityServerManager';

const GOOGLE = 'API_PROVIDER_GOOGLE_GEMINI';

function catalogOf(
  entries: Array<{ key: string; displayName: string; enum: string; apiProvider?: string }>,
): Map<string, AntigravityModelInfo> {
  const map = new Map<string, AntigravityModelInfo>();
  for (const e of entries) {
    map.set(e.key, {
      key: e.key,
      enum: e.enum,
      displayName: e.displayName,
      apiProvider: e.apiProvider ?? GOOGLE,
    } as AntigravityModelInfo);
  }
  return map;
}

/** Minimal stand-in; only the members discoverGeminiCatalog touches. */
function fakeServer(overrides: Partial<Record<string, unknown>> = {}): AntigravityServerManager {
  return {
    ensureRunning: vi.fn(async () => ({ httpsPort: 1, csrf: 'x', owned: true })),
    getAvailableModels: vi.fn(async () => catalogOf([])),
    getUserStatus: vi.fn(async () => ({})),
    // Default: attached to Antigravity's own server, so there is no version we
    // chose and nothing to be skewed against.
    runningOwnedIdeVersion: vi.fn(() => null),
    installedIdeVersion: vi.fn(async () => null),
    ...overrides,
  } as unknown as AntigravityServerManager;
}

function userStatusFor(enums: string[]) {
  return {
    cascadeModelConfigData: {
      clientModelConfigs: enums.map((model) => ({ modelOrAlias: { model } })),
    },
  };
}

describe('discoverGeminiCatalog', () => {
  it('reports ok and the discovered models when the server answers', async () => {
    const catalog = catalogOf([
      { key: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)', enum: 'M318' },
      { key: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', enum: 'M71' },
    ]);
    const server = fakeServer({
      getAvailableModels: vi.fn(async () => catalog),
      getUserStatus: vi.fn(async () => userStatusFor(['M318', 'M71'])),
    });

    const { models, health } = await discoverGeminiCatalog(server);

    expect(health).toEqual({ state: 'ok' });
    expect(models.map((m) => m.key).sort()).toEqual([
      'gemini-3.6-flash-high',
      'gemini-3.8-flash-high',
    ]);
  });

  it('filters out unlabelled, unentitled entries rather than offering them', async () => {
    const catalog = catalogOf([
      { key: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', enum: 'M71' },
      { key: 'gemini-3.8-flash-tiered', displayName: '', enum: 'M322' },
    ]);
    const server = fakeServer({
      getAvailableModels: vi.fn(async () => catalog),
      getUserStatus: vi.fn(async () => userStatusFor(['M71'])),
    });

    const { models } = await discoverGeminiCatalog(server);

    // The unlabelled, unentitled 3.8 entry is not a usable substitute for the
    // 3.8 model that disappeared.
    expect(models.map((m) => m.key)).toEqual(['gemini-3.6-flash-high']);
  });

  /**
   * The exact production failure, and the reason a response-only check cannot
   * catch it: under a stale version claim the backend answers normally with a
   * smaller entitlement set. Nothing inside that response is malformed. The
   * claim itself is the only evidence.
   */
  it('flags a short catalog when our server runs below the installed version', async () => {
    const catalog = catalogOf([
      { key: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', enum: 'M71' },
    ]);
    const server = fakeServer({
      getAvailableModels: vi.fn(async () => catalog),
      getUserStatus: vi.fn(async () => userStatusFor(['M71'])),
      runningOwnedIdeVersion: vi.fn(() => '2.1.4'),
      installedIdeVersion: vi.fn(async () => '2.12.2'),
    });

    const { models, health } = await discoverGeminiCatalog(server);

    expect(health.state).toBe('degraded');
    expect(health.reason).toBe('version-gated');
    expect(health.detail).toContain('2.1.4');
    expect(health.detail).toContain('2.12.2');
    // The models we did find are still offered -- this is an explanation, not
    // a reason to hide the list.
    expect(models.map((m) => m.key)).toEqual(['gemini-3.6-flash-high']);
  });

  it('does not flag skew when our server matches the installed version', async () => {
    const catalog = catalogOf([
      { key: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', enum: 'M71' },
    ]);
    const server = fakeServer({
      getAvailableModels: vi.fn(async () => catalog),
      getUserStatus: vi.fn(async () => userStatusFor(['M71'])),
      runningOwnedIdeVersion: vi.fn(() => '2.12.2'),
      installedIdeVersion: vi.fn(async () => '2.12.2'),
    });

    expect((await discoverGeminiCatalog(server)).health.state).toBe('ok');
  });

  it('does not flag skew for a server Antigravity started, which is authoritative', async () => {
    const catalog = catalogOf([
      { key: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', enum: 'M71' },
    ]);
    const server = fakeServer({
      getAvailableModels: vi.fn(async () => catalog),
      getUserStatus: vi.fn(async () => userStatusFor(['M71'])),
      runningOwnedIdeVersion: vi.fn(() => null),
      installedIdeVersion: vi.fn(async () => '2.12.2'),
    });

    expect((await discoverGeminiCatalog(server)).health.state).toBe('ok');
  });

  it('classifies a version gate as version-gated and not retryable', async () => {
    const server = fakeServer({
      ensureRunning: vi.fn(async () => {
        throw new AntigravityVersionGateError('Antigravity backend rejected the build (version gate)');
      }),
    });

    const { models, health } = await discoverGeminiCatalog(server);

    expect(health.state).toBe('degraded');
    expect(health.reason).toBe('version-gated');
    expect(health.retryable).toBe(false);
    expect(health.detail).toMatch(/out of date/i);
    expect(models).toEqual([...SEED_GEMINI_MODELS]);
  });

  it('classifies an unreachable server as not-running and retryable', async () => {
    const server = fakeServer({
      ensureRunning: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:51717');
      }),
    });

    const { health } = await discoverGeminiCatalog(server);

    expect(health.state).toBe('degraded');
    expect(['not-running', 'not-installed']).toContain(health.reason);
    expect(health.detail).toBeTruthy();
  });

  it('reports seed-fallback when the server answers with nothing usable', async () => {
    const server = fakeServer({
      getAvailableModels: vi.fn(async () => catalogOf([])),
      getUserStatus: vi.fn(async () => userStatusFor([])),
    });

    const { models, health } = await discoverGeminiCatalog(server);

    expect(health.state).toBe('degraded');
    expect(health.reason).toBe('seed-fallback');
    expect(models).toEqual([...SEED_GEMINI_MODELS]);
    // Re-running the same query against the same server returns the same empty
    // result, so a retry link here would provably do nothing.
    expect(health.retryable).toBe(false);
    expect(health.detail).toMatch(/signed in/i);
  });

});

describe('selectGeminiModels', () => {
  it('drops unlabelled entries, which are internal slots rather than offerings', () => {
    const catalog = catalogOf([
      { key: 'gemini-3.8-flash-tiered', displayName: '', enum: 'M322' },
      { key: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', enum: 'M71' },
    ]);
    const out = selectGeminiModels(catalog, new Set(['M322', 'M71']));
    expect(out.map((m) => m.key)).toEqual(['gemini-3.6-flash-high']);
  });

  it('drops models the account is not entitled to', () => {
    const catalog = catalogOf([
      { key: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)', enum: 'M318' },
      { key: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', enum: 'M71' },
    ]);
    const out = selectGeminiModels(catalog, new Set(['M71']));
    expect(out.map((m) => m.key)).toEqual(['gemini-3.6-flash-high']);
  });

  it('ignores non-Google models, which belong to other providers', () => {
    const catalog = catalogOf([
      { key: 'claude-sonnet-4-6', displayName: 'Claude Sonnet', enum: 'C1', apiProvider: 'API_PROVIDER_ANTHROPIC' },
      { key: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', enum: 'M71' },
    ]);
    const out = selectGeminiModels(catalog, new Set(['C1', 'M71']));
    expect(out.map((m) => m.key)).toEqual(['gemini-3.6-flash-high']);
  });

  it('falls back to the full catalog when entitlement data is missing', () => {
    const catalog = catalogOf([
      { key: 'gemini-3.6-flash-high', displayName: 'Gemini 3.6 Flash (High)', enum: 'M71' },
    ]);
    expect(selectGeminiModels(catalog, new Set()).map((m) => m.key))
      .toEqual(['gemini-3.6-flash-high']);
  });
});

describe('entitledModelEnums', () => {
  it('reads the enum set out of a GetUserStatus payload', () => {
    expect([...entitledModelEnums(userStatusFor(['M318', 'M71']))].sort()).toEqual(['M318', 'M71']);
  });

  it('returns an empty set for malformed input rather than throwing', () => {
    expect(entitledModelEnums(null).size).toBe(0);
    expect(entitledModelEnums({}).size).toBe(0);
    expect(entitledModelEnums({ cascadeModelConfigData: { clientModelConfigs: 'nope' } }).size).toBe(0);
  });
});

describe('bareGeminiModelKey', () => {
  it('strips the provider namespace the host persists', () => {
    expect(bareGeminiModelKey('antigravity-gemini-agent:gemini-3.8-flash-high'))
      .toBe('gemini-3.8-flash-high');
  });

  it('passes through an already-bare key', () => {
    expect(bareGeminiModelKey('gemini-3.8-flash-high')).toBe('gemini-3.8-flash-high');
  });
});

describe('normalizeIdeVersion', () => {
  it('trims the Windows 4-part FileVersion to the 3-part gate form', () => {
    expect(normalizeIdeVersion('2.12.2.0')).toBe('2.12.2');
  });

  it('passes a 3-part version through', () => {
    expect(normalizeIdeVersion('2.12.2')).toBe('2.12.2');
  });

  it('returns null for unparseable input, so the caller falls back', () => {
    expect(normalizeIdeVersion('')).toBeNull();
    expect(normalizeIdeVersion(null)).toBeNull();
    expect(normalizeIdeVersion('not a version')).toBeNull();
  });
});

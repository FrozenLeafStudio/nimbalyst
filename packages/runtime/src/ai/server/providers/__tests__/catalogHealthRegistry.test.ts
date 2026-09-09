/**
 * Whether a fetched model catalog is worth caching.
 *
 * This replaced a heuristic: ModelRegistry used to decide by comparing model
 * ids against one provider's seed list, which meant a real catalog that
 * happened to match the seed would be discarded, and no other provider could
 * express the same condition at all.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  reportCatalogHealth,
  lastCatalogHealth,
  catalogIsCacheable,
  resetCatalogHealth,
} from '../catalogHealthRegistry';

const GEMINI = 'antigravity-gemini-agent';

beforeEach(() => resetCatalogHealth());

describe('catalogIsCacheable', () => {
  it('treats a provider that has never reported as healthy', () => {
    // Every provider except Gemini is in this state. Reporting nothing must
    // keep the previous behaviour exactly, or this change would silently stop
    // caching every other provider's catalog.
    expect(catalogIsCacheable('claude-code')).toBe(true);
    expect(lastCatalogHealth('claude-code')).toBeNull();
  });

  it('caches a healthy catalog', () => {
    reportCatalogHealth(GEMINI, { state: 'ok' });
    expect(catalogIsCacheable(GEMINI)).toBe(true);
  });

  it('refuses to cache a placeholder catalog', () => {
    reportCatalogHealth(GEMINI, { state: 'degraded', reason: 'not-running' });
    expect(catalogIsCacheable(GEMINI)).toBe(false);
  });

  it('refuses to cache a real-but-short catalog', () => {
    // Version skew produces a well-formed list that is simply missing models.
    // Pinning it for the cache window would outlast the cause.
    reportCatalogHealth(GEMINI, { state: 'degraded', reason: 'version-gated' });
    expect(catalogIsCacheable(GEMINI)).toBe(false);
  });

  it('lets a provider recover once it reports healthy again', () => {
    reportCatalogHealth(GEMINI, { state: 'degraded', reason: 'not-running' });
    expect(catalogIsCacheable(GEMINI)).toBe(false);

    reportCatalogHealth(GEMINI, { state: 'ok' });
    expect(catalogIsCacheable(GEMINI)).toBe(true);
  });

  it('keeps providers independent', () => {
    reportCatalogHealth(GEMINI, { state: 'degraded', reason: 'not-installed' });
    expect(catalogIsCacheable(GEMINI)).toBe(false);
    expect(catalogIsCacheable('opencode')).toBe(true);
  });
});

describe('lastCatalogHealth', () => {
  it('returns the most recent report', () => {
    reportCatalogHealth(GEMINI, { state: 'degraded', reason: 'not-running', detail: 'first' });
    reportCatalogHealth(GEMINI, { state: 'degraded', reason: 'version-gated', detail: 'second' });
    expect(lastCatalogHealth(GEMINI)).toMatchObject({ reason: 'version-gated', detail: 'second' });
  });
});

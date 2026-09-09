/**
 * Where a provider reports whether its last catalog fetch can be trusted, so
 * ModelRegistry can ask without knowing which providers exist.
 *
 * Silence means healthy: a provider that never reports is unaffected.
 *
 * Keyed by provider, while ModelRegistry's cache is keyed by provider +
 * workspace + baseUrl. Fine while only process-wide providers report; a
 * per-workspace one would need the finer key.
 */

import type { AIProviderType, ProviderCatalogHealth } from '../types';

const lastHealth = new Map<string, ProviderCatalogHealth>();

/** Record the health of the catalog fetch that just completed. */
export function reportCatalogHealth(
  provider: AIProviderType | string,
  health: ProviderCatalogHealth,
): void {
  lastHealth.set(provider, health);
}

/** Health of the most recent fetch, or null if the provider never reported. */
export function lastCatalogHealth(
  provider: AIProviderType | string,
): ProviderCatalogHealth | null {
  return lastHealth.get(provider) ?? null;
}

/** Degraded covers both "placeholder" and "real but short"; neither should be pinned. */
export function catalogIsCacheable(provider: AIProviderType | string): boolean {
  return lastHealth.get(provider)?.state !== 'degraded';
}

/** Test seam. */
export function resetCatalogHealth(): void {
  lastHealth.clear();
}

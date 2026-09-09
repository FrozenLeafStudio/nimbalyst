/**
 * Model catalog for the `antigravity-gemini-agent` provider.
 *
 * The language server DOES enumerate models -- `GetAvailableModels` returns the
 * full catalog and `GetUserStatus.cascadeModelConfigData.clientModelConfigs`
 * returns the subset the signed-in account may actually use. When the extension
 * owned this provider its manifest hardcoded three model ids, and by the time
 * this moved in-tree that list was already stale: the live catalog carried a
 * Gemini 3.6 Flash family the picker never offered. That drift is exactly
 * NIM-1486, so discovery is the primary source and the seed list below is only
 * a fallback.
 *
 * Discovery starts the language server if it is not already up, at the cost of
 * a ~120MB process on opening a picker.
 *
 * Callers MUST apply the server config first
 * (`GeminiAntigravityProvider.applyServerConfig`): `configure()` does not
 * re-version a running server, so whoever spawns first decides it.
 *
 * The catalog spans several vendors (Antigravity also fronts Anthropic and
 * OpenAI models). This is the *Gemini* provider, so only Google-served entries
 * are offered; surfacing the others here would put the same model behind two
 * unrelated Nimbalyst providers with different billing stories.
 */

import type { AntigravityModelInfo } from './AntigravityServerManager';
import { AntigravityServerManager, AntigravityVersionGateError } from './AntigravityServerManager';
import type { ProviderCatalogHealth } from '../../types';

/** `apiProvider` value the language server reports for Google-served models. */
const GOOGLE_API_PROVIDER = 'API_PROVIDER_GOOGLE_GEMINI';

/**
 * Fallback catalog, used only until the language server has been reached once.
 *
 * These are the ids that existing Gemini session rows persist, so they must
 * keep their exact keys -- a session created against
 * `antigravity-gemini-agent:gemini-3-flash-agent` has to keep resolving. The
 * display names are the server's own labels, which do not match the keys
 * (`gemini-3-flash-agent` is labelled "Gemini 3.5 Flash (High)").
 */
export const SEED_GEMINI_MODELS: ReadonlyArray<{ key: string; displayName: string }> =
  Object.freeze([
    { key: 'gemini-3-flash-agent', displayName: 'Gemini 3.5 Flash (High)' },
    { key: 'gemini-3.5-flash-low', displayName: 'Gemini 3.5 Flash (Medium)' },
    { key: 'gemini-3.5-flash-extra-low', displayName: 'Gemini 3.5 Flash (Low)' },
  ]);

/** Default model key for a new Gemini session. */
export const DEFAULT_GEMINI_MODEL_KEY = 'gemini-3-flash-agent';

/**
 * Strip the `antigravity-gemini-agent:` namespace off a stored model id.
 *
 * The host persists the namespaced form; the language server only knows the
 * bare key. Callers may hand us either.
 */
export function bareGeminiModelKey(raw: string | undefined | null): string {
  if (!raw) return DEFAULT_GEMINI_MODEL_KEY;
  return raw.includes(':') ? raw.split(':').slice(1).join(':') : raw;
}

/**
 * Google-served models the signed-in account may use, newest-looking first.
 *
 * `entitledEnums` is the set of model enums from `clientModelConfigs`. It is
 * the account's entitlement, not the build's catalog: a model present in
 * `GetAvailableModels` but absent here will fail at request time, so offering
 * it would only produce a confusing error after the user picked it. When the
 * entitlement set is empty (an older server that does not report it) the
 * catalog is used unfiltered rather than showing nothing.
 */
export function selectGeminiModels(
  catalog: Map<string, AntigravityModelInfo>,
  entitledEnums: ReadonlySet<string>,
): Array<{ key: string; displayName: string }> {
  const out: Array<{ key: string; displayName: string }> = [];
  for (const info of catalog.values()) {
    if (info.apiProvider !== GOOGLE_API_PROVIDER) continue;
    if (entitledEnums.size > 0 && !entitledEnums.has(info.enum)) continue;
    // An unlabelled entry is an internal/experimental slot (the server returns
    // several with no displayName). Nothing useful to show the user.
    if (!info.displayName) continue;
    out.push({ key: info.key, displayName: info.displayName });
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/** Read the account's entitled model enums out of a raw GetUserStatus payload. */
export function entitledModelEnums(userStatus: unknown): Set<string> {
  const enums = new Set<string>();
  const configs = (userStatus as {
    cascadeModelConfigData?: { clientModelConfigs?: Array<{ modelOrAlias?: { model?: unknown } }> };
  } | null | undefined)?.cascadeModelConfigData?.clientModelConfigs;
  if (!Array.isArray(configs)) return enums;
  for (const config of configs) {
    const name = config?.modelOrAlias?.model;
    if (typeof name === 'string' && name) enums.add(name);
  }
  return enums;
}

export interface GeminiCatalogResult {
  models: Array<{ key: string; displayName: string }>;
  health: ProviderCatalogHealth;
}

/** Classify a discovery failure into something the UI can explain. */
function classifyDiscoveryFailure(err: unknown): ProviderCatalogHealth {
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof AntigravityVersionGateError || /version gate/i.test(message)) {
    return {
      state: 'degraded',
      reason: 'version-gated',
      detail:
        'Antigravity rejected this build as out of date, so the model list is '
        + 'incomplete. Update Antigravity, or set overrideIdeVersion for the '
        + 'Gemini provider in ai-settings.',
      retryable: false,
    };
  }
  if (!AntigravityServerManager.isInstalled()) {
    return {
      state: 'degraded',
      reason: 'not-installed',
      detail:
        'Antigravity is not installed, so no models could be discovered. '
        + 'Install it from https://antigravity.google and sign in once.',
      retryable: false,
    };
  }
  if (/HTTP 401|HTTP 403|sign|auth/i.test(message)) {
    return {
      state: 'degraded',
      reason: 'not-signed-in',
      detail:
        'Antigravity is installed but not signed in, so the model list is '
        + 'unavailable. Open Antigravity and sign in to your Google account.',
      retryable: true,
    };
  }
  return {
    state: 'degraded',
    reason: 'not-running',
    detail: `Could not reach the Antigravity language server: ${message}`,
    retryable: true,
  };
}

/**
 * A short catalog is still a well-formed one, so nothing inside a response
 * reveals it. The claim does: a server we spawned below the installed version
 * is under-reporting entitlements. Only ours -- Antigravity's is authoritative.
 */
async function versionSkewHealth(
  server: AntigravityServerManager,
): Promise<ProviderCatalogHealth> {
  const running = server.runningOwnedIdeVersion();
  if (!running) return { state: 'ok' };
  const installed = await server.installedIdeVersion();
  if (!installed || installed === running) return { state: 'ok' };
  return {
    state: 'degraded',
    reason: 'version-gated',
    detail:
      `This list may be incomplete. Nimbalyst is identifying as Antigravity `
      + `${running} while the installed version is ${installed}, and the backend `
      + `reports fewer models for older versions. Clear overrideIdeVersion for `
      + `the Gemini provider in ai-settings to use the installed version.`,
    retryable: false,
  };
}

/** Discover the model list plus whether that list can be trusted. */
export async function discoverGeminiCatalog(
  server: AntigravityServerManager,
): Promise<GeminiCatalogResult> {
  try {
    const endpoint = await server.ensureRunning();
    const [catalog, userStatus] = await Promise.all([
      server.getAvailableModels(endpoint),
      server.getUserStatus(endpoint).catch(() => null),
    ]);
    const models = selectGeminiModels(catalog, entitledModelEnums(userStatus));
    if (models.length > 0) {
      return { models, health: await versionSkewHealth(server) };
    }
    // The server answered; nothing survived the entitlement filter. Not
    // retryable -- the same query returns the same result. (A failed
    // GetUserStatus does not land here: it yields an empty entitlement set,
    // which leaves the catalog unfiltered rather than empty.)
    return {
      models: [...SEED_GEMINI_MODELS],
      health: {
        state: 'degraded',
        reason: 'seed-fallback',
        detail:
          'Antigravity returned no Gemini models this account can use, so a '
          + 'default list is shown and these may not be selectable. Check that '
          + 'you are signed in to Antigravity with the right Google account.',
        retryable: false,
      },
    };
  } catch (err) {
    return { models: [...SEED_GEMINI_MODELS], health: classifyDiscoveryFailure(err) };
  }
}

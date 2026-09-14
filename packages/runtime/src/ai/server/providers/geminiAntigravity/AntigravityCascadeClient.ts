/**
 * AntigravityCascadeClient.
 *
 * Phase 2A of `gemini-power-parity.md` section 6. Step 1 (transport only):
 * attach-or-spawn via the existing `AntigravityServerManager`, track a
 * workspace, and start or resume a Cascade trajectory -- `ensureCascade` and
 * everything above it. Step 2/3 (this file's other half): drive one turn --
 * `sendUserCascadeMessage` + `getCascadeTrajectorySteps` -- with the
 * generation/iteration bounds the plan's step 3 calls for. Step-to-
 * `StreamChunk` mapping lives in `AntigravityCascadeProtocol.ts`, not here;
 * this file only knows RPC shapes.
 *
 * Request/response shapes below are copied verbatim from the live probe in
 * `cascade-spike/step3-results.md` (2026-09-13) -- not re-derived from the
 * proto schema, per that plan's own evidence rule. `LoadTrajectory` is the
 * one exception: it was never exercised against a live server, only
 * confirmed to exist in the compiled descriptors as a `{cascadeId} -> {}`
 * call. Treat a `LoadTrajectory` rejection as "the cascade is gone" (server
 * respawned, trajectory deleted, or the descriptor's implied resume
 * semantics don't hold) rather than as a transport fault -- `ensureCascade`
 * below falls back to starting fresh rather than propagating the error.
 *
 * Cascade state (tracked workspaces, live trajectories) is in-memory on the
 * language server, not persisted by Nimbalyst. A respawn or a hub swap
 * forgets it, which is why tracked-workspace bookkeeping here is keyed on
 * `AntigravityServerManager.endpointEpoch()` rather than cached forever.
 *
 * Bounds on `SendUserCascadeMessage`, confirmed live (step3-results.md):
 * `plannerConfig.completionConfigOverride.maxTokens` is honoured (a too-small
 * value flips `stopReason` to `STOP_REASON_MAX_TOKENS` and the server retries
 * with its own "cut off" message); `plannerConfig.maxOutputTokens` (the OTHER,
 * non-override field) is parsed and echoed back but silently ignored --
 * `maxOutputTokens: 1` still produced a 2,373-token response. Do not send that
 * field. `executorConfig.maxGeneratorInvocations` is honoured exactly (2/2
 * live tests). `executorConfig.researchOnly` did NOT block a write in one
 * test, confounded with `autoAllowAllInteractions: true` in the same request
 * -- treat it as unproven, not disproven, and this client does not set it.
 * `autoAllowAllInteractions` + `autoInteractionBehavior:
 * AUTO_INTERACTION_BEHAVIOR_ALLOW_ALL` are both set because Nimbalyst has no
 * `HandleCascadeUserInteraction` wiring yet (plan step 4) -- without them a
 * cascade needing permission parks in `CORTEX_STEP_STATUS_WAITING` forever.
 */

import { AntigravityServerManager } from './AntigravityServerManager';

// Confirmed live (step3-results.md, probe a2/a3): StartCascade 400s with
// "CortexTrajectorySource is unspecified" when `source` is omitted. Both
// fields were always sent together in the probes that followed, so the pair
// is confirmed jointly sufficient; `trajectoryType`'s necessity alone is
// inferred, not independently proven.
const CASCADE_TRAJECTORY_SOURCE_CLIENT = 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT';
const CASCADE_TRAJECTORY_TYPE = 'CORTEX_TRAJECTORY_TYPE_CASCADE';

const ADD_TRACKED_WORKSPACE_TIMEOUT_MS = 30_000;
const START_CASCADE_TIMEOUT_MS = 30_000;
const LOAD_TRAJECTORY_TIMEOUT_MS = 30_000;
// A blocking SendUserCascadeMessage returns at turn end (confirmed live:
// 6.71s/10.28s/27.58s calls tracked turn complexity, not a fixed "accepted"
// latency), so this needs the same long ceiling as the text loop's buffered
// GetModelResponse, not a short RPC timeout.
const SEND_USER_CASCADE_MESSAGE_TIMEOUT_MS = 600_000;
const GET_CASCADE_TRAJECTORY_STEPS_TIMEOUT_MS = 30_000;

// Mirrors AntigravityToolLoopProtocol's `maxIterations ?? 40` default -- same
// role (iteration cap), different mechanism (server-enforced, not client loop).
export const DEFAULT_MAX_GENERATOR_INVOCATIONS = 40;
// Placeholder per cascade-spike/waste-reduction doc 04 §1c ("only the units
// are known"); round-2 probe's "workable budget" test used 2000 successfully.
export const DEFAULT_COMPLETION_MAX_TOKENS = 8192;
// Placeholder, same probe convention used throughout step3-results.md.
export const DEFAULT_USER_INTERACTION_TIMEOUT_SECONDS = 30;
// Matches GeminiAntigravityProvider's RUN_COMMAND_MAX_OUTPUT convention and
// the value every successful step3-results.md probe used.
export const DEFAULT_TOOL_OUTPUT_MAX_BYTES = 48_000;

export interface StartCascadeResult {
  cascadeId: string;
}

/**
 * Minimal typed view of `gemini_coder.Step` -- only the fields
 * `AntigravityCascadeProtocol`'s mapping needs. Deliberately loose
 * (`[key: string]: unknown`) rather than modeling all 158 `Step` fields: only
 * `listDirectory`/`viewFile`/`find`/`codeAction`/`generic`/`runCommand` (the
 * step types actually observed or documented) are typed further.
 */
export interface CascadeToolCallRef {
  id?: string;
  name?: string;
  argumentsJson?: string;
  /** Set when the server itself could not parse the tool call's own JSON. */
  invalidJsonErr?: string;
}

export interface CascadeStepMetadata {
  toolCall?: CascadeToolCallRef;
  toolSummary?: string;
  toolAction?: string;
  modelUsage?: Record<string, unknown>;
}

export interface CascadePlannerResponse {
  response?: string;
  thinking?: string;
  toolCalls?: CascadeToolCallRef[];
  stopReason?: string;
}

export interface CascadeErrorDetails {
  userErrorMessage?: string;
  shortError?: string;
  fullError?: string;
}

export interface CascadeStep {
  type?: string;
  status?: string;
  metadata?: CascadeStepMetadata;
  /** `Step.error`, field 31 -- sits OUTSIDE the `step` oneof. */
  error?: CascadeErrorDetails;
  plannerResponse?: CascadePlannerResponse;
  errorMessage?: { error?: CascadeErrorDetails; shouldShowUser?: boolean; shouldShowModel?: boolean };
  /** `Step.requestedInteraction`, field 56 -- also outside the oneof. */
  requestedInteraction?: unknown;
  generic?: { args?: Record<string, unknown>; result?: { result?: string } };
  listDirectory?: unknown;
  viewFile?: unknown;
  find?: unknown;
  codeAction?: unknown;
  runCommand?: unknown;
  finish?: unknown;
  [key: string]: unknown;
}

export interface GetCascadeTrajectoryStepsResult {
  steps?: CascadeStep[];
}

export interface SendCascadeMessageParams {
  cascadeId: string;
  text: string;
  /** A stable model KEY, or an already-resolved server enum (`MODEL_...`). */
  modelKeyOrEnum: string;
  blocking: boolean;
  maxGeneratorInvocations: number;
  /** `plannerConfig.completionConfigOverride.maxTokens` -- omit to leave uncapped. */
  completionMaxTokens?: number;
  userInteractionTimeoutSeconds: number;
  toolOutputMaxBytes: number;
}

export interface EnsureCascadeParams {
  workspacePath: string;
  /** A stable model KEY, or an already-resolved server enum (`MODEL_...`). */
  modelKeyOrEnum: string;
  /** A previously-captured cascade id for this session, if any. */
  persistedCascadeId?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface EnsureCascadeResult {
  cascadeId: string;
  /** True when an existing trajectory was reattached rather than started fresh. */
  resumed: boolean;
}

/**
 * `C:\foo\bar` -> `C:/foo/bar`. `AddTrackedWorkspace` wants a plain
 * filesystem path with forward slashes and no `file://` scheme -- a
 * different format from `StartCascade`'s `workspaceUris` (see below).
 */
export function toTrackedWorkspacePath(workspacePath: string): string {
  return workspacePath.replace(/\\/g, '/');
}

/** `C:\foo\bar` -> `file:///C:/foo/bar`, the form `StartCascade.workspaceUris` wants. */
export function toWorkspaceUri(workspacePath: string): string {
  return `file:///${toTrackedWorkspacePath(workspacePath).replace(/^\/+/, '')}`;
}

export function buildAddTrackedWorkspaceRequest(workspacePath: string): { workspace: string } {
  return { workspace: toTrackedWorkspacePath(workspacePath) };
}

export function buildStartCascadeRequest(
  workspacePath: string,
  modelEnum: string,
): Record<string, unknown> {
  return {
    workspaceUris: [toWorkspaceUri(workspacePath)],
    // Bare enum string at this level -- a different shape from the
    // `{model: <enum>}` object `SendUserCascadeMessage.cascadeConfig
    // .plannerConfig.requestedModel` wants (that's a later step).
    requestedModel: modelEnum,
    source: CASCADE_TRAJECTORY_SOURCE_CLIENT,
    trajectoryType: CASCADE_TRAJECTORY_TYPE,
  };
}

export function buildLoadTrajectoryRequest(cascadeId: string): { cascadeId: string } {
  return { cascadeId };
}

/**
 * `SendUserCascadeMessage` body. Field names and nesting copied verbatim from
 * the live probes that returned 200 (step3-results.md probes b1b/d1/d5/d6) --
 * see the file header for which bounds are honoured vs. silently ignored.
 * `modelEnum` must already be resolved (this is a pure function; the class
 * method below does the key -> enum resolution).
 */
export function buildSendUserCascadeMessageRequest(params: {
  cascadeId: string;
  text: string;
  modelEnum: string;
  blocking: boolean;
  maxGeneratorInvocations: number;
  completionMaxTokens?: number;
  userInteractionTimeoutSeconds: number;
  toolOutputMaxBytes: number;
}): Record<string, unknown> {
  const plannerConfig: Record<string, unknown> = {
    // `ModelOrAlias`, a DIFFERENT shape from StartCascade's bare enum string
    // (see buildStartCascadeRequest above) -- confirmed live: sending the
    // bare-string shape here 500s with "neither PlanModel nor RequestedModel
    // specified".
    requestedModel: { model: params.modelEnum },
    toolConfig: {
      autoAllowAllInteractions: true,
      autoInteractionBehavior: 'AUTO_INTERACTION_BEHAVIOR_ALLOW_ALL',
      userInteractionTimeoutSeconds: params.userInteractionTimeoutSeconds,
      toolOutput: { maxOutputBytes: params.toolOutputMaxBytes },
    },
  };
  // NOT `plannerConfig.maxOutputTokens` -- confirmed live to be parsed,
  // echoed back, and silently ignored (see file header). This is the field
  // that actually bounds one generation.
  if (typeof params.completionMaxTokens === 'number') {
    plannerConfig.completionConfigOverride = { maxTokens: params.completionMaxTokens };
  }
  return {
    cascadeId: params.cascadeId,
    items: [{ text: params.text }],
    blocking: params.blocking,
    cascadeConfig: {
      plannerConfig,
      executorConfig: { maxGeneratorInvocations: params.maxGeneratorInvocations },
    },
  };
}

/** `stepOffset` is INCLUSIVE -- confirmed live (returns steps `>= stepOffset`). */
export function buildGetCascadeTrajectoryStepsRequest(
  cascadeId: string,
  stepOffset: number,
): { cascadeId: string; stepOffset: number } {
  return { cascadeId, stepOffset };
}

export class AntigravityCascadeClient {
  private readonly server: AntigravityServerManager;
  /** Workspace paths already tracked on the CURRENT endpoint, keyed by endpoint epoch. */
  private readonly trackedByEpoch = new Map<string, Set<string>>();

  constructor(server: AntigravityServerManager) {
    this.server = server;
  }

  /**
   * `AddTrackedWorkspace` once per workspace per server incarnation.
   * Idempotent to call repeatedly: a no-op once the workspace is tracked for
   * the current epoch.
   */
  async ensureWorkspaceTracked(
    workspacePath: string,
    timeoutMs = ADD_TRACKED_WORKSPACE_TIMEOUT_MS,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    await this.server.ensureRunning();
    const epoch = this.server.endpointEpoch() ?? '';
    let tracked = this.trackedByEpoch.get(epoch);
    if (!tracked) {
      tracked = new Set();
      this.trackedByEpoch.set(epoch, tracked);
    }
    if (tracked.has(workspacePath)) return;
    await this.server.callRpc(
      'AddTrackedWorkspace',
      buildAddTrackedWorkspaceRequest(workspacePath),
      timeoutMs,
      abortSignal,
    );
    tracked.add(workspacePath);
  }

  /**
   * A caller may hand us either a stable model KEY or an already-resolved
   * server enum. Short-circuiting the latter keeps a resolved enum from
   * costing a GetAvailableModels round trip.
   */
  private async toModelEnum(modelKeyOrEnum: string): Promise<string> {
    return modelKeyOrEnum.startsWith('MODEL_')
      ? modelKeyOrEnum
      : this.server.resolveModelEnum(modelKeyOrEnum);
  }

  /** Start a brand-new Cascade trajectory for the workspace. */
  async startCascade(
    workspacePath: string,
    modelKeyOrEnum: string,
    timeoutMs = START_CASCADE_TIMEOUT_MS,
    abortSignal?: AbortSignal,
  ): Promise<StartCascadeResult> {
    await this.ensureWorkspaceTracked(workspacePath, timeoutMs, abortSignal);
    const modelEnum = await this.toModelEnum(modelKeyOrEnum);
    const res = await this.server.callRpc<{ cascadeId?: string }>(
      'StartCascade',
      buildStartCascadeRequest(workspacePath, modelEnum),
      timeoutMs,
      abortSignal,
    );
    if (!res.cascadeId) {
      throw new Error('Antigravity StartCascade returned no cascadeId.');
    }
    return { cascadeId: res.cascadeId };
  }

  /**
   * Reattach to a previously-started trajectory. UNVERIFIED against a live
   * server (see file header) -- callers must treat a rejection as "the
   * cascade is gone", not as a transport fault.
   */
  async loadTrajectory(
    cascadeId: string,
    timeoutMs = LOAD_TRAJECTORY_TIMEOUT_MS,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    await this.server.ensureRunning();
    await this.server.callRpc(
      'LoadTrajectory',
      buildLoadTrajectoryRequest(cascadeId),
      timeoutMs,
      abortSignal,
    );
  }

  /**
   * Resolve the cascade for a session: reattach to a persisted id if one was
   * given and is still live, otherwise start a fresh trajectory. The
   * workspace is (re-)tracked either way, since tracking does not survive a
   * server respawn.
   */
  async ensureCascade(params: EnsureCascadeParams): Promise<EnsureCascadeResult> {
    const { workspacePath, modelKeyOrEnum, persistedCascadeId, timeoutMs, abortSignal } = params;
    await this.ensureWorkspaceTracked(workspacePath, timeoutMs, abortSignal);
    if (persistedCascadeId) {
      try {
        await this.loadTrajectory(persistedCascadeId, timeoutMs, abortSignal);
        return { cascadeId: persistedCascadeId, resumed: true };
      } catch {
        // Stale or unresolvable id -- fall through and start over.
      }
    }
    const started = await this.startCascade(workspacePath, modelKeyOrEnum, timeoutMs, abortSignal);
    return { cascadeId: started.cascadeId, resumed: false };
  }

  /**
   * Send one user turn to a running cascade. `SendUserCascadeMessageResponse`
   * has zero fields (confirmed live) -- the caller must poll
   * `getCascadeTrajectorySteps` for anything, including a non-blocking call's
   * acceptance. Resolves once the RPC call itself returns, which -- per
   * `blocking` -- is either near-instant (confirmed live: 0.06s) or turn-end
   * (confirmed live: 6.71s-27.58s, tracking turn complexity).
   */
  async sendUserCascadeMessage(
    params: SendCascadeMessageParams,
    timeoutMs = SEND_USER_CASCADE_MESSAGE_TIMEOUT_MS,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const modelEnum = await this.toModelEnum(params.modelKeyOrEnum);
    await this.server.callRpc(
      'SendUserCascadeMessage',
      buildSendUserCascadeMessageRequest({ ...params, modelEnum }),
      timeoutMs,
      abortSignal,
    );
  }

  /**
   * Fetch trajectory steps from `stepOffset` (inclusive) onward. Every probe
   * in step3-results.md returned in 0.01-0.12s, which is why the plan
   * defaults the turn transport to polling this instead of `blocking: true`.
   */
  async getCascadeTrajectorySteps(
    cascadeId: string,
    stepOffset: number,
    timeoutMs = GET_CASCADE_TRAJECTORY_STEPS_TIMEOUT_MS,
    abortSignal?: AbortSignal,
  ): Promise<GetCascadeTrajectoryStepsResult> {
    return this.server.callRpc(
      'GetCascadeTrajectorySteps',
      buildGetCascadeTrajectoryStepsRequest(cascadeId, stepOffset),
      timeoutMs,
      abortSignal,
    );
  }
}

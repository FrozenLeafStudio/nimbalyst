/**
 * AntigravityCascadeProtocol.
 *
 * Phase 2A steps 2-3 of `gemini-power-parity.md` section 6: drive one Cascade
 * turn and map `gemini_coder.Step` to a discriminated event union, the
 * Cascade-transport analogue of `AntigravityToolLoopProtocol.run()`. Not the
 * same shape of machine, deliberately: the text loop re-parses the model's
 * own text output as intent (hence its allowlist/brace-matching/
 * `<tool-output>`-sanitization hardenings against a model that could
 * fabricate a tool result inside the one channel it fully controls). Cascade
 * steps arrive pre-typed from the server -- there is no text to re-parse and
 * no channel the model can forge a result into (waste-reduction doc 04 §4)
 * -- so none of that hardening has an analogue here.
 *
 * Default transport is polling (`GetCascadeTrajectorySteps` every
 * `pollIntervalMs`), per the plan: confirmed live at 0.01-0.12s per call,
 * cheaper than holding an HTTP connection open for the whole turn.
 * `blocking: true` is supported (pass `blocking: true` to the constructor)
 * but only changes how long `SendUserCascadeMessage` itself takes; the same
 * polling loop runs afterward either way -- a blocking send just means the
 * first poll typically already finds the turn done.
 *
 * Step-type and status strings below are copied verbatim from
 * `cascade-spike/step3-results.md` (live-confirmed: USER_INPUT,
 * ERROR_MESSAGE, LIST_DIRECTORY, VIEW_FILE, FIND, CODE_ACTION, and the
 * DONE/ERROR/CANCELED/WAITING statuses) and from
 * `waste-reduction/04-cascade-transport.md` §3.1 (read from `descriptors.json`,
 * not guessed, but never exercised live: PLANNER_RESPONSE, GENERIC,
 * SYSTEM_MESSAGE, EPHEMERAL_MESSAGE, WAIT, FINISH, and the terminal-status
 * set). The live probe CONTRADICTED doc 04's "only `generic` is used"
 * assumption -- this build emits typed variants -- so each typed step is
 * mapped explicitly; `generic`/`runCommand` remain as the documented fallback
 * for step types the probe did not exercise (e.g. `run_command`).
 */

import type { AntigravityCascadeClient, CascadeStep } from './AntigravityCascadeClient';
import {
  DEFAULT_COMPLETION_MAX_TOKENS,
  DEFAULT_MAX_GENERATOR_INVOCATIONS,
  DEFAULT_TOOL_OUTPUT_MAX_BYTES,
  DEFAULT_USER_INTERACTION_TIMEOUT_SECONDS,
} from './AntigravityCascadeClient';
import type { McpEndpointInput } from './cascadeMcpConfig';

export const DEFAULT_POLL_INTERVAL_MS = 500;
// Same order of magnitude as the text loop's MODEL_RESPONSE_TIMEOUT_MS -- a
// wall-clock backstop against a cascade parked forever (e.g. a WAITING step
// this protocol doesn't otherwise resolve), not a per-RPC timeout.
const DEFAULT_TURN_TIMEOUT_MS = 600_000;

// Confirmed live, step3-results.md.
const STEP_TYPE_USER_INPUT = 'CORTEX_STEP_TYPE_USER_INPUT';
const STEP_TYPE_ERROR_MESSAGE = 'CORTEX_STEP_TYPE_ERROR_MESSAGE';
const STEP_TYPE_LIST_DIRECTORY = 'CORTEX_STEP_TYPE_LIST_DIRECTORY';
const STEP_TYPE_VIEW_FILE = 'CORTEX_STEP_TYPE_VIEW_FILE';
const STEP_TYPE_FIND = 'CORTEX_STEP_TYPE_FIND';
const STEP_TYPE_CODE_ACTION = 'CORTEX_STEP_TYPE_CODE_ACTION';
// Documented (waste-reduction doc 04 §3.1, read from descriptors.json), not
// exercised live by step3-results.md -- kept as the fallback path for step
// types the probe never triggered (e.g. run_command).
const STEP_TYPE_PLANNER_RESPONSE = 'CORTEX_STEP_TYPE_PLANNER_RESPONSE';
const STEP_TYPE_GENERIC = 'CORTEX_STEP_TYPE_GENERIC';
const STEP_TYPE_RUN_COMMAND = 'CORTEX_STEP_TYPE_RUN_COMMAND';
const STEP_TYPE_SYSTEM_MESSAGE = 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE';
const STEP_TYPE_EPHEMERAL_MESSAGE = 'CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE';
const STEP_TYPE_WAIT = 'CORTEX_STEP_TYPE_WAIT';
const STEP_TYPE_FINISH = 'CORTEX_STEP_TYPE_FINISH';

const STATUS_DONE = 'CORTEX_STEP_STATUS_DONE';
const STATUS_ERROR = 'CORTEX_STEP_STATUS_ERROR';
const STATUS_CANCELED = 'CORTEX_STEP_STATUS_CANCELED';
// Confirmed live (step3-results.md cancellation probe): a cancelled
// generation transitions to DONE, not CANCELED -- the tell is `stopReason`.
const STATUS_WAITING = 'CORTEX_STEP_STATUS_WAITING';
const STATUS_INVALID = 'CORTEX_STEP_STATUS_INVALID';
const STATUS_CLEARED = 'CORTEX_STEP_STATUS_CLEARED';
const STATUS_INTERRUPTED = 'CORTEX_STEP_STATUS_INTERRUPTED';

/** A step in one of these statuses will not mutate further; safe to consume once. */
const TERMINAL_STATUSES = new Set([
  STATUS_DONE,
  STATUS_ERROR,
  STATUS_CANCELED,
  STATUS_INVALID,
  STATUS_CLEARED,
  STATUS_INTERRUPTED,
]);

/**
 * Confirmed live (step3-results.md cancellation probe): a `CancelCascadeInvocation`
 * call causes the in-flight `PLANNER_RESPONSE` to finish with this stopReason,
 * not a `CANCELED` status. Exported so a later cancel-wiring step can reuse
 * the same terminal-signal detection this protocol already does.
 */
export const STOP_REASON_CLIENT_STREAM_ERROR = 'STOP_REASON_CLIENT_STREAM_ERROR';

export interface CascadeTurnParams {
  cascadeId: string;
  /** A stable model KEY, or an already-resolved server enum (`MODEL_...`). */
  modelKeyOrEnum: string;
  userMessage: string;
  maxGeneratorInvocations?: number;
  /** `plannerConfig.completionConfigOverride.maxTokens` -- the bound that is actually honoured. */
  completionMaxTokens?: number;
  userInteractionTimeoutSeconds?: number;
  toolOutputMaxBytes?: number;
  /** [LIVE] Nimbalyst MCP endpoints to expose to this turn (step 6). Omit/empty for none. */
  mcpEndpoints?: McpEndpointInput[];
  /** Overall wall-clock cap for the turn (send + poll-to-completion). */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

export type CascadeProtocolEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; args: Record<string, unknown> }
  // `result` is always a string: the typed step payload (listDirectory/
  // viewFile/find/codeAction/...) JSON-stringified whole, raw and
  // unprocessed, so a later snapshot builder (a separate slice) has the full
  // typed diff to work from rather than a summary this protocol decided was
  // enough. `description` comes from the RESULT step's `metadata.toolSummary`
  // (confirmed live, step3-results.md) -- not available at announce time, so
  // the `tool_call` event above carries none; the host attaches it when this
  // event arrives.
  | { type: 'tool_result'; id: string; name: string; result: string; description?: string }
  | { type: 'tool_error'; id: string; name: string; error: string; description?: string }
  | { type: 'error'; error: string }
  | { type: 'complete' };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// [DESCRIPTOR-ONLY] Never observed live -- every step3-results.md probe ran
// with autoAllowAllInteractions: true, so a populated Step.requestedInteraction
// has not been wire-verified. Best-effort naming for a clearer error only;
// never trusted for behavior. Variant names per waste-reduction doc 04 §3.1.
const REQUESTED_INTERACTION_VARIANT_KEYS = [
  'runCommand', 'filePermission', 'permission', 'askQuestion', 'mcp', 'approvalInteraction',
] as const;

function describeRequestedInteraction(interaction: unknown): string | null {
  if (!interaction || typeof interaction !== 'object') return null;
  for (const key of REQUESTED_INTERACTION_VARIANT_KEYS) {
    if (key in (interaction as Record<string, unknown>)) return key;
  }
  return null;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Typed-payload extraction for a result-carrying step. Each typed variant is
 * JSON-stringified whole (raw wire shape, not summarized) -- confirmed live
 * shapes (step3-results.md): `listDirectory{directoryPathUri, results:[{name,
 * sizeBytes}]}`; `codeAction.actionResult.edit.diff.unifiedDiff.lines[]` with
 * typed UNCHANGED/DELETE/INSERT lines. `viewFile`/`find` were confirmed typed
 * but their field-level shape was not read off the wire in the probe --
 * stringified whole regardless, so no field name had to be guessed.
 * `generic`/`runCommand` are the documented (not live-observed) fallback.
 */
function extractResultPayload(step: CascadeStep): string {
  switch (step.type) {
    case STEP_TYPE_LIST_DIRECTORY:
      return JSON.stringify(step.listDirectory ?? {});
    case STEP_TYPE_VIEW_FILE:
      return JSON.stringify(step.viewFile ?? {});
    case STEP_TYPE_FIND:
      return JSON.stringify(step.find ?? {});
    case STEP_TYPE_CODE_ACTION:
      return JSON.stringify(step.codeAction ?? {});
    case STEP_TYPE_RUN_COMMAND:
      return JSON.stringify(step.runCommand ?? {});
    case STEP_TYPE_GENERIC:
    default: {
      const generic = step.generic;
      if (typeof generic?.result?.result === 'string') return generic.result.result;
      return JSON.stringify(step.generic ?? {});
    }
  }
}

/**
 * Map one already-terminal `Step` to zero or more protocol events. Only
 * called on a step whose status is in `TERMINAL_STATUSES` -- a step that is
 * still `GENERATING`/`RUNNING`/`PENDING`/`QUEUED` mutates in place and must
 * not be consumed yet (see the poll loop in `run()`).
 */
export function mapCascadeStepToEvents(step: CascadeStep): CascadeProtocolEvent[] {
  const { type, status } = step;

  if (
    type === STEP_TYPE_USER_INPUT ||
    type === STEP_TYPE_SYSTEM_MESSAGE ||
    type === STEP_TYPE_EPHEMERAL_MESSAGE ||
    type === STEP_TYPE_WAIT
  ) {
    // Host's own input echoed back, or status-line noise -- emitting it would
    // duplicate the user's message in the transcript (doc 04 §3.1).
    return [];
  }

  if (type === STEP_TYPE_PLANNER_RESPONSE) {
    const pr = step.plannerResponse ?? {};
    const events: CascadeProtocolEvent[] = [];
    // `thinking` is dropped, not folded into 'text': StreamChunk has no
    // 'thinking' member, and sendMessage persists 'text' content as the
    // saved assistant turn -- reasoning would leak into the transcript.
    if (typeof pr.response === 'string' && pr.response.trim().length > 0) {
      events.push({ type: 'text', content: pr.response });
    }
    for (const tc of pr.toolCalls ?? []) {
      if (!tc.id || !tc.name) continue;
      if (tc.invalidJsonErr) {
        events.push({ type: 'tool_error', id: tc.id, name: tc.name, error: tc.invalidJsonErr });
        continue;
      }
      let args: Record<string, unknown> = {};
      if (tc.argumentsJson) {
        try {
          args = JSON.parse(tc.argumentsJson) as Record<string, unknown>;
        } catch {
          args = {};
        }
      }
      events.push({ type: 'tool_call', id: tc.id, name: tc.name, args });
    }
    return events;
  }

  if (type === STEP_TYPE_ERROR_MESSAGE) {
    const em = step.errorMessage;
    // Only surface when shouldShowUser -- shouldShowModel-only means the
    // server is feeding it back to the planner itself, not us (doc 04 §3.1).
    if (em?.shouldShowUser) {
      const msg =
        em.error?.userErrorMessage ?? em.error?.shortError ?? em.error?.fullError ??
        'The Cascade agent reported an error.';
      return [{ type: 'error', error: msg }];
    }
    return [];
  }

  // Result-carrying step: typed (listDirectory/viewFile/find/codeAction/
  // runCommand) or the generic fallback. `metadata.toolCall.id` is the join
  // key back to the announcing PLANNER_RESPONSE's toolCalls[] entry --
  // confirmed populated on the wire (step3-results.md b′), not merely in the
  // offline SQLite decode doc 04 flagged as unverified.
  const toolCall = step.metadata?.toolCall;
  if (toolCall?.id && toolCall?.name) {
    // Confirmed live (step3-results.md): the title comes from the RESULT
    // step's `metadata.toolSummary`, a sibling of `metadata.toolCall`, not
    // from anything inside the tool call's own arguments.
    const description = step.metadata?.toolSummary ?? step.metadata?.toolAction;
    if (status === STATUS_ERROR) {
      const msg =
        step.error?.userErrorMessage ?? step.error?.shortError ?? step.error?.fullError ??
        'Cascade tool step failed.';
      return [{ type: 'tool_error', id: toolCall.id, name: toolCall.name, error: msg, description }];
    }
    if (status === STATUS_CANCELED) {
      // The provider's own abortController path already stops yielding on
      // cancellation; nothing more to say here.
      return [];
    }
    if (status === STATUS_DONE) {
      return [
        {
          type: 'tool_result',
          id: toolCall.id,
          name: toolCall.name,
          result: extractResultPayload(step),
          description,
        },
      ];
    }
  }
  return [];
}

/**
 * True when this step ends the whole turn: a `PLANNER_RESPONSE` with no
 * pending tool calls (confirmed live terminal signal, step3-results.md b2:
 * "last step a non-empty final response with no toolCalls"), a
 * `PLANNER_RESPONSE` whose generation was cancelled server-side (stopReason,
 * not status -- see STOP_REASON_CLIENT_STREAM_ERROR above), or a
 * `CORTEX_STEP_TYPE_FINISH` step (only produced if a future step sets
 * `executorConfig.requireFinishTool`; recognized here so that wiring needs no
 * rework of this function).
 */
export function isCascadeTurnTerminal(step: CascadeStep): boolean {
  if (step.type === STEP_TYPE_FINISH) return true;
  if (step.type !== STEP_TYPE_PLANNER_RESPONSE) return false;
  const pr = step.plannerResponse ?? {};
  if (pr.stopReason === STOP_REASON_CLIENT_STREAM_ERROR) return true;
  return !(Array.isArray(pr.toolCalls) && pr.toolCalls.length > 0);
}

export class AntigravityCascadeProtocol {
  private readonly cascadeClient: AntigravityCascadeClient;
  private readonly pollIntervalMs: number;
  private readonly blocking: boolean;

  constructor(opts: { cascadeClient: AntigravityCascadeClient; pollIntervalMs?: number; blocking?: boolean }) {
    this.cascadeClient = opts.cascadeClient;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.blocking = opts.blocking ?? false;
  }

  /**
   * Run one Cascade turn: capture the pre-turn step count as a cursor, send
   * the message, then consume steps from that cursor forward until a
   * terminal signal or the wall-clock deadline. All cascade history lives
   * server-side (that is the whole point of the transport), so this method
   * carries no state across calls -- one instance can be reused for every
   * turn of every session.
   */
  async *run(params: CascadeTurnParams): AsyncGenerator<CascadeProtocolEvent> {
    const {
      cascadeId,
      modelKeyOrEnum,
      userMessage,
      maxGeneratorInvocations = DEFAULT_MAX_GENERATOR_INVOCATIONS,
      completionMaxTokens = DEFAULT_COMPLETION_MAX_TOKENS,
      userInteractionTimeoutSeconds = DEFAULT_USER_INTERACTION_TIMEOUT_SECONDS,
      toolOutputMaxBytes = DEFAULT_TOOL_OUTPUT_MAX_BYTES,
      mcpEndpoints,
      timeoutMs = DEFAULT_TURN_TIMEOUT_MS,
      abortSignal,
    } = params;

    // Capture the cursor BEFORE sending: a cascade's step list holds every
    // turn ever sent to it, not just this one (doc 04 §3.2) -- without this,
    // there is no way to tell this turn's steps from a prior turn's.
    let cursor: number;
    try {
      const before = await this.cascadeClient.getCascadeTrajectorySteps(cascadeId, 0, undefined, abortSignal);
      cursor = before.steps?.length ?? 0;
    } catch (err) {
      yield { type: 'error', error: describeError(err) };
      return;
    }

    if (abortSignal?.aborted) return;

    try {
      await this.cascadeClient.sendUserCascadeMessage(
        {
          cascadeId,
          text: userMessage,
          modelKeyOrEnum,
          blocking: this.blocking,
          maxGeneratorInvocations,
          completionMaxTokens,
          userInteractionTimeoutSeconds,
          toolOutputMaxBytes,
          mcpEndpoints,
        },
        timeoutMs,
        abortSignal,
      );
    } catch (err) {
      yield { type: 'error', error: describeError(err) };
      return;
    }

    const deadline = Date.now() + timeoutMs;

    while (true) {
      if (abortSignal?.aborted) return;
      if (Date.now() > deadline) {
        yield {
          type: 'error',
          error: `Cascade turn timed out after ${Math.round(timeoutMs / 1000)}s waiting for steps.`,
        };
        return;
      }

      let resp;
      try {
        resp = await this.cascadeClient.getCascadeTrajectorySteps(cascadeId, cursor, undefined, abortSignal);
      } catch (err) {
        yield { type: 'error', error: describeError(err) };
        return;
      }
      const steps = resp.steps ?? [];

      let advanced = 0;
      let turnDone = false;
      for (const step of steps) {
        const status = step.status;
        if (status === STATUS_WAITING) {
          // Hang risk (doc 04 §3.1): a cascade parked in WAITING produces no
          // further steps and no error on its own. Real HandleCascadeUserInteraction
          // wiring (a genuine permission prompt) needs a trajectoryId this
          // protocol doesn't resolve and an oneof shape never observed live
          // (plan step 4, still open) -- cancel rather than leave the cascade
          // parked server-side indefinitely, and surface what it was waiting
          // on when that's identifiable.
          const kind = describeRequestedInteraction(step.requestedInteraction);
          try {
            await this.cascadeClient.cancelInvocation(cascadeId, true, undefined, abortSignal);
          } catch {
            // Best-effort cleanup -- the error below is what the caller acts on.
          }
          yield {
            type: 'error',
            error: kind
              ? `The Cascade agent is waiting for a "${kind}" interaction Nimbalyst cannot answer yet; cancelled the turn.`
              : 'The Cascade agent is waiting on a user interaction Nimbalyst cannot answer yet; cancelled the turn.',
          };
          return;
        }
        if (!status || !TERMINAL_STATUSES.has(status)) {
          // Still mutating (GENERATING/RUNNING/PENDING/QUEUED) -- stop this
          // batch here so the next poll re-fetches from this exact index
          // rather than losing the step's eventual result (doc 04 §3.2).
          break;
        }
        for (const ev of mapCascadeStepToEvents(step)) yield ev;
        advanced++;
        if (isCascadeTurnTerminal(step)) {
          turnDone = true;
          break;
        }
      }
      cursor += advanced;

      if (turnDone) {
        yield { type: 'complete' };
        return;
      }
      if (abortSignal?.aborted) return;
      await delay(this.pollIntervalMs);
    }
  }
}

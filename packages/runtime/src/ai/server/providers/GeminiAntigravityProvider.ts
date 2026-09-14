/**
 * Gemini agent provider, backed by the Antigravity language server.
 *
 * Not a `HeadlessCliAgentProvider` subclass. That base assumes one process per
 * turn streaming NDJSON on stdout; Antigravity is a long-lived local server
 * addressed over Connect-RPC, whose single relevant call --
 * `GetModelResponse({prompt, model}) -> {response}` -- is stateless, buffered,
 * and has no function-calling surface. `AntigravityToolLoopProtocol` supplies
 * the tool loop the transport lacks; this class is the host-facing half.
 *
 * Three consequences of that transport, each declared rather than assumed:
 *
 *   - **No provider session id on the text-loop transport.** The server keeps
 *     nothing between calls there, so the whole conversation is re-rendered
 *     into one flat prompt per turn from the host's own message history, and
 *     resuming a session is just re-seeding the loop. The Cascade transport
 *     (Phase 2A, `gemini-power-parity.md` section 6; feature-flagged, default
 *     off) is the opposite: the server owns the trajectory, so
 *     `getProviderSessionData` returns the persisted cascade id and a later
 *     turn reattaches via `AntigravityCascadeClient.ensureCascade` instead of
 *     starting over.
 *   - **No usage numbers.** The response envelope carries only `response`.
 *     `contextReporting: 'none'` in `agentCapabilities.ts` follows from that --
 *     a percentage drawn from a token count we do not have would be a lying 0%
 *     (#914). Quota lives on a separate account-level RPC; see
 *     `AntigravityUsageMeter`.
 *   - **`'tool-args'` file fidelity, not `'structured'`.** Nimbalyst performs
 *     Gemini's writes itself, so an exact pre-edit baseline is free and this
 *     provider emits authoritative pre/post edit snapshots. It still stops
 *     short of `'structured'` because the toolset has no delete and no move:
 *     every removal is an opaque `rm` inside `run_command`. Declaring
 *     `'structured'` would switch the filesystem watcher off and make those
 *     removals vanish from the Files Edited sidebar. Same reasoning as
 *     `grok-build`, whose toolset is identical in this respect.
 *
 * Auth rides the user's existing Antigravity login. Nimbalyst stores no key for
 * it and reads no environment variable. That login is NOT on disk under
 * `~/.gemini` (which holds only onboarding state and config) -- on macOS it is
 * in the keychain, service `gemini`, account `antigravity`. Which is why
 * detection can answer "installed" but not "signed in"; see
 * `headlessAgentAvailability.ts`.
 */

import { BaseAgentProvider } from './BaseAgentProvider';
import {
  AntigravityServerManager,
  AntigravityVersionGateError,
} from './geminiAntigravity/AntigravityServerManager';
import { AntigravityToolLoopProtocol } from './geminiAntigravity/AntigravityToolLoopProtocol';
import { AntigravityCascadeClient } from './geminiAntigravity/AntigravityCascadeClient';
import { AntigravityCascadeProtocol } from './geminiAntigravity/AntigravityCascadeProtocol';
import { buildEditSnapshotFromCascadeToolResult } from './geminiAntigravity/cascadeEditSnapshots';
import type { McpEndpointInput } from './geminiAntigravity/cascadeMcpConfig';
import { renderAttachments } from './geminiAntigravity/renderAttachments';
import { buildUserMessageAddition } from './documentContextUtils';
import {
  DEFAULT_GEMINI_MODEL_KEY,
  bareGeminiModelKey,
  discoverGeminiCatalog,
} from './geminiAntigravity/geminiAntigravityModels';
import type { ProviderSessionData } from './ProviderSessionManager';
import type { ProviderCatalogHealth } from '../types';
import { reportCatalogHealth } from './catalogHealthRegistry';
import type {
  AgentToolDefinition,
  AIModel,
  AIProviderType,
  ChatAttachment,
  DocumentContext,
  Message,
  ProviderConfig,
  StreamChunk,
  ToolHandler,
} from '../types';

export const GEMINI_ANTIGRAVITY_PROVIDER: AIProviderType = 'antigravity-gemini-agent';

/**
 * Outcome of a host-executed tool call.
 *
 * `text` is what the model sees. `fileWrite` is present only when the call
 * actually wrote a file, and carries the content read immediately before the
 * write -- the baseline no watcher or snapshot cache can beat, because nothing
 * ran between the read and the write.
 */
export interface GeminiToolExecutionResult {
  text: string;
  fileWrite?: {
    absPath: string;
    /** `null` when the file did not exist -- a create, not an update. */
    beforeContent: string | null;
    afterContent: string;
  };
}

export interface GeminiToolExecutorArgs {
  sessionId: string;
  workspacePath?: string;
  name: string;
  args: Record<string, unknown>;
}

export type GeminiToolExecutor = (args: GeminiToolExecutorArgs) => Promise<GeminiToolExecutionResult>;

/** Server tuning the Electron main process reads out of settings. */
export interface GeminiServerConfig {
  overrideIdeVersion?: string;
  spawnPortCandidates?: number[];
  /** Per-call ceiling for one GetModelResponse round trip, in ms. */
  modelResponseTimeoutMs?: number;
  /**
   * Which turn transport to use. `'text-loop'` (default) is the existing
   * `GetModelResponse` + prompt-embedded tool calls. `'cascade'` is Phase 2A
   * (`gemini-power-parity.md` section 6): a session gets a real, resumable
   * Cascade trajectory and turns run through `AntigravityCascadeProtocol`
   * (native step polling, server-executed tools). MCP tool registration and
   * permission-prompt wiring (plan steps 4 and 6) are not yet built, so a
   * cascade turn runs with `autoAllowAllInteractions` and no host tools.
   */
  transport?: 'cascade' | 'text-loop';
}

interface SessionState {
  sessionId: string;
  workspacePath?: string;
  modelKey: string;
  toolLoop: AntigravityToolLoopProtocol;
  abortController: AbortController | null;
}

// The call is buffered, so a timeout throws away completed work rather than
// truncating it. Overridable per install via `modelResponseTimeoutMs`.
const MODEL_RESPONSE_TIMEOUT_MS = 600_000;

// run_command tuning. The command runs in this process with the session's
// workspace as cwd, bounded by a hard timeout and output caps.
const RUN_COMMAND_TIMEOUT_MS = 120_000;
const RUN_COMMAND_MAX_BUFFER = 4 * 1024 * 1024;
const RUN_COMMAND_MAX_OUTPUT = 48_000;

/**
 * Node's `exec` defaults to cmd.exe on Windows, which does not treat `;` as a
 * separator, so `;`-joined commands fail confusingly rather than loudly.
 * Prefer PowerShell 7, fall back to the OS-bundled powershell.exe.
 */
let cachedWindowsShell: string | null = null;
function windowsCommandShell(): string {
  if (cachedWindowsShell !== null) return cachedWindowsShell;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('child_process') as typeof import('child_process');
    execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    cachedWindowsShell = 'pwsh.exe';
  } catch {
    cachedWindowsShell = 'powershell.exe';
  }
  return cachedWindowsShell;
}

function clampCommandOutput(text: string): string {
  return text.length <= RUN_COMMAND_MAX_OUTPUT
    ? text
    : `${text.slice(0, RUN_COMMAND_MAX_OUTPUT)}\n\n[output truncated at ${RUN_COMMAND_MAX_OUTPUT} characters]`;
}

export class GeminiAntigravityProvider extends BaseAgentProvider {
  private static toolExecutor: GeminiToolExecutor | null = null;
  private static serverConfigLoader: (() => GeminiServerConfig) | null = null;
  private static mcpEndpointsLoader: ((workspacePath: string) => McpEndpointInput[]) | null = null;

  private readonly sessionStates = new Map<string, SessionState>();
  private readonly server: AntigravityServerManager;
  private readonly cascadeClient: AntigravityCascadeClient;
  private readonly cascadeProtocol: AntigravityCascadeProtocol;

  constructor(deps?: { server?: AntigravityServerManager; cascadeClient?: AntigravityCascadeClient }) {
    super();
    this.server = deps?.server ?? AntigravityServerManager.shared();
    this.cascadeClient = deps?.cascadeClient ?? new AntigravityCascadeClient(this.server);
    this.cascadeProtocol = new AntigravityCascadeProtocol({ cascadeClient: this.cascadeClient });
  }

  getProviderName(): AIProviderType {
    return GEMINI_ANTIGRAVITY_PROVIDER;
  }

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
    GeminiAntigravityProvider.applyServerConfig(this.server);
  }

  /**
   * Must run before anything that can spawn: `configure()` does not re-version
   * a running server, so the first spawn decides it for the whole app session.
   */
  private static applyServerConfig(server: AntigravityServerManager): void {
    const serverConfig = GeminiAntigravityProvider.serverConfigLoader?.();
    if (serverConfig) {
      server.configure(serverConfig);
      const t = serverConfig.modelResponseTimeoutMs;
      if (typeof t === 'number' && Number.isFinite(t) && t > 0) {
        GeminiAntigravityProvider.modelResponseTimeoutMs = t;
      }
      if (serverConfig.transport === 'cascade' || serverConfig.transport === 'text-loop') {
        GeminiAntigravityProvider.transport = serverConfig.transport;
      }
    }
  }

  private static modelResponseTimeoutMs: number = MODEL_RESPONSE_TIMEOUT_MS;
  private static transport: 'cascade' | 'text-loop' = 'text-loop';

  /**
   * On the text-loop transport there is nothing to return -- the language
   * server holds no session state. On the Cascade transport this returns the
   * persisted cascade id, which is what lets a later turn reattach instead of
   * starting a fresh trajectory.
   */
  getProviderSessionData(sessionId: string): ProviderSessionData | null {
    const { providerSessionId } = this.sessions.getProviderSessionData(sessionId);
    return providerSessionId ? { providerSessionId } : null;
  }

  registerToolHandler(_handler: ToolHandler): void {
    // Tools are executed through the injected `toolExecutor` (host-side, with
    // the workspace jail the host owns), not through the runtime tool-handler
    // surface. Kept so the class satisfies `AIProvider`.
  }

  abort(): void {
    for (const [sessionId, state] of this.sessionStates.entries()) {
      // Phase 2A step 9: the abortSignal only stops US from consuming further
      // steps -- the cascade keeps generating server-side unless explicitly
      // cancelled. Only for a session with a turn actually in flight
      // (non-null abortController), and only fired once per abort() (not
      // re-fired for an already-idle session).
      if (state.abortController && GeminiAntigravityProvider.transport === 'cascade') {
        const cascadeId = this.sessions.getSessionId(sessionId);
        if (cascadeId) {
          void this.cascadeClient.cancelInvocation(cascadeId).catch(() => {
            // Best-effort: the client-side abortSignal already stops this
            // provider from doing anything further with this turn.
          });
        }
      }
      state.abortController?.abort();
      state.toolLoop.abort();
    }
    super.abort();
  }

  destroy(): void {
    this.abort();
    this.sessionStates.clear();
    super.destroy();
  }

  async *sendMessage(
    message: string,
    documentContext?: DocumentContext,
    sessionId?: string,
    messages?: Message[],
    workspacePath?: string,
    attachments?: ChatAttachment[],
    tools?: AgentToolDefinition[],
    systemPrompt?: string,
  ): AsyncIterableIterator<StreamChunk> {
    if (!sessionId) {
      yield { type: 'error', error: 'Gemini requires a session id.' };
      return;
    }

    const state = this.resolveSession(sessionId, workspacePath, documentContext);
    const abortController = new AbortController();
    state.abortController = abortController;
    this.abortController = abortController;

    if (GeminiAntigravityProvider.transport === 'cascade') {
      try {
        yield* this.runCascadeTransportTurn(sessionId, state, message, documentContext, abortController.signal);
      } finally {
        state.abortController = null;
        if (this.abortController === abortController) this.abortController = null;
      }
      return;
    }

    // Re-seed the loop from the host's canonical history. The turn's own user
    // message is appended by run(), so a trailing duplicate of it is dropped
    // rather than sent twice.
    if (messages && messages.length > 0) {
      const prior = [...messages];
      const last = prior[prior.length - 1];
      if (last?.role === 'user' && typeof last.content === 'string'
        && last.content.trim() === message.trim()) {
        prior.pop();
      }
      state.toolLoop.seedHistory(prior);
    }

    // Folded in AFTER the dedup check above, which compares against the
    // host's own history and must see the pristine text.
    message = await this.prepareTurnInput(sessionId, state, message, documentContext);

    let finalText = '';
    let sawText = false;
    let toolCallSeq = 0;
    // The tool loop reports a call and its result as two separate steps keyed
    // only by tool name, so the id minted on the call is held here until the
    // matching result arrives. It becomes the chunk's `toolUseId`, which is
    // what file attribution and pre-edit history tags correlate on.
    const pendingCalls = new Map<
      string,
      { id: string; name: string; args: Record<string, unknown>; description?: string }
    >();

    // Rendered (and sanitized) here, not folded into `message` above: this
    // reaches only the model, via the tool loop's history entry for this
    // turn -- the persisted "input" log row stays exactly what the user
    // typed (plus document context, which the codebase already persists).
    const attachmentsBlock = await renderAttachments(attachments);

    try {
      for await (const step of state.toolLoop.run(
        message,
        systemPrompt ?? '',
        (tools ?? []) as Array<{ type: 'function'; function: { name: string } }>,
        (name, args) => this.executeTool(state, name, args),
        GeminiAntigravityProvider.modelResponseTimeoutMs,
        abortController.signal,
        attachmentsBlock,
      )) {
        if (abortController.signal.aborted) break;

        if (step.type === 'tool_call') {
          const id = `agy-${Date.now()}-${toolCallSeq++}`;
          pendingCalls.set(step.name, {
            id,
            name: step.name,
            args: step.args,
            description: step.description,
          });
          yield {
            type: 'tool_call',
            toolCall: {
              id,
              name: step.name,
              arguments: step.args,
              description: step.description,
            },
          };
        } else if (step.type === 'tool_result') {
          const pending = pendingCalls.get(step.name);
          if (!pending) {
            // No id to attribute a write to. Drop any buffered snapshot rather
            // than letting it ride along to the NEXT tool's id, which would
            // pin one tool's file change onto an unrelated call in the diff
            // view. Losing the snapshot degrades to watcher attribution;
            // mis-attributing it is a wrong answer stated confidently.
            this.pendingEditSnapshots.length = 0;
            continue;
          }
          // Emit the edit snapshots BEFORE the terminal tool_call chunk. That
          // chunk closes the attribution window, and a snapshot arriving after
          // it would tag a file the host has stopped associating with the call.
          for (const snapshot of this.drainEditSnapshots(pending.id)) {
            yield snapshot;
          }
          yield await this.persistToolResult(sessionId, pending, step.result);
          pendingCalls.delete(step.name);
        } else if (step.type === 'text') {
          finalText = step.content;
          sawText = true;
          // Always surface something: an empty assistant turn would otherwise
          // leave the transcript with no assistant message at all for the turn.
          yield {
            type: 'text',
            content: finalText.trim().length === 0 ? '(model returned no text)' : finalText,
          };
        } else if (step.type === 'complete') {
          yield await this.persistTurnCompletion(sessionId, state, finalText, sawText);
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) return;
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (/not found at |Install Antigravity/i.test(errorMessage)) {
        yield { type: 'error', error: GeminiAntigravityProvider.NOT_INSTALLED_MESSAGE };
      } else if (error instanceof AntigravityVersionGateError) {
        // The server enforces a supported-build floor and Antigravity has
        // raised it. The underlying message names the flag, which is no use to
        // anyone; say what to actually do. Updating Antigravity is the fix, and
        // the settings key is the escape hatch for someone who cannot wait for
        // a Nimbalyst release.
        yield { type: 'error', error: GeminiAntigravityProvider.VERSION_GATE_MESSAGE };
      } else if (/not logged in|unauthorized|forbidden|HTTP 401|HTTP 403/i.test(errorMessage)) {
        yield {
          type: 'error',
          error: GeminiAntigravityProvider.NOT_SIGNED_IN_MESSAGE,
          isAuthError: true,
        };
      } else {
        yield { type: 'error', error: errorMessage };
      }
    } finally {
      state.abortController = null;
      if (this.abortController === abortController) this.abortController = null;
      this.pendingEditSnapshots.length = 0;
    }
  }

  // --- Shared turn bookkeeping (both transports) ---------------------------
  //
  // The text loop and the Cascade protocol are different state machines --
  // different event shapes in, different error semantics, different
  // pendingCalls key spaces -- but the transcript rows and StreamChunks they
  // hand the host are the canonical ones and must be byte-identical whichever
  // transport produced them. These three helpers are that canonical half; the
  // machine-specific half stays inline in each turn method.

  /**
   * Fold document context into the turn's message and persist the input row.
   * Matches ClaudeProvider/OpenAIProvider/OpenAICodexProvider's shared
   * `buildUserMessageAddition` convention: the augmented message is what gets
   * persisted AND what the model sees, not just the latter --
   * `withPromptProvenanceMetadata`-style consumers of the logged input row
   * expect that. Returns the augmented message.
   */
  private async prepareTurnInput(
    sessionId: string,
    state: SessionState,
    message: string,
    documentContext: DocumentContext | undefined,
  ): Promise<string> {
    const { messageWithContext } = buildUserMessageAddition(message, documentContext);
    await this.logAgentMessageBestEffort(sessionId, 'input', messageWithContext, {
      metadata: {
        role: 'user',
        timestamp: Date.now(),
        model: state.modelKey,
        documentContext,
      },
    });
    return messageWithContext;
  }

  /**
   * Persist a completed tool call and return the chunk that closes it out.
   *
   * `toolUseId` is what makes a reloaded transcript agree with the live one:
   * without it the parser has to mint a synthetic id, and the reloaded tool
   * card is a different event from the streamed one. Rows written before this
   * existed have none, which is why `GeminiAntigravityRawParser` still has a
   * synthetic fallback.
   */
  private async persistToolResult(
    sessionId: string,
    call: { id: string; name: string; args: Record<string, unknown>; description?: string },
    result: string,
  ): Promise<StreamChunk> {
    await this.logAgentMessageBestEffort(
      sessionId,
      'output',
      JSON.stringify({
        name: call.name,
        result,
        args: call.args,
        description: call.description,
      }),
      { metadata: { role: 'tool', timestamp: Date.now(), toolUseId: call.id } },
    );
    return {
      type: 'tool_call',
      toolCall: {
        id: call.id,
        name: call.name,
        arguments: call.args,
        result,
        description: call.description,
      },
    };
  }

  /**
   * Persist the turn's final assistant text and return the terminal chunk.
   * `sawText` distinguishes "the model spoke and said nothing" from "the model
   * never spoke at all", which read the same in `finalText` alone.
   */
  private async persistTurnCompletion(
    sessionId: string,
    state: SessionState,
    finalText: string,
    sawText: boolean,
  ): Promise<StreamChunk> {
    const persisted = finalText.trim().length === 0
      ? (sawText ? '(model returned no text)' : '(no model response)')
      : finalText;
    await this.logAgentMessageBestEffort(sessionId, 'output', persisted, {
      metadata: { role: 'assistant', timestamp: Date.now(), model: state.modelKey },
    });
    return { type: 'complete', content: persisted, isComplete: true };
  }

  /**
   * Phase 2A steps 2-3: attach/track/start-or-resume (step 1, unchanged) then
   * actually run the turn through `AntigravityCascadeProtocol` -- send the
   * message, poll trajectory steps to a terminal signal, and map each event
   * to the same `StreamChunk` shapes the text-loop path already produces
   * (tool_call announce, tool_call+result, text, complete), so downstream
   * consumers (transcript persistence, file-attribution, the UI) don't need
   * to know which transport produced them. Bounds
   * (`completionConfigOverride.maxTokens`, `maxGeneratorInvocations`,
   * `userInteractionTimeoutSeconds`) use the protocol's documented defaults;
   * MCP tool registration and permission-prompt wiring are later steps in the
   * same plan (steps 4 and 6) and are not attempted here.
   *
   * Unlike the text loop's `pendingCalls` map (keyed by tool NAME, because
   * `GetModelResponse` mints no id), this keys by the id the cascade itself
   * assigns to each tool call -- confirmed populated on the wire
   * (step3-results.md b'), not just in the offline SQLite decode doc 04
   * flagged as unverified.
   */
  private async *runCascadeTransportTurn(
    sessionId: string,
    state: SessionState,
    message: string,
    documentContext: DocumentContext | undefined,
    abortSignal: AbortSignal,
  ): AsyncIterableIterator<StreamChunk> {
    if (!state.workspacePath) {
      yield {
        type: 'error',
        error: 'Cascade transport needs an open workspace; none is bound to this session.',
      };
      return;
    }

    let cascadeId: string;
    try {
      const persistedCascadeId = this.sessions.getSessionId(sessionId);
      const result = await this.cascadeClient.ensureCascade({
        workspacePath: state.workspacePath,
        modelKeyOrEnum: state.modelKey,
        persistedCascadeId,
        abortSignal,
      });
      cascadeId = result.cascadeId;
      this.sessions.captureSessionId(sessionId, cascadeId);
    } catch (error) {
      yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
      return;
    }

    // Attachments are NOT folded in here -- `TextOrScopeItem`'s non-text
    // `item` variant (ContextScopeItem) was not exercised by the live probe,
    // so its shape would be guessed rather than evidenced; that stays on the
    // text-loop transport for now.
    const turnMessage = await this.prepareTurnInput(sessionId, state, message, documentContext);

    let finalText = '';
    let sawText = false;
    // No `description` field here (unlike the text-loop path's pendingCalls):
    // Cascade never knows a call's title at announce time, only once the
    // result step's `metadata.toolSummary` arrives.
    const pendingCalls = new Map<string, { id: string; name: string; args: Record<string, unknown> }>();

    const mcpEndpoints = state.workspacePath
      ? (GeminiAntigravityProvider.mcpEndpointsLoader?.(state.workspacePath) ?? [])
      : [];

    try {
      for await (const ev of this.cascadeProtocol.run({
        cascadeId,
        modelKeyOrEnum: state.modelKey,
        userMessage: turnMessage,
        mcpEndpoints,
        timeoutMs: GeminiAntigravityProvider.modelResponseTimeoutMs,
        abortSignal,
      })) {
        if (abortSignal.aborted) break;

        if (ev.type === 'tool_call') {
          // No description yet: Cascade doesn't know the title until the
          // result step's `metadata.toolSummary` arrives (see
          // AntigravityCascadeProtocol's tool_result/tool_error events).
          pendingCalls.set(ev.id, { id: ev.id, name: ev.name, args: ev.args });
          yield {
            type: 'tool_call',
            toolCall: { id: ev.id, name: ev.name, arguments: ev.args },
          };
        } else if (ev.type === 'tool_result') {
          const pending = pendingCalls.get(ev.id);
          if (!pending) {
            // No announce chunk to attribute this to (shouldn't happen on a
            // well-formed trajectory) -- drop rather than guess.
            continue;
          }
          // Phase 2A step 5: a write tool's result carries the raw codeAction
          // payload (see AntigravityCascadeProtocol's extractResultPayload),
          // which reconstructs the same before/after snapshot shape the
          // text-loop path gets from the injected executor's `fileWrite`.
          // Emitted BEFORE the terminal tool_call chunk below, same ordering
          // as the text-loop path (that chunk closes the attribution window).
          const snapshot = buildEditSnapshotFromCascadeToolResult(ev.name, ev.result);
          if (snapshot) {
            this.pendingEditSnapshots.push({
              absPath: snapshot.path,
              beforeContent: snapshot.beforeContent,
              afterContent: snapshot.afterContent,
            });
          }
          for (const snapshotChunk of this.drainEditSnapshots(ev.id)) {
            yield snapshotChunk;
          }
          // The description arrives with the RESULT, not the announce, so it
          // comes off the event rather than the pending entry.
          yield await this.persistToolResult(
            sessionId,
            { id: ev.id, name: ev.name, args: pending.args, description: ev.description },
            ev.result,
          );
          pendingCalls.delete(ev.id);
        } else if (ev.type === 'tool_error') {
          const pending = pendingCalls.get(ev.id);
          yield {
            type: 'tool_error',
            toolError: { name: ev.name, arguments: pending?.args, error: ev.error },
          };
          pendingCalls.delete(ev.id);
        } else if (ev.type === 'text') {
          finalText = ev.content;
          sawText = true;
          yield {
            type: 'text',
            content: finalText.trim().length === 0 ? '(model returned no text)' : finalText,
          };
        } else if (ev.type === 'error') {
          yield { type: 'error', error: ev.error };
        } else if (ev.type === 'complete') {
          yield await this.persistTurnCompletion(sessionId, state, finalText, sawText);
        }
      }
    } catch (error) {
      yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  }

  // --- Tool execution ------------------------------------------------------

  /**
   * Edit snapshots produced by the current turn's writes, drained onto the
   * stream when the write's tool result comes back. Buffered rather than
   * yielded inline because the executor is a plain callback the tool loop
   * awaits -- it has no channel back onto the generator.
   */
  private readonly pendingEditSnapshots: Array<{
    beforeContent: string | null;
    afterContent: string;
    absPath: string;
  }> = [];

  private async executeTool(
    state: SessionState,
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    if (name === 'run_command') {
      return this.runCommand(state.workspacePath, args);
    }
    const executor = GeminiAntigravityProvider.toolExecutor;
    if (!executor) {
      return `Error: "${name}" cannot run -- no tool executor is installed for this provider.`;
    }
    const result = await executor({
      sessionId: state.sessionId,
      workspacePath: state.workspacePath,
      name,
      args,
    });
    if (result.fileWrite) this.pendingEditSnapshots.push(result.fileWrite);
    return result.text;
  }

  /**
   * Turn this turn's buffered writes into the pre/post snapshot chunks
   * `MessageStreamingHandler` writes as local-history entries.
   *
   * `authoritative: true` is earned, not asserted: `beforeContent` was read
   * inside the write path microseconds before the write, so a FileSnapshotCache
   * lookup at this point can only be staler. A `null` before-content means the
   * file did not exist, and an empty-string baseline is the correct one for a
   * create -- unlike the `'structured'` providers, which must skip the entry
   * because they cannot distinguish "no baseline recorded" from "empty file".
   */
  private *drainEditSnapshots(toolUseId: string): Generator<StreamChunk> {
    if (this.pendingEditSnapshots.length === 0) return;
    const writes = this.pendingEditSnapshots.splice(0, this.pendingEditSnapshots.length);
    yield {
      type: 'pre_edit_snapshot',
      preEditSnapshot: {
        toolUseId,
        entries: writes.map((w) => ({
          path: w.absPath,
          content: w.beforeContent ?? '',
          kind: w.beforeContent === null ? 'add' : 'update',
        })),
        authoritative: true,
      },
    };
    yield {
      type: 'post_edit_snapshot',
      postEditSnapshot: {
        toolUseId,
        entries: writes.map((w) => ({
          path: w.absPath,
          content: w.afterContent,
          kind: w.beforeContent === null ? 'add' : 'update',
        })),
      },
    };
  }

  /**
   * Run a shell command in the session's workspace and return stdout/stderr/exit
   * code as text for the model. Bounded by a timeout and output caps; cwd is
   * pinned to the workspace so a bare relative path cannot escape it.
   *
   * Unlike the other tools this does not go through the host executor, because
   * it needs nothing the host owns beyond a working directory. Note it runs
   * from Nimbalyst's own process rather than the extension utility process it
   * used to live in -- `exec` is async and the child is what dies on a bad
   * command, so a runaway cannot block the event loop, but the timeout and the
   * output caps are what keep it bounded and neither is optional.
   */
  private async runCommand(
    workspacePath: string | undefined,
    args: Record<string, unknown>,
  ): Promise<string> {
    const command = typeof args.command === 'string' ? args.command.trim() : '';
    if (!command) return 'Error: run_command requires a non-empty "command" string.';
    if (!workspacePath) {
      return 'Error: run_command needs an open workspace; none is bound to this session.';
    }
    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workspacePath,
        timeout: RUN_COMMAND_TIMEOUT_MS,
        maxBuffer: RUN_COMMAND_MAX_BUFFER,
        windowsHide: true,
        ...(process.platform === 'win32' ? { shell: windowsCommandShell() } : {}),
      });
      const body =
        [stdout ? `stdout:\n${stdout}` : '', stderr ? `stderr:\n${stderr}` : '']
          .filter(Boolean)
          .join('\n\n') || '(no output)';
      return clampCommandOutput(`$ ${command}\nexit code: 0\n\n${body}`);
    } catch (err: unknown) {
      const e = err as {
        code?: number; killed?: boolean; signal?: string;
        stdout?: string; stderr?: string; message?: string;
      };
      if (e.killed && e.signal === 'SIGTERM') {
        return clampCommandOutput(
          `$ ${command}\n[command timed out after ${RUN_COMMAND_TIMEOUT_MS / 1000}s]`,
        );
      }
      const parts = [
        `$ ${command}`,
        `exit code: ${typeof e.code === 'number' ? e.code : 'unknown'}`,
        e.stdout ? `stdout:\n${e.stdout}` : '',
        e.stderr ? `stderr:\n${e.stderr}` : (e.message ? `error: ${e.message}` : ''),
      ].filter(Boolean);
      return clampCommandOutput(parts.join('\n\n'));
    }
  }

  // --- Session state -------------------------------------------------------

  private resolveSession(
    sessionId: string,
    workspacePath: string | undefined,
    documentContext: DocumentContext | undefined,
  ): SessionState {
    const modelKey = bareGeminiModelKey(
      this.config.model ?? (documentContext as { model?: string } | undefined)?.model,
    );
    const existing = this.sessionStates.get(sessionId);
    if (existing) {
      if (workspacePath) existing.workspacePath = workspacePath;
      if (existing.modelKey !== modelKey) {
        existing.modelKey = modelKey;
        existing.toolLoop.setModelKey(modelKey);
      }
      return existing;
    }
    const state: SessionState = {
      sessionId,
      workspacePath,
      modelKey,
      toolLoop: new AntigravityToolLoopProtocol({ modelKey, server: this.server }),
      abortController: null,
    };
    this.sessionStates.set(sessionId, state);
    return state;
  }

  // --- Static injection (Electron main process, at startup) ----------------

  static setToolExecutor(executor: GeminiToolExecutor | null): void {
    GeminiAntigravityProvider.toolExecutor = executor;
  }

  static setServerConfigLoader(loader: (() => GeminiServerConfig) | null): void {
    GeminiAntigravityProvider.serverConfigLoader = loader;
  }

  /**
   * Phase 2A step 6: Nimbalyst MCP endpoints to expose to a Cascade turn.
   * Electron-specific (port/token live in the Electron main process), so
   * injected the same way `setServerConfigLoader` is -- this package stays
   * platform-agnostic (works in Electron and Capacitor/mobile).
   */
  static setMcpEndpointsLoader(loader: ((workspacePath: string) => McpEndpointInput[]) | null): void {
    GeminiAntigravityProvider.mcpEndpointsLoader = loader;
  }

  // --- Detection and catalog ----------------------------------------------

  static readonly NOT_INSTALLED_MESSAGE =
    'Antigravity is not installed. Install it from https://antigravity.google, '
    + 'sign in once, then try again — Nimbalyst uses that login and stores no key of its own.';

  static readonly NOT_SIGNED_IN_MESSAGE =
    'Antigravity is installed but not signed in. Open Antigravity and sign in to '
    + 'your Google account, then try again.';

  static readonly VERSION_GATE_MESSAGE =
    'Antigravity rejected this build as out of date. Update Antigravity to its '
    + 'latest version and try again. (If you need to keep the current version, '
    + 'set a newer `overrideIdeVersion` on the Gemini provider in ai-settings.)';

  /** True when the Antigravity language server binary is present. */
  static isInstalled(): boolean {
    return AntigravityServerManager.isInstalled();
  }

  /** Path the install is expected at, for the settings panel to show. */
  static installPath(): string {
    return AntigravityServerManager.binaryPath();
  }

  static getDefaultModel(): string {
    return `${GEMINI_ANTIGRAVITY_PROVIDER}:${DEFAULT_GEMINI_MODEL_KEY}`;
  }

  /**
   * The model catalog, discovered from the language server and starting it if
   * needed. Config is applied here as well as in `initialize()`: this static
   * serves the picker, which has no provider instance behind it.
   */
  static async getModels(): Promise<AIModel[]> {
    const server = AntigravityServerManager.shared();
    GeminiAntigravityProvider.applyServerConfig(server);
    const { models, health } = await discoverGeminiCatalog(server);
    reportCatalogHealth(GEMINI_ANTIGRAVITY_PROVIDER, health);
    return models.map((m) => ({
      id: `${GEMINI_ANTIGRAVITY_PROVIDER}:${m.key}`,
      name: m.displayName,
      provider: GEMINI_ANTIGRAVITY_PROVIDER,
    }));
  }

}

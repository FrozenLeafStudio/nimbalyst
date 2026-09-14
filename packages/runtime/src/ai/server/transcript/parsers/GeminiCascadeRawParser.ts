/**
 * Canonical-event parser for the Antigravity Cascade transport (as opposed to
 * `GeminiAntigravityRawParser`, which parses the older text-loop transport's
 * JSON-envelope-in-plain-text rows).
 *
 * Cascade's raw log is the vendor's own typed step JSON (`gemini_coder.Step`),
 * one step per raw row -- unlike the text loop, where Nimbalyst's own tool
 * loop decided the row shape. This parser has no dependency on the cascade
 * RPC client or the provider class; it is a pure function over whatever step
 * JSON ends up persisted to `msg.content`. Its one provider-side import is
 * `cascadeEditSnapshots`, a pure diff-reconstruction module with no transport
 * of its own (same shape as `CodexRawParser` -> `codexEventParser`).
 *
 * Scope: the four typed step variants the step-8 brief names --
 * `CORTEX_STEP_TYPE_LIST_DIRECTORY`, `CORTEX_STEP_TYPE_VIEW_FILE`,
 * `CORTEX_STEP_TYPE_FIND`, `CORTEX_STEP_TYPE_CODE_ACTION` -- confirmed live in
 * `cascade-spike/step3-results.md` (nimbalyst-gemini-cli-provider repo). Every
 * other step type is intentionally unhandled here and returns `[]`, the same
 * "unrecognised row is dropped, not guessed at" posture the sibling text-loop
 * parser takes for corrupt rows. This is a scope choice, not an evidence gap:
 * `CORTEX_STEP_TYPE_USER_INPUT` and `CORTEX_STEP_TYPE_PLANNER_RESPONSE` are
 * also in the probe (`userInput: {items:[{text}], userResponse}` verbatim in
 * the b2/f1 dumps; the planner response's text lives in `response`/`thinking`/
 * `modifiedResponse` per the fabrication-scan paragraph, alongside
 * `stopReason`/`messageId`/`thinkingDuration`) -- mapping them to
 * `user_message`/`assistant_message` is a small follow-up once the turn loop
 * exists, not a blocked unknown. Without it, a replayed cascade transcript
 * shows only tool cards, no prompts or answers.
 *
 * Titles: `CortexStepMetadata.tool_summary` (json `toolSummary`, confirmed as
 * field 30 of `CortexStepMetadata` in the decoded proto descriptors, sibling
 * of `toolCall`) is populated server-side per call -- this is the "titles come
 * from `toolSummary` natively" the plan calls for, so there is no client-side
 * title-generation logic to port from the text-loop path. `toolSummary` maps
 * to the descriptor `description` field, matching the convention
 * `GeminiAntigravityRawParser` already uses (falls back to the tool name when
 * absent/garbage), not `toolDisplayName`, which stays the raw tool name.
 */

import { postEditImageFromDiffLines } from '../../providers/geminiAntigravity/cascadeEditSnapshots';
import type { RawMessage } from '../TranscriptTransformer';
import type {
  IRawMessageParser,
  ParseContext,
  CanonicalEventDescriptor,
  ToolCallStartedDescriptor,
  ToolCallCompletedDescriptor,
} from './IRawMessageParser';

interface ChatToolCall {
  id?: unknown;
  name?: unknown;
  argumentsJson?: unknown;
}

interface CortexStepMetadata {
  toolCall?: ChatToolCall;
  toolSummary?: unknown;
  createdAt?: unknown;
}

interface ListDirectoryResult {
  name?: unknown;
  isDir?: unknown;
  sizeBytes?: unknown;
}

interface UnifiedDiffLine {
  text?: unknown;
  type?: unknown;
}

interface CascadeStep {
  type?: unknown;
  status?: unknown;
  metadata?: CortexStepMetadata;
  listDirectory?: {
    directoryPathUri?: unknown;
    results?: ListDirectoryResult[];
  };
  viewFile?: {
    absolutePathUri?: unknown;
    content?: unknown;
    rawContent?: unknown;
    numLines?: unknown;
    numBytes?: unknown;
  };
  find?: {
    searchDirectory?: unknown;
    pattern?: unknown;
    rawOutput?: unknown;
    truncatedOutput?: unknown;
    totalResults?: unknown;
  };
  codeAction?: {
    actionSpec?: {
      createFile?: { path?: { absoluteUri?: unknown }; overwrite?: unknown };
      command?: { isEdit?: unknown };
    };
    actionResult?: {
      edit?: {
        absoluteUri?: unknown;
        createFile?: unknown;
        diff?: { unifiedDiff?: { lines?: UnifiedDiffLine[] } };
      };
    };
  };
}

const STEP_TYPE_LIST_DIRECTORY = 'CORTEX_STEP_TYPE_LIST_DIRECTORY';
const STEP_TYPE_VIEW_FILE = 'CORTEX_STEP_TYPE_VIEW_FILE';
const STEP_TYPE_FIND = 'CORTEX_STEP_TYPE_FIND';
const STEP_TYPE_CODE_ACTION = 'CORTEX_STEP_TYPE_CODE_ACTION';

export class GeminiCascadeRawParser implements IRawMessageParser {
  async parseMessage(
    msg: RawMessage,
    _context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (msg.hidden) return [];

    let step: CascadeStep;
    try {
      step = JSON.parse(msg.content) as CascadeStep;
    } catch {
      // Not a JSON step -- corrupt row, not a text message. Drop rather than
      // risk showing raw step JSON as conversation text.
      return [];
    }
    if (!step || typeof step !== 'object') return [];

    switch (step.type) {
      case STEP_TYPE_LIST_DIRECTORY:
        return this.parseListDirectory(msg, step);
      case STEP_TYPE_VIEW_FILE:
        return this.parseViewFile(msg, step);
      case STEP_TYPE_FIND:
        return this.parseFind(msg, step);
      case STEP_TYPE_CODE_ACTION:
        return this.parseCodeAction(msg, step);
      default:
        return [];
    }
  }

  private parseListDirectory(msg: RawMessage, step: CascadeStep): CanonicalEventDescriptor[] {
    const payload = step.listDirectory;
    if (!payload) return [];
    const results = Array.isArray(payload.results) ? payload.results : [];
    const resultText = results
      .map((r) => `${readString(r.name) ?? ''}${r.isDir === true ? '/' : ''}`)
      .filter((s) => s.length > 0)
      .join('\n');

    return this.buildToolCallPair(msg, step, {
      defaultToolName: 'list_dir',
      targetFilePath: fileUriToPath(readString(payload.directoryPathUri)),
      arguments: { directoryPathUri: payload.directoryPathUri },
      result: resultText,
    });
  }

  private parseViewFile(msg: RawMessage, step: CascadeStep): CanonicalEventDescriptor[] {
    const payload = step.viewFile;
    if (!payload) return [];
    const resultText = readString(payload.content) ?? readString(payload.rawContent) ?? '';

    return this.buildToolCallPair(msg, step, {
      defaultToolName: 'view_file',
      targetFilePath: fileUriToPath(readString(payload.absolutePathUri)),
      arguments: { absolutePathUri: payload.absolutePathUri },
      result: resultText,
    });
  }

  private parseFind(msg: RawMessage, step: CascadeStep): CanonicalEventDescriptor[] {
    const payload = step.find;
    if (!payload) return [];
    const resultText =
      readString(payload.rawOutput)
      ?? readString(payload.truncatedOutput)
      ?? (typeof payload.totalResults === 'number' ? `${payload.totalResults} result(s)` : '');

    return this.buildToolCallPair(msg, step, {
      defaultToolName: 'find_by_name',
      targetFilePath: fileUriToPath(readString(payload.searchDirectory)),
      arguments: { pattern: payload.pattern, searchDirectory: payload.searchDirectory },
      result: resultText,
    });
  }

  private parseCodeAction(msg: RawMessage, step: CascadeStep): CanonicalEventDescriptor[] {
    const payload = step.codeAction;
    if (!payload) return [];

    const edit = payload.actionResult?.edit;
    const createFilePath = payload.actionSpec?.createFile?.path?.absoluteUri;
    const absoluteUri = readString(edit?.absoluteUri) ?? readString(createFilePath);
    const lines = edit?.diff?.unifiedDiff?.lines;

    // Post-edit reconstruction is shared with the provider-side snapshot
    // builder: the transcript's result text and the history entry's
    // after-content must be the same string, so there is one implementation.
    const resultText = Array.isArray(lines) ? postEditImageFromDiffLines(lines) : '';

    return this.buildToolCallPair(msg, step, {
      defaultToolName: 'code_action',
      targetFilePath: fileUriToPath(absoluteUri),
      arguments: {
        createFile: edit?.createFile ?? Boolean(payload.actionSpec?.createFile),
      },
      result: resultText,
    });
  }

  /**
   * Common started/completed pair for a self-contained action/read step: the
   * whole call and its result arrive on one raw row (there is no separate
   * "call announced" step distinct from "call executed" for these four types),
   * the same one-row-in, two-events-out shape `GeminiAntigravityRawParser`
   * uses for the text loop's tool rows.
   */
  private buildToolCallPair(
    msg: RawMessage,
    step: CascadeStep,
    opts: {
      defaultToolName: string;
      targetFilePath: string | null;
      arguments: Record<string, unknown>;
      result: string;
    },
  ): CanonicalEventDescriptor[] {
    const metadata = step.metadata;
    const toolCall = metadata?.toolCall;
    const toolName = readString(toolCall?.name) ?? opts.defaultToolName;
    const providerToolCallId = readString(toolCall?.id) ?? `cascade-tool-${msg.id}`;
    const args = parseArgumentsJson(toolCall?.argumentsJson) ?? opts.arguments;
    // CORTEX_STEP_STATUS_ERROR (value 7) is a real, non-deprecated
    // CortexStepStatus enum member (descriptors.json), but this probe never
    // observed it live -- it only exercised _DONE and, transiently,
    // _GENERATING, and a cancelled step resolves to _DONE with the tell in
    // stopReason, not status (step3-results.md, cancellation section).
    // Schema-confirmed, not live-confirmed.
    const isError = readString(step.status) === 'CORTEX_STEP_STATUS_ERROR';

    const started: ToolCallStartedDescriptor = {
      type: 'tool_call_started',
      toolName,
      toolDisplayName: toolName,
      description: readDescription(metadata?.toolSummary),
      arguments: args,
      targetFilePath: opts.targetFilePath,
      providerToolCallId,
      createdAt: msg.createdAt,
    };
    const completed: ToolCallCompletedDescriptor = {
      type: 'tool_call_completed',
      providerToolCallId,
      status: isError ? 'error' : 'completed',
      isError,
      result: opts.result,
    };
    return [started, completed];
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * `toolSummary` may be missing on a step written before the field existed, or
 * garbage from a weak model. Anything but a non-empty trimmed string becomes
 * `undefined` so the descriptor falls back to the tool name, mirroring
 * `GeminiAntigravityRawParser.readDescription`.
 */
function readDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseArgumentsJson(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Cascade paths arrive as `file:///C:/...` (Windows, per every URI in
 * step3-results.md) or `file:///home/...` (POSIX) URIs. Stripping the scheme
 * naively leaves a bogus leading-slash drive path (`/C:/...`) on Windows, so
 * that case is detected and the leading slash dropped; the remainder is
 * percent-decoded since a real workspace path (e.g. "Software Dev") encodes
 * spaces as `%20`.
 */
function fileUriToPath(uri: string | null): string | null {
  if (!uri) return null;
  if (!uri.startsWith('file://')) return uri;
  let stripped = uri.slice('file://'.length);
  if (/^\/[A-Za-z]:\//.test(stripped)) {
    stripped = stripped.slice(1);
  }
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}

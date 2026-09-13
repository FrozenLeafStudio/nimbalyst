/**
 * Canonical-event parser for `antigravity-gemini-agent`.
 *
 * Its raw log is not a vendor wire format. The language server streams nothing
 * and reports no events; the host's own tool loop decides what happened, so the
 * rows are Nimbalyst's own minimal record of a turn:
 *
 *   direction 'input',  metadata.role 'user'      -> plain prompt text
 *   direction 'output', metadata.role 'assistant' -> plain answer text
 *   direction 'output', metadata.role 'tool'      -> {"name","args","result"}
 *
 * Until this parser existed, Gemini sessions fell through to
 * `ClaudeCodeRawParser` — where the text rows happened to work via its
 * not-JSON fallbacks, but a tool row parsed as JSON, matched none of the
 * Claude SDK shapes, and produced *nothing*. Tool calls were simply absent from
 * a reloaded Gemini transcript. That was invisible while Gemini could not track
 * files; it is not acceptable now that it can.
 *
 * A tool row is self-contained: one row carries the call and its result
 * together, so this parser emits `tool_call_started` and `tool_call_completed`
 * as a pair from a single message. That differs from every streaming agent,
 * where the two arrive separately.
 *
 * The shape is deliberately unchanged from the years this provider shipped as
 * an extension, so rows written back then parse identically to ones written
 * now. The one addition is `metadata.toolUseId`; rows predating it fall back to
 * a synthetic id derived from the row, which is stable across reloads because
 * the row id is.
 */

import type { RawMessage } from '../TranscriptTransformer';
import type {
  IRawMessageParser,
  ParseContext,
  CanonicalEventDescriptor,
} from './IRawMessageParser';

/** Tool argument keys that name a file, in the Gemini toolset's spelling. */
const FILE_PATH_KEYS = ['path', 'file_path'] as const;

export class GeminiAntigravityRawParser implements IRawMessageParser {
  async parseMessage(
    msg: RawMessage,
    _context: ParseContext,
  ): Promise<CanonicalEventDescriptor[]> {
    if (msg.hidden) return [];
    return msg.direction === 'input' ? this.parseInput(msg) : this.parseOutput(msg);
  }

  private parseInput(msg: RawMessage): CanonicalEventDescriptor[] {
    const text = String(msg.content ?? '').trim();
    if (!text) return [];
    return [{
      type: 'user_message',
      text,
      mode: (msg.metadata?.mode as 'agent' | 'planning' | undefined) ?? 'agent',
      createdAt: msg.createdAt,
    }];
  }

  private parseOutput(msg: RawMessage): CanonicalEventDescriptor[] {
    if (msg.metadata?.role === 'tool') {
      return this.parseToolRow(msg);
    }

    // Assistant text is stored verbatim, not wrapped. A row whose role says
    // 'assistant' is trusted as text even if the model's answer happens to be
    // valid JSON — parsing it would turn an answer that discusses JSON into a
    // silently dropped message.
    const text = String(msg.content ?? '').trim();
    return text ? [{ type: 'assistant_message', text, createdAt: msg.createdAt }] : [];
  }

  private parseToolRow(msg: RawMessage): CanonicalEventDescriptor[] {
    let row: { name?: unknown; args?: unknown; result?: unknown; description?: unknown };
    try {
      row = JSON.parse(msg.content) as typeof row;
    } catch {
      // A tool row that is not JSON is corrupt rather than textual. Emitting it
      // as an assistant message would put raw tool output in the conversation.
      return [];
    }
    const toolName = typeof row.name === 'string' && row.name ? row.name : 'unknown';
    const args = (row.args && typeof row.args === 'object' ? row.args : {}) as Record<string, unknown>;
    const providerToolCallId = typeof msg.metadata?.toolUseId === 'string'
      ? msg.metadata.toolUseId
      : `gemini-tool-${msg.id}`;

    const resultText = typeof row.result === 'string' ? row.result : safeStringify(row.result);
    // The tool loop reports failures as text, not as a status: an unavailable
    // tool and a failed write both come back as a JSON body carrying `isError`.
    // Anything else is a success, including an empty result.
    const isError = looksLikeErrorResult(row.result);

    return [
      {
        type: 'tool_call_started',
        toolName,
        toolDisplayName: toolName,
        description: readDescription(row.description),
        arguments: args,
        targetFilePath: readTargetFilePath(args),
        providerToolCallId,
        createdAt: msg.createdAt,
      },
      {
        type: 'tool_call_completed',
        providerToolCallId,
        status: isError ? 'error' : 'completed',
        isError,
        result: resultText,
      },
    ];
  }
}

function looksLikeErrorResult(result: unknown): boolean {
  if (typeof result === 'string') return false;
  if (!result || typeof result !== 'object') return false;
  return (result as { isError?: unknown }).isError === true;
}

function readTargetFilePath(args: Record<string, unknown>): string | null {
  for (const key of FILE_PATH_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/**
 * A weak model may emit `""`, `null`, or a number for `description`, and rows
 * written before this field existed have no key at all. Anything but a
 * non-empty trimmed string becomes `undefined` so the descriptor falls back
 * to the tool name, never an empty or garbage title.
 */
function readDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

// @vitest-environment node
/**
 * Fixtures below reconstruct the field-level shapes confirmed live in
 * `cascade-spike/step3-results.md` / `descriptors.json` (nimbalyst-gemini-cli-
 * provider repo): typed `listDirectory`/`viewFile`/`find`/`codeAction` steps,
 * `CortexStepMetadata.toolCall`/`toolSummary`, and the `codeAction`
 * `actionSpec`/`actionResult.edit.diff.unifiedDiff.lines[]` shape observed
 * against the live hub (not the older, differently-shaped offline proto
 * decode that step3-results.md explicitly says the live server superseded).
 * The raw JSON dumps in step3-results.md are truncated in the file itself
 * (multi-KB responses cut off mid-blob), so these are reconstructed from its
 * prose analysis and `descriptors.json` field lists, not byte-copied.
 *
 * `source: 'antigravity-cascade'` below is a placeholder for this test only --
 * the real provider/source id and its `selectRawParser` routing belong to
 * whichever turn-loop work wires this parser in.
 */
import { describe, expect, it } from 'vitest';

import { GeminiCascadeRawParser } from '../parsers/GeminiCascadeRawParser';
import type { RawMessage } from '../TranscriptTransformer';
import type { ParseContext } from '../parsers/IRawMessageParser';

const CONTEXT = {} as ParseContext;
const AT = new Date('2026-09-13T20:58:48.000Z');

function raw(content: unknown, overrides: Partial<RawMessage> = {}): RawMessage {
  return {
    id: 1,
    sessionId: 's1',
    source: 'antigravity-cascade',
    direction: 'output',
    content: typeof content === 'string' ? content : JSON.stringify(content),
    createdAt: AT,
    ...overrides,
  };
}

describe('GeminiCascadeRawParser', () => {
  const parser = new GeminiCascadeRawParser();

  it('parses a listDirectory step, title from toolSummary, targetFilePath from the URI', async () => {
    const out = await parser.parseMessage(
      raw({
        type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          toolCall: { id: 'call-1', name: 'list_dir', argumentsJson: '{"DirectoryPath":"cascade-probe"}' },
          toolSummary: 'Listed directory cascade-probe',
        },
        listDirectory: {
          directoryPathUri: 'file:///C:/scratch/cascade-probe',
          results: [
            { name: 'README.md', isDir: false, sizeBytes: '120' },
            { name: 'hello.py', isDir: false, sizeBytes: '42' },
          ],
        },
      }),
      CONTEXT,
    );

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      type: 'tool_call_started',
      toolName: 'list_dir',
      toolDisplayName: 'list_dir',
      description: 'Listed directory cascade-probe',
      targetFilePath: 'C:/scratch/cascade-probe',
      providerToolCallId: 'call-1',
      arguments: { DirectoryPath: 'cascade-probe' },
    });
    expect(out[1]).toMatchObject({
      type: 'tool_call_completed',
      providerToolCallId: 'call-1',
      status: 'completed',
      isError: false,
      result: 'README.md\nhello.py',
    });
  });

  it('decodes a percent-encoded Windows file URI to a plain drive path', async () => {
    const out = await parser.parseMessage(
      raw({
        type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY',
        metadata: { toolCall: { id: 'call-enc', name: 'list_dir' } },
        listDirectory: {
          directoryPathUri: 'file:///C:/Users/steph/Documents/Software%20Dev/Workspace/randomshit',
          results: [],
        },
      }),
      CONTEXT,
    );
    expect(out[0]).toMatchObject({
      targetFilePath: 'C:/Users/steph/Documents/Software Dev/Workspace/randomshit',
    });
  });

  it('parses a viewFile step, result from content', async () => {
    const out = await parser.parseMessage(
      raw({
        type: 'CORTEX_STEP_TYPE_VIEW_FILE',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          toolCall: { id: 'call-2', name: 'view_file' },
          toolSummary: 'Viewed README.md',
        },
        viewFile: {
          absolutePathUri: 'file:///C:/scratch/cascade-probe/README.md',
          startLine: 1,
          endLine: 2,
          content: 'Scratch notes for the Cascade RPC probe.',
          numLines: 1,
        },
      }),
      CONTEXT,
    );

    expect(out[0]).toMatchObject({
      type: 'tool_call_started',
      toolName: 'view_file',
      description: 'Viewed README.md',
      targetFilePath: 'C:/scratch/cascade-probe/README.md',
      providerToolCallId: 'call-2',
    });
    expect(out[1]).toMatchObject({
      type: 'tool_call_completed',
      result: 'Scratch notes for the Cascade RPC probe.',
    });
  });

  it('parses a find step, result from rawOutput', async () => {
    const out = await parser.parseMessage(
      raw({
        type: 'CORTEX_STEP_TYPE_FIND',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          toolCall: { id: 'call-3', name: 'find_by_name' },
          toolSummary: 'Searched for *.py',
        },
        find: {
          searchDirectory: 'file:///C:/scratch/cascade-probe',
          pattern: '*.py',
          totalResults: 1,
          rawOutput: 'hello.py',
        },
      }),
      CONTEXT,
    );

    expect(out[0]).toMatchObject({
      type: 'tool_call_started',
      toolName: 'find_by_name',
      description: 'Searched for *.py',
      providerToolCallId: 'call-3',
    });
    expect(out[1]).toMatchObject({ result: 'hello.py' });
  });

  it('parses a codeAction create step, reconstructing content from insert-only unifiedDiff lines', async () => {
    const out = await parser.parseMessage(
      raw({
        type: 'CORTEX_STEP_TYPE_CODE_ACTION',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          toolCall: { id: 'call-4', name: 'write_to_file' },
          toolSummary: 'Created should-not-exist.txt',
        },
        codeAction: {
          actionSpec: {
            createFile: {
              path: { absoluteUri: 'file:///C:/scratch/cascade-probe/should-not-exist.txt' },
              overwrite: false,
            },
          },
          actionResult: {
            edit: {
              absoluteUri: 'file:///C:/scratch/cascade-probe/should-not-exist.txt',
              createFile: true,
              diff: {
                unifiedDiff: {
                  lines: [
                    { text: 'this should be blocked', type: 'UNIFIED_DIFF_LINE_TYPE_INSERT' },
                  ],
                },
              },
            },
          },
        },
      }),
      CONTEXT,
    );

    expect(out[0]).toMatchObject({
      type: 'tool_call_started',
      toolName: 'write_to_file',
      description: 'Created should-not-exist.txt',
      targetFilePath: 'C:/scratch/cascade-probe/should-not-exist.txt',
      providerToolCallId: 'call-4',
    });
    expect(out[1]).toMatchObject({
      type: 'tool_call_completed',
      result: 'this should be blocked',
    });
  });

  it('parses a codeAction edit step, reconstructing the post-edit image (drops DELETE lines, keeps UNCHANGED + INSERT)', async () => {
    const out = await parser.parseMessage(
      raw({
        type: 'CORTEX_STEP_TYPE_CODE_ACTION',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: {
          toolCall: { id: 'call-5', name: 'replace_file_content' },
          toolSummary: 'Edited notes.txt',
        },
        codeAction: {
          actionSpec: {
            command: { isEdit: true },
          },
          actionResult: {
            edit: {
              absoluteUri: 'file:///C:/scratch/cascade-probe/notes.txt',
              createFile: false,
              diff: {
                unifiedDiff: {
                  lines: [
                    { type: 'UNIFIED_DIFF_LINE_TYPE_UNCHANGED', text: 'Scratch notes for the probe.' },
                    { type: 'UNIFIED_DIFF_LINE_TYPE_DELETE', text: 'This is a disposable file.' },
                    { type: 'UNIFIED_DIFF_LINE_TYPE_INSERT', text: 'This is a temporary file.' },
                  ],
                },
              },
            },
          },
        },
      }),
      CONTEXT,
    );

    expect(out[0]).toMatchObject({
      toolName: 'replace_file_content',
      description: 'Edited notes.txt',
    });
    expect(out[1]).toMatchObject({
      result: 'Scratch notes for the probe.\nThis is a temporary file.',
    });
  });

  it('falls back to the step-type default tool name when metadata.toolCall is absent', async () => {
    const out = await parser.parseMessage(
      raw({
        type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY',
        listDirectory: { directoryPathUri: 'file:///C:/x', results: [] },
      }),
      CONTEXT,
    );
    expect(out[0]).toMatchObject({ toolName: 'list_dir', description: undefined });
    expect(out[0]).toMatchObject({ providerToolCallId: 'cascade-tool-1' });
  });

  it('marks a step with CORTEX_STEP_STATUS_ERROR as an error (schema-confirmed value 7, not observed live in this probe)', async () => {
    const out = await parser.parseMessage(
      raw({
        type: 'CORTEX_STEP_TYPE_VIEW_FILE',
        status: 'CORTEX_STEP_STATUS_ERROR',
        metadata: { toolCall: { id: 'call-6', name: 'view_file' } },
        viewFile: { absolutePathUri: 'file:///C:/missing.txt' },
      }),
      CONTEXT,
    );
    expect(out[1]).toMatchObject({ status: 'error', isError: true });
  });

  it('drops an unrecognised step type rather than guessing at its shape', async () => {
    const out = await parser.parseMessage(
      raw({ type: 'CORTEX_STEP_TYPE_USER_INPUT', userInput: { items: [{ text: 'hi' }] } }),
      CONTEXT,
    );
    expect(out).toEqual([]);
  });

  it('drops a corrupt (non-JSON) row rather than showing it as conversation', async () => {
    const out = await parser.parseMessage(raw('not json at all'), CONTEXT);
    expect(out).toEqual([]);
  });

  it('drops a step whose named payload is missing', async () => {
    const out = await parser.parseMessage(
      raw({ type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY' }),
      CONTEXT,
    );
    expect(out).toEqual([]);
  });
});

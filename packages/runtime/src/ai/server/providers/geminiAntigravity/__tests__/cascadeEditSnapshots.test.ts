// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  buildEditSnapshotFromCascadeToolResult,
  buildEditSnapshotsFromCodeActionStep,
  type CascadeCodeActionStep,
} from '../cascadeEditSnapshots';

// Fixture lines lifted verbatim from cascade-spike/step3-results.md's edit
// probe (g2, replace_file_content on notes.txt).
const EDIT_LINES = [
  { type: 'UNIFIED_DIFF_LINE_TYPE_UNCHANGED', text: 'Scratch notes for the Cascade RPC probe (step 3).' },
  { type: 'UNIFIED_DIFF_LINE_TYPE_UNCHANGED', text: '' },
  {
    type: 'UNIFIED_DIFF_LINE_TYPE_DELETE',
    text: 'This is a disposable file used only to verify that a probe cascade can',
  },
  {
    type: 'UNIFIED_DIFF_LINE_TYPE_INSERT',
    text: 'This is a temporary file used only to verify that a probe cascade can',
  },
  { type: 'UNIFIED_DIFF_LINE_TYPE_UNCHANGED', text: 'read files in this workspace. No real content lives here.' },
  { type: 'UNIFIED_DIFF_LINE_TYPE_UNCHANGED', text: '' },
];

function editStep(lines: typeof EDIT_LINES, createFile?: boolean): CascadeCodeActionStep {
  return {
    type: 'CORTEX_STEP_TYPE_CODE_ACTION',
    codeAction: {
      actionResult: {
        edit: {
          absoluteUri: 'file:///C:/scratch/notes.txt',
          createFile,
          diff: { unifiedDiff: { lines } },
        },
      },
    },
  };
}

describe('buildEditSnapshotsFromCodeActionStep', () => {
  it('reconstructs before/after images from a mixed UNCHANGED/DELETE/INSERT diff', () => {
    const result = buildEditSnapshotsFromCodeActionStep(editStep(EDIT_LINES));
    expect(result).not.toBeNull();
    expect(result!.path).toBe('file:///C:/scratch/notes.txt');
    expect(result!.beforeContent).toBe(
      [
        'Scratch notes for the Cascade RPC probe (step 3).',
        '',
        'This is a disposable file used only to verify that a probe cascade can',
        'read files in this workspace. No real content lives here.',
        '',
      ].join('\n'),
    );
    expect(result!.afterContent).toBe(
      [
        'Scratch notes for the Cascade RPC probe (step 3).',
        '',
        'This is a temporary file used only to verify that a probe cascade can',
        'read files in this workspace. No real content lives here.',
        '',
      ].join('\n'),
    );
  });

  it('drops INSERT (not DELETE) from the before image -- catches an inverted drop rule', () => {
    const result = buildEditSnapshotsFromCodeActionStep(editStep(EDIT_LINES));
    // A buggy implementation that dropped DELETE instead of INSERT for the
    // "before" image would put the *new* wording here instead.
    expect(result!.beforeContent).not.toContain('temporary file');
    expect(result!.beforeContent).toContain('disposable file');
  });

  it('drops DELETE (not INSERT) from the after image -- catches an inverted drop rule', () => {
    const result = buildEditSnapshotsFromCodeActionStep(editStep(EDIT_LINES));
    expect(result!.afterContent).not.toContain('disposable file');
    expect(result!.afterContent).toContain('temporary file');
  });

  it('treats a create (createFile: true, insert-only diff) as beforeContent: null', () => {
    const createLines = [
      { type: 'UNIFIED_DIFF_LINE_TYPE_INSERT', text: 'line one' },
      { type: 'UNIFIED_DIFF_LINE_TYPE_INSERT', text: 'line two' },
    ];
    const result = buildEditSnapshotsFromCodeActionStep(editStep(createLines, true));
    expect(result).not.toBeNull();
    expect(result!.beforeContent).toBeNull();
    expect(result!.afterContent).toBe('line one\nline two');
  });

  it('returns null for a step that is not CORTEX_STEP_TYPE_CODE_ACTION', () => {
    const step: CascadeCodeActionStep = { type: 'CORTEX_STEP_TYPE_USER_INPUT' };
    expect(buildEditSnapshotsFromCodeActionStep(step)).toBeNull();
  });

  it('returns null when the step has no recognizable diff', () => {
    const step: CascadeCodeActionStep = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      codeAction: { actionResult: {} },
    };
    expect(buildEditSnapshotsFromCodeActionStep(step)).toBeNull();
  });
});

describe('buildEditSnapshotFromCascadeToolResult', () => {
  // What AntigravityCascadeProtocol's tool_result event actually carries in
  // `result`: JSON.stringify(step.codeAction) -- the sub-object, not the
  // whole typed step (no `type` field alongside it).
  const codeActionOnly = JSON.stringify(editStep(EDIT_LINES).codeAction);

  it('reconstructs a snapshot from a write_to_file result', () => {
    const result = buildEditSnapshotFromCascadeToolResult('write_to_file', codeActionOnly);
    expect(result).not.toBeNull();
    expect(result!.path).toBe('file:///C:/scratch/notes.txt');
    expect(result!.afterContent).toContain('temporary file');
  });

  it('reconstructs a snapshot from a replace_file_content result', () => {
    const result = buildEditSnapshotFromCascadeToolResult('replace_file_content', codeActionOnly);
    expect(result).not.toBeNull();
  });

  it('returns null for a tool name that is not a recognized write', () => {
    expect(buildEditSnapshotFromCascadeToolResult('list_files', codeActionOnly)).toBeNull();
  });

  it('returns null rather than throwing on malformed JSON', () => {
    expect(buildEditSnapshotFromCascadeToolResult('write_to_file', '{not json')).toBeNull();
  });
});

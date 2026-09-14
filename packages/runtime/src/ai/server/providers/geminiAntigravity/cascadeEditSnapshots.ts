/**
 * cascadeEditSnapshots.
 *
 * Phase 2A step 5 of `gemini-power-parity.md` section 6: reconstruct
 * pre/post-edit file content from a Cascade `codeAction` step's typed
 * unified diff, so a later integration step can feed the same shape
 * `GeminiAntigravityProvider.ts`'s `pendingEditSnapshots` array already uses
 * for the text-loop path (`beforeContent: string | null`, `afterContent:
 * string`, `null` before-content meaning "file did not exist" -- see that
 * file's `drainEditSnapshots`).
 *
 * Shapes below are copied verbatim from the live probes in
 * `cascade-spike/step3-results.md` (2026-09-13, probes d4/g2) -- not
 * re-derived from the proto schema. Confirmed live for both a file create
 * (`write_to_file`, insert-only diff, `createFile: true`) and a file edit
 * (`replace_file_content`, full UNCHANGED/DELETE/INSERT diff), each verified
 * against the file on disk by the probe.
 *
 * Pure functions only -- not wired into the provider or the cascade client
 * here, per plan step 5 scope. The watcher-based fallback path this is meant
 * to supplement lives elsewhere and is untouched by this module.
 */

const LINE_TYPE_DELETE = 'UNIFIED_DIFF_LINE_TYPE_DELETE';
const LINE_TYPE_INSERT = 'UNIFIED_DIFF_LINE_TYPE_INSERT';
// Any line whose type is neither of the above (UNIFIED_DIFF_LINE_TYPE_UNCHANGED,
// per the probe) is context and belongs in both the before and after image.

export interface UnifiedDiffLine {
  text?: string;
  type: string;
}

/**
 * The subset of a Cascade `Step` this module reads. A real step carries far
 * more (`metadata`, `status`, `actionSpec`, ...) -- only the
 * `codeAction.actionResult.edit` path matters for snapshot reconstruction.
 */
export interface CascadeCodeActionStep {
  type?: string;
  codeAction?: {
    actionResult?: {
      edit?: {
        absoluteUri?: string;
        createFile?: boolean;
        diff?: {
          unifiedDiff?: {
            lines?: UnifiedDiffLine[];
          };
        };
      };
    };
  };
}

export interface EditSnapshotResult {
  path: string;
  /** `null` for a file create -- no prior content, distinct from an empty file. */
  beforeContent: string | null;
  afterContent: string;
}

/**
 * Reduce a unified diff's lines to one file image by dropping the lines that
 * belong only to the other side. Takes a structurally-loose line so a caller
 * decoding persisted step JSON of unknown vintage (see
 * `GeminiCascadeRawParser`) can pass its own `unknown`-leafed lines through
 * the same reconstruction the snapshot builder uses -- two implementations of
 * this would silently drift the transcript's result text away from the
 * history entry's after-content.
 */
function linesToText(
  lines: ReadonlyArray<{ text?: unknown; type?: unknown }>,
  dropType: string,
): string {
  return lines
    .filter((line) => line.type !== dropType)
    .map((line) => (typeof line.text === 'string' ? line.text : ''))
    .join('\n');
}

/** The file as it stands AFTER the edit: everything except the deleted lines. */
export function postEditImageFromDiffLines(
  lines: ReadonlyArray<{ text?: unknown; type?: unknown }>,
): string {
  return linesToText(lines, LINE_TYPE_DELETE);
}

/**
 * Reconstruct before/after file content from a single
 * `CORTEX_STEP_TYPE_CODE_ACTION` step's `codeAction.actionResult.edit`.
 * Returns `null` when the step isn't a recognized write shape (wrong step
 * type, or no diff present) -- callers fall back to the watcher path for
 * those, per plan step 5. Never throws.
 *
 * Before image = UNCHANGED + DELETE lines (drop INSERT).
 * After image = UNCHANGED + INSERT lines (drop DELETE).
 *
 * Both probed write tools (`write_to_file`, `replace_file_content`) produced
 * exactly one file's diff per step -- no evidence in the probes of a
 * multi-file `codeAction` -- so this returns a single result, not an array.
 */
export function buildEditSnapshotsFromCodeActionStep(
  step: CascadeCodeActionStep,
): EditSnapshotResult | null {
  if (step.type !== 'CORTEX_STEP_TYPE_CODE_ACTION') return null;
  const edit = step.codeAction?.actionResult?.edit;
  const lines = edit?.diff?.unifiedDiff?.lines;
  if (!edit?.absoluteUri || !Array.isArray(lines)) return null;

  const afterContent = postEditImageFromDiffLines(lines);
  const beforeContent = edit.createFile ? null : linesToText(lines, LINE_TYPE_INSERT);

  return { path: edit.absoluteUri, beforeContent, afterContent };
}

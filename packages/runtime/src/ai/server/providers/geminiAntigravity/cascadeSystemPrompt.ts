/**
 * Nimbalyst's behavioral contract for the Antigravity Cascade transport.
 *
 * Two injection routes, ranked by evidence strength in
 * `cascade-spike/mcp-and-prompt.md` Q2 (nimbalyst-gemini-cli-provider repo):
 *
 * 1. On-disk `GEMINI.md` at the workspace root -- the cascade's directory-based
 *    rules walk (`~/.gemini/antigravity/builtin/skills/agy-customizations/docs/rules.md`:
 *    "The system walks up from the current working directory to the repository
 *    root and loads these files") is confirmed to exist as a mechanism, and the
 *    literal string pair `GEMINI.md`/`AGENTS.md` is present in the installed
 *    binary. Of that pair this module writes `GEMINI.md`, not `AGENTS.md`:
 *    `AGENTS.md` is the cross-tool convention a project is far more likely to
 *    already own for its own purposes (Codex, other agents), while `GEMINI.md`
 *    is Gemini/Antigravity-specific. **Unverified**: no live probe has
 *    confirmed a `GEMINI.md` dropped in a tracked workspace actually surfaces
 *    via `GetAllRules` or measurably changes model behavior -- that requires a
 *    live-hub probe out of scope here. Treat this route as "documented
 *    convention, not confirmed live" until that probe runs.
 * 2. `CustomAgentSpec.promptSectionCustomization.appendPromptSections` -- a
 *    per-cascade, additive alternative reachable on `StartCascadeRequest` /
 *    `SendUserCascadeMessageRequest` without any file write. Also unverified
 *    live (schema confirmed non-deprecated in `descriptors.json`; no probe
 *    confirmed the appended text reaches the model).
 *
 * Neither route is wired into a live cascade turn by this module -- that is
 * the turn-loop's job once it exists. This module only builds the artifacts.
 */

import { promises as fs } from 'fs';
import path from 'path';

/** File Antigravity's rules walk discovers, per the evidence above. */
const CASCADE_RULES_FILE_NAME = 'GEMINI.md';

const SECTION_BEGIN = '<!-- nimbalyst:cascade-contract:begin -->';
const SECTION_END = '<!-- nimbalyst:cascade-contract:end -->';

export interface WriteCascadeSystemPromptResult {
  filePath: string;
  /** False when the file already held this exact section (no disk write performed). */
  written: boolean;
}

function buildSection(promptText: string): string {
  return `${SECTION_BEGIN}\n${promptText.trim()}\n${SECTION_END}`;
}

/**
 * Writes (or idempotently updates) Nimbalyst's contract into `GEMINI.md` at
 * the workspace root, inside a delimited, Nimbalyst-owned section.
 *
 * A user may already have a `GEMINI.md` of their own for this project -- that
 * is ordinary, user-authored content, not something Nimbalyst is entitled to
 * clobber (see `.claude/rules/destructive-data-paths.md`: no destructive
 * write on a heuristic). This function therefore never overwrites content
 * outside its own markers:
 *
 * - No file yet: creates one containing only the marked section.
 * - File exists and already has the markers: replaces only the text between
 *   them, byte-for-byte outside that span untouched. Calling this again with
 *   the same `promptText` is a no-op (`written: false`).
 * - File exists with no markers (foreign/user-authored content): appends the
 *   marked section to the end, leaving every existing byte in place.
 */
export async function writeCascadeSystemPromptFile(
  workspacePath: string,
  promptText: string,
): Promise<WriteCascadeSystemPromptResult> {
  const filePath = path.join(workspacePath, CASCADE_RULES_FILE_NAME);
  const section = buildSection(promptText);

  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  let nextContent: string;
  if (existing === null) {
    nextContent = `${section}\n`;
  } else {
    const beginIdx = existing.indexOf(SECTION_BEGIN);
    const endIdx = existing.indexOf(SECTION_END);
    if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
      const before = existing.slice(0, beginIdx);
      const after = existing.slice(endIdx + SECTION_END.length);
      nextContent = `${before}${section}${after}`;
    } else {
      const separator = existing.length === 0 || existing.endsWith('\n') ? '\n' : '\n\n';
      nextContent = `${existing}${separator}${section}\n`;
    }
  }

  if (existing === nextContent) {
    return { filePath, written: false };
  }

  await fs.mkdir(workspacePath, { recursive: true });
  await fs.writeFile(filePath, nextContent, 'utf8');
  return { filePath, written: true };
}

// ---------------------------------------------------------------------------
// Route 2: per-cascade append-sections request fragment (no file I/O)
// ---------------------------------------------------------------------------

export interface CascadePromptSection {
  title: string;
  content: string;
}

export interface AppendPromptSectionsConfig {
  promptSectionCustomization: {
    appendPromptSections: CascadePromptSection[];
  };
}

/**
 * Builds the `customAgentSpec.promptSectionCustomization.appendPromptSections`
 * fragment -- additive, keeps the built-in agent's own prompt sections intact.
 * Attach the result under `customAgentSpec` on `StartCascadeRequest` or
 * `SendUserCascadeMessageRequest`. Pure request-shape builder; does not call
 * any RPC and has no dependency on the cascade client.
 */
export function buildAppendPromptSectionsConfig(promptText: string): AppendPromptSectionsConfig {
  return {
    promptSectionCustomization: {
      appendPromptSections: [
        { title: 'Nimbalyst', content: promptText },
      ],
    },
  };
}

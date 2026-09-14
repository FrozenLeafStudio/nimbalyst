// @vitest-environment node
/**
 * `GEMINI.md` route is documented convention (installed doc + binary string
 * evidence), not confirmed live -- no probe has shown Antigravity's rules walk
 * actually reads a Nimbalyst-written file. These tests cover the file-writer's
 * own contract only: idempotent section replace, and never clobbering foreign
 * content the user may have authored themselves.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  writeCascadeSystemPromptFile,
  buildAppendPromptSectionsConfig,
} from '../cascadeSystemPrompt';

let workspacePath: string;

beforeEach(() => {
  workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-system-prompt-'));
});

afterEach(() => {
  fs.rmSync(workspacePath, { recursive: true, force: true });
});

describe('writeCascadeSystemPromptFile', () => {
  it('creates GEMINI.md with the marked section on a fresh workspace', async () => {
    const result = await writeCascadeSystemPromptFile(workspacePath, 'Nimbalyst contract text.');

    expect(result.filePath).toBe(path.join(workspacePath, 'GEMINI.md'));
    expect(result.written).toBe(true);
    const content = fs.readFileSync(result.filePath, 'utf8');
    expect(content).toContain('<!-- nimbalyst:cascade-contract:begin -->');
    expect(content).toContain('Nimbalyst contract text.');
    expect(content).toContain('<!-- nimbalyst:cascade-contract:end -->');
  });

  it('is a no-op on a second call with identical text', async () => {
    await writeCascadeSystemPromptFile(workspacePath, 'same text');
    const second = await writeCascadeSystemPromptFile(workspacePath, 'same text');

    expect(second.written).toBe(false);
  });

  it('replaces only the marked section on an update, leaving the rest of an owned file alone', async () => {
    const filePath = path.join(workspacePath, 'GEMINI.md');
    await writeCascadeSystemPromptFile(workspacePath, 'version one');

    // Simulate the user having appended their own notes after Nimbalyst's section.
    fs.appendFileSync(filePath, '\n## My own project notes\nDo not touch this.\n');

    const result = await writeCascadeSystemPromptFile(workspacePath, 'version two');
    expect(result.written).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    expect(content).toContain('version two');
    expect(content).not.toContain('version one');
    expect(content).toContain('## My own project notes');
    expect(content).toContain('Do not touch this.');
  });

  it('never clobbers a pre-existing GEMINI.md the user authored themselves', async () => {
    const filePath = path.join(workspacePath, 'GEMINI.md');
    const userContent = '# My Project Rules\n\nAlways use tabs, never spaces.\n';
    fs.writeFileSync(filePath, userContent, 'utf8');

    const result = await writeCascadeSystemPromptFile(workspacePath, 'Nimbalyst contract text.');
    expect(result.written).toBe(true);

    const content = fs.readFileSync(filePath, 'utf8');
    // The user's original bytes are preserved verbatim, not rewritten or truncated.
    expect(content.startsWith(userContent)).toBe(true);
    expect(content).toContain('Nimbalyst contract text.');
    expect(content).toContain('<!-- nimbalyst:cascade-contract:begin -->');
  });

  it('is idempotent against its own appended section on a foreign file', async () => {
    const filePath = path.join(workspacePath, 'GEMINI.md');
    fs.writeFileSync(filePath, '# My Project Rules\n', 'utf8');

    await writeCascadeSystemPromptFile(workspacePath, 'contract text');
    const second = await writeCascadeSystemPromptFile(workspacePath, 'contract text');

    expect(second.written).toBe(false);
  });
});

describe('buildAppendPromptSectionsConfig', () => {
  it('builds the promptSectionCustomization.appendPromptSections request fragment', () => {
    const config = buildAppendPromptSectionsConfig('Nimbalyst contract text.');

    expect(config).toEqual({
      promptSectionCustomization: {
        appendPromptSections: [
          { title: 'Nimbalyst', content: 'Nimbalyst contract text.' },
        ],
      },
    });
  });

  it('is a pure function with no file I/O', () => {
    const first = buildAppendPromptSectionsConfig('a');
    const second = buildAppendPromptSectionsConfig('a');

    expect(first).toEqual(second);
  });
});

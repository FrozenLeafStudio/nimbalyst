import { describe, it, expect, beforeEach } from 'vitest';
import { TranscriptWriter } from '../TranscriptWriter';
import { TranscriptProjector } from '../TranscriptProjector';
import type { TranscriptViewMessage } from '../TranscriptProjector';
import type { ITranscriptEventStore } from '../types';
import { createMockStore } from './helpers/createMockStore';
import { TranscriptTransformer } from '../TranscriptTransformer';
import type { IRawMessageStore, RawMessage, ISessionMetadataStore } from '../TranscriptTransformer';

// ---------------------------------------------------------------------------
// Helper: project canonical events into view messages
// ---------------------------------------------------------------------------

async function projectSession(store: ITranscriptEventStore, sessionId: string) {
  const events = await store.getSessionEvents(sessionId);
  const viewModel = TranscriptProjector.project(events);
  return { events, messages: viewModel.messages };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Canonical Read Path Integration', () => {
  let store: ITranscriptEventStore;
  let writer: TranscriptWriter;
  const SESSION = 'test-session';

  beforeEach(() => {
    store = createMockStore();
    writer = new TranscriptWriter(store, 'claude-code');
  });

  describe('simple conversation', () => {
    it('user message followed by assistant response produces correct view messages', async () => {
      await writer.appendUserMessage(SESSION, 'What does this function do?');
      await writer.appendAssistantMessage(SESSION, 'It calculates the factorial of a number.');

      const { messages } = await projectSession(store, SESSION);

      expect(messages).toHaveLength(2);

      expect(messages[0].type).toBe('user_message');
      expect(messages[0].text).toBe('What does this function do?');

      expect(messages[1].type).toBe('assistant_message');
      expect(messages[1].text).toBe('It calculates the factorial of a number.');
    });

    it('preserves mode on messages', async () => {
      await writer.appendUserMessage(SESSION, 'Plan the refactoring', { mode: 'planning' });
      await writer.appendAssistantMessage(SESSION, 'Here is my plan', { mode: 'planning' });

      const { messages } = await projectSession(store, SESSION);

      expect(messages[0].mode).toBe('planning');
      expect(messages[1].mode).toBe('planning');
    });
  });

  describe('tool call lifecycle', () => {
    it('createToolCall then updateToolCall produces a complete tool_call view message', async () => {
      await writer.appendUserMessage(SESSION, 'Read the config file');

      const toolEvent = await writer.createToolCall(SESSION, {
        toolName: 'Read',
        toolDisplayName: 'Read File',
        description: 'Reading config.ts',
        arguments: { file_path: '/src/config.ts' },
        targetFilePath: '/src/config.ts',
        providerToolCallId: 'tc_001',
      });

      await writer.updateToolCall(toolEvent.id, {
        status: 'completed',
        result: 'export const config = { port: 3000 };',
        durationMs: 50,
      });

      await writer.appendAssistantMessage(SESSION, 'The config exports a port setting.');

      const { messages } = await projectSession(store, SESSION);

      expect(messages).toHaveLength(3);

      // User message
      expect(messages[0].type).toBe('user_message');

      // Tool call
      const toolMsg = messages[1];
      expect(toolMsg.type).toBe('tool_call');
      expect(toolMsg.toolCall).toBeDefined();
      expect(toolMsg.toolCall!.toolName).toBe('Read');
      expect(toolMsg.toolCall!.providerToolCallId).toBe('tc_001');
      expect(toolMsg.toolCall!.arguments).toEqual({ file_path: '/src/config.ts' });
      expect(toolMsg.toolCall!.result).toBe('export const config = { port: 3000 };');
      expect(toolMsg.toolCall!.targetFilePath).toBe('/src/config.ts');

      // Assistant response
      expect(messages[2].type).toBe('assistant_message');
    });

    it('tool call with progress attaches progress data', async () => {
      const toolEvent = await writer.createToolCall(SESSION, {
        toolName: 'Bash',
        toolDisplayName: 'Bash',
        arguments: { command: 'npm run build' },
        providerToolCallId: 'tc_002',
      });

      await writer.appendToolProgress(SESSION, {
        parentEventId: toolEvent.id,
        toolName: 'Bash',
        elapsedSeconds: 5,
        progressContent: 'Compiling...',
      });

      await writer.appendToolProgress(SESSION, {
        parentEventId: toolEvent.id,
        toolName: 'Bash',
        elapsedSeconds: 15,
        progressContent: 'Linking...',
      });

      await writer.updateToolCall(toolEvent.id, {
        status: 'completed',
        result: 'Build succeeded',
        durationMs: 20000,
      });

      const { messages } = await projectSession(store, SESSION);

      expect(messages).toHaveLength(1);
      const tc = messages[0].toolCall!;
      expect(tc.progress).toHaveLength(2);
      expect(tc.progress[1].elapsedSeconds).toBe(15);
    });

    it('tool call with error status sets isError', async () => {
      const toolEvent = await writer.createToolCall(SESSION, {
        toolName: 'Bash',
        toolDisplayName: 'Bash',
        arguments: { command: 'exit 1' },
      });

      await writer.updateToolCall(toolEvent.id, {
        status: 'error',
        result: 'Command failed',
        isError: true,
        exitCode: 1,
      });

      const { messages } = await projectSession(store, SESSION);

      expect(messages[0].toolCall!.isError).toBe(true);
      expect(messages[0].toolCall!.exitCode).toBe(1);
    });
  });

  describe('interactive prompt lifecycle', () => {
    it('permission request produces correct interactive prompt data', async () => {
      const promptEvent = await writer.createInteractivePrompt(SESSION, {
        promptType: 'permission_request',
        requestId: 'perm-1',
        status: 'pending',
        toolName: 'Bash',
        rawCommand: 'git push origin main',
        pattern: 'Bash(git:*)',
        patternDisplayName: 'git commands',
        isDestructive: false,
        warnings: [],
      });

      await writer.updateInteractivePrompt(promptEvent.id, {
        status: 'resolved',
        decision: 'allow',
        scope: 'session',
      } as any);

      const { messages } = await projectSession(store, SESSION);

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('interactive_prompt');
      expect(messages[0].interactivePrompt).toBeDefined();
      expect(messages[0].interactivePrompt!.requestId).toBe('perm-1');
      expect((messages[0].interactivePrompt as any).decision).toBe('allow');
      expect((messages[0].interactivePrompt as any).scope).toBe('session');
    });

    it('ask user question produces correct data', async () => {
      const promptEvent = await writer.createInteractivePrompt(SESSION, {
        promptType: 'ask_user_question',
        requestId: 'ask-1',
        status: 'pending',
        questions: [{ question: 'Which file?', header: 'File selection' }],
      });

      await writer.updateInteractivePrompt(promptEvent.id, {
        status: 'resolved',
        answers: { '0': 'src/index.ts' },
      } as any);

      const { messages } = await projectSession(store, SESSION);

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('interactive_prompt');
      expect((messages[0].interactivePrompt as any).answers).toEqual({ '0': 'src/index.ts' });
    });

    it('git commit proposal produces correct data', async () => {
      const promptEvent = await writer.createInteractivePrompt(SESSION, {
        promptType: 'git_commit_proposal',
        requestId: 'commit-1',
        status: 'pending',
        commitMessage: 'fix: resolve auth bug',
        stagedFiles: ['src/auth.ts'],
      });

      await writer.updateInteractivePrompt(promptEvent.id, {
        status: 'resolved',
        decision: 'committed',
        commitSha: 'abc123',
      } as any);

      const { messages } = await projectSession(store, SESSION);

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('interactive_prompt');
      expect((messages[0].interactivePrompt as any).decision).toBe('committed');
      expect((messages[0].interactivePrompt as any).commitSha).toBe('abc123');
    });
  });

  describe('subagent with children', () => {
    it('creates nested structure with child events', async () => {
      await writer.appendUserMessage(SESSION, 'Find all test files');

      const subagentEvent = await writer.createSubagent(SESSION, {
        subagentId: 'agent-1',
        agentType: 'Explore',
        teammateName: 'explorer',
        color: 'blue',
        prompt: 'Find test files in the project',
      });

      // Child tool call within subagent
      await writer.createToolCall(SESSION, {
        toolName: 'Glob',
        toolDisplayName: 'Glob',
        arguments: { pattern: '**/*.test.ts' },
        providerToolCallId: 'child-tc-1',
        subagentId: 'agent-1',
      });

      await writer.updateSubagent(subagentEvent.id, {
        status: 'completed',
        resultSummary: 'Found 12 test files',
        toolCallCount: 1,
        durationMs: 3000,
      });

      await writer.appendAssistantMessage(SESSION, 'The subagent found 12 test files.');

      const { messages } = await projectSession(store, SESSION);

      // User, subagent, assistant
      expect(messages).toHaveLength(3);

      expect(messages[0].type).toBe('user_message');

      // Subagent message
      const subMsg = messages[1];
      expect(subMsg.type).toBe('subagent');
      expect(subMsg.subagent).toBeDefined();
      expect(subMsg.subagent!.agentType).toBe('Explore');
      expect(subMsg.subagent!.teammateName).toBe('explorer');
      expect(subMsg.subagent!.resultSummary).toBe('Found 12 test files');

      // Child tool calls nested in subagent
      expect(subMsg.subagent!.childEvents).toHaveLength(1);
      expect(subMsg.subagent!.childEvents[0].type).toBe('tool_call');
      expect(subMsg.subagent!.childEvents[0].toolCall?.toolName).toBe('Glob');

      expect(messages[2].type).toBe('assistant_message');
    });
  });

  describe('mixed conversation', () => {
    it('interleaves user, assistant, tools, prompts, and subagents correctly', async () => {
      // User starts
      await writer.appendUserMessage(SESSION, 'Help me refactor this module');

      // Assistant reads a file
      const readTool = await writer.createToolCall(SESSION, {
        toolName: 'Read',
        toolDisplayName: 'Read',
        arguments: { file_path: '/src/module.ts' },
        providerToolCallId: 'tc-read',
      });
      await writer.updateToolCall(readTool.id, {
        status: 'completed',
        result: 'module code here',
      });

      // Assistant explains
      await writer.appendAssistantMessage(SESSION, 'I see the issue. Let me fix it.');

      // Permission prompt
      const permEvent = await writer.createInteractivePrompt(SESSION, {
        promptType: 'permission_request',
        requestId: 'perm-fix',
        status: 'pending',
        toolName: 'Edit',
        rawCommand: 'edit /src/module.ts',
        pattern: 'Edit(*)',
        patternDisplayName: 'Edit files',
        isDestructive: false,
        warnings: [],
      });
      await writer.updateInteractivePrompt(permEvent.id, {
        status: 'resolved',
        decision: 'allow',
        scope: 'once',
      } as any);

      // Edit tool
      const editTool = await writer.createToolCall(SESSION, {
        toolName: 'Edit',
        toolDisplayName: 'Edit',
        arguments: { file_path: '/src/module.ts', old_string: 'old', new_string: 'new' },
        providerToolCallId: 'tc-edit',
      });
      await writer.updateToolCall(editTool.id, {
        status: 'completed',
        result: 'File edited',
      });

      // Subagent for verification
      const subEvent = await writer.createSubagent(SESSION, {
        subagentId: 'verify-agent',
        agentType: 'general-purpose',
        prompt: 'Verify the changes',
      });
      await writer.updateSubagent(subEvent.id, {
        status: 'completed',
        resultSummary: 'All tests pass',
      });

      // System message
      await writer.appendSystemMessage(SESSION, 'Session saved');

      // Final assistant message
      await writer.appendAssistantMessage(SESSION, 'The refactoring is complete.');

      const { messages } = await projectSession(store, SESSION);

      const types = messages.map((m) => m.type);
      expect(types).toEqual([
        'user_message',
        'tool_call',
        'assistant_message',
        'interactive_prompt',
        'tool_call',
        'subagent',
        'system_message',
        'assistant_message',
      ]);

      // Verify specific messages
      expect(messages[0].text).toBe('Help me refactor this module');
      expect(messages[1].toolCall!.toolName).toBe('Read');
      expect(messages[2].text).toBe('I see the issue. Let me fix it.');
      expect(messages[3].interactivePrompt!.promptType).toBe('permission_request');
      expect(messages[4].toolCall!.toolName).toBe('Edit');
      expect(messages[5].subagent!.agentType).toBe('general-purpose');
      expect(messages[6].systemMessage!.systemType).toBe('status');
      expect(messages[7].text).toBe('The refactoring is complete.');
    });
  });

  describe('turn ended data', () => {
    it('turn_ended events are filtered from projected view model (metadata-only)', async () => {
      await writer.appendUserMessage(SESSION, 'Hello');
      await writer.appendAssistantMessage(SESSION, 'Hi there');

      await writer.recordTurnEnded(SESSION, {
        contextFill: {
          inputTokens: 500,
          cacheReadInputTokens: 200,
          cacheCreationInputTokens: 100,
          outputTokens: 150,
          totalContextTokens: 950,
        },
        contextWindow: 200000,
        cumulativeUsage: {
          inputTokens: 500,
          outputTokens: 150,
          cacheReadInputTokens: 200,
          cacheCreationInputTokens: 100,
          costUSD: 0.02,
          webSearchRequests: 0,
        },
      });

      const { events, messages } = await projectSession(store, SESSION);

      // turn_ended is stored in DB but filtered from the projected view model
      // (it has no renderable content and would create empty bubbles)
      expect(events.some(e => e.eventType === 'turn_ended')).toBe(true);
      expect(messages.find(m => m.type === 'turn_ended')).toBeUndefined();
      expect(messages).toHaveLength(2); // only user + assistant
    });
  });

  describe('empty session', () => {
    it('produces empty message list', async () => {
      const { events, messages } = await projectSession(store, SESSION);

      expect(events).toHaveLength(0);
      expect(messages).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Gemini end-to-end: raw row -> parser -> processDescriptor -> writer ->
// projector -> view-model
// ---------------------------------------------------------------------------
//
// T1 (descriptor -> ToolCallPayload) and T2 (raw row -> descriptor) each have
// their own tests pinning one link of the chain in isolation. Neither proves
// the whole chain holds together. This drives an actual raw
// `ai_agent_messages` row through `TranscriptTransformer` -- the single
// production entry point from raw messages to canonical events, used both
// for the first load of a session and for every reload -- and then through
// `TranscriptProjector` into the exact view-model shape a React component
// receives, asserting `description` reaches the far end unchanged.
//
// Minimal local mocks: this file's `createMockStore` already covers
// `ITranscriptEventStore`; only the raw-message and session-metadata stores
// `TranscriptTransformer` also depends on are missing, so they're added here
// rather than importing the larger mock set from `TranscriptTransformer.test.ts`.
function createMockRawStore(messages: RawMessage[]): IRawMessageStore {
  return {
    async getMessages(sessionId, afterId) {
      return messages
        .filter((m) => m.sessionId === sessionId && (afterId == null || m.id > afterId))
        .sort((a, b) => a.id - b.id);
    },
  };
}

function createMockMetadataStore(): ISessionMetadataStore {
  const statuses = new Map<
    string,
    {
      transformVersion: number | null;
      lastRawMessageId: number | null;
      lastTransformedAt: Date | null;
      transformStatus: 'pending' | 'complete' | 'error' | null;
    }
  >();

  return {
    async getTransformStatus(sessionId) {
      return (
        statuses.get(sessionId) ?? {
          transformVersion: null,
          lastRawMessageId: null,
          lastTransformedAt: null,
          transformStatus: null,
        }
      );
    },
    async updateTransformStatus(sessionId, update) {
      statuses.set(sessionId, update);
    },
  };
}

describe('Gemini end-to-end: raw row -> parser -> processDescriptor -> writer -> projector -> view-model', () => {
  const SESSION_ID = 'gemini-e2e-session';
  const PROVIDER = 'antigravity-gemini-agent';

  function geminiToolRow(id: number, content: string): RawMessage {
    return {
      id,
      sessionId: SESSION_ID,
      source: PROVIDER,
      direction: 'output',
      content,
      createdAt: new Date('2026-09-13T00:00:00.000Z'),
      metadata: { role: 'tool', toolUseId: `agy-e2e-${id}` },
    };
  }

  async function loadSession(rawStore: IRawMessageStore, transcriptStore: ITranscriptEventStore) {
    const transformer = new TranscriptTransformer(rawStore, transcriptStore, createMockMetadataStore());
    await transformer.ensureUpToDate(SESSION_ID, PROVIDER);
    const events = await transcriptStore.getSessionEvents(SESSION_ID);
    return TranscriptProjector.project(events).messages;
  }

  it('a description on the raw row survives to the final view-model unchanged', async () => {
    const row = geminiToolRow(
      1,
      JSON.stringify({
        name: 'list_files',
        args: { path: '~/.gemini/scratch' },
        result: 'a.ts\nb.ts',
        description: 'List scratch directory',
      }),
    );
    const rawStore = createMockRawStore([row]);
    const transcriptStore = createMockStore();

    const messages = await loadSession(rawStore, transcriptStore);

    const toolMsg = messages.find((m) => m.type === 'tool_call');
    expect(toolMsg?.toolCall?.toolName).toBe('list_files');
    expect(toolMsg?.toolCall?.description).toBe('List scratch directory');
  });

  it('a raw row with no description produces a view-model description of null', async () => {
    const row = geminiToolRow(
      2,
      JSON.stringify({
        name: 'list_files',
        args: { path: '~/.gemini/scratch' },
        result: 'a.ts\nb.ts',
        // No `description` key at all -- the pre-feature row shape.
      }),
    );
    const rawStore = createMockRawStore([row]);
    const transcriptStore = createMockStore();

    const messages = await loadSession(rawStore, transcriptStore);

    const toolMsg = messages.find((m) => m.type === 'tool_call');
    expect(toolMsg?.toolCall?.toolName).toBe('list_files');
    expect(toolMsg?.toolCall?.description).toBeNull();
  });

  it('a description survives a simulated reload (full reparse from the raw row)', async () => {
    // Canonical events are rebuilt from the raw log, not cached across loads.
    // `forceReparseSession` is the production entry point for exactly this --
    // it wipes a session's canonical events and re-runs the parser over the
    // raw log from scratch, which is what a reload does for any session
    // whose transform version doesn't match the current one.
    const row = geminiToolRow(
      3,
      JSON.stringify({
        name: 'list_files',
        args: { path: '~/.gemini/scratch' },
        result: 'a.ts\nb.ts',
        description: 'List scratch directory',
      }),
    );
    const rawStore = createMockRawStore([row]);
    const transcriptStore = createMockStore();
    const transformer = new TranscriptTransformer(rawStore, transcriptStore, createMockMetadataStore());

    await transformer.ensureUpToDate(SESSION_ID, PROVIDER);
    const firstLoad = TranscriptProjector.project(await transcriptStore.getSessionEvents(SESSION_ID)).messages;
    expect(firstLoad.find((m) => m.type === 'tool_call')?.toolCall?.description).toBe('List scratch directory');

    await transformer.forceReparseSession(SESSION_ID, PROVIDER);
    const reloaded = TranscriptProjector.project(await transcriptStore.getSessionEvents(SESSION_ID)).messages;
    expect(reloaded.find((m) => m.type === 'tool_call')?.toolCall?.description).toBe('List scratch directory');
  });
});

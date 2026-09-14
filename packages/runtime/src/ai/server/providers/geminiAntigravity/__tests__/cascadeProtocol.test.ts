// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  AntigravityCascadeProtocol,
  isCascadeTurnTerminal,
  mapCascadeStepToEvents,
  STOP_REASON_CLIENT_STREAM_ERROR,
  type CascadeProtocolEvent,
} from '../AntigravityCascadeProtocol';
import type { AntigravityCascadeClient, CascadeStep, GetCascadeTrajectoryStepsResult } from '../AntigravityCascadeClient';

type FakeClient = {
  getCascadeTrajectorySteps: ReturnType<typeof vi.fn>;
  sendUserCascadeMessage: ReturnType<typeof vi.fn>;
};

function fakeClient(): FakeClient {
  return {
    getCascadeTrajectorySteps: vi.fn(),
    sendUserCascadeMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function client(fake: FakeClient): AntigravityCascadeClient {
  return fake as unknown as AntigravityCascadeClient;
}

async function collect(gen: AsyncGenerator<CascadeProtocolEvent>): Promise<CascadeProtocolEvent[]> {
  const out: CascadeProtocolEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const terminalPlannerResponse: CascadeStep = {
  type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
  status: 'CORTEX_STEP_STATUS_DONE',
  plannerResponse: { response: 'All done.', toolCalls: [] },
};

describe('mapCascadeStepToEvents -- typed step mapping', () => {
  it('emits a tool_call announce for each toolCalls[] entry on a planner response, with no description yet', () => {
    // A tool_call announce carries no title: the confirmed-live source for
    // the title is the RESULT step's `metadata.toolSummary` (see the
    // tool_result/tool_error tests below), not anything inside the call's
    // own arguments -- a literal `toolSummary` key inside `argumentsJson`
    // here is incidental tool-argument data, not a title, and must NOT be
    // read as one.
    const step: CascadeStep = {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: {
        toolCalls: [
          { id: 'call_1', name: 'list_dir', argumentsJson: '{"DirectoryPath":".","toolSummary":"List files"}' },
        ],
      },
    };
    const events = mapCascadeStepToEvents(step);
    expect(events).toEqual([
      { type: 'tool_call', id: 'call_1', name: 'list_dir', args: { DirectoryPath: '.', toolSummary: 'List files' } },
    ]);
    expect(events[0]).not.toHaveProperty('description');
  });

  it('emits tool_error, not tool_call, when the server flags invalid tool-call JSON', () => {
    const step: CascadeStep = {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: { toolCalls: [{ id: 'call_1', name: 'list_dir', invalidJsonErr: 'bad json' }] },
    };
    expect(mapCascadeStepToEvents(step)).toEqual([
      { type: 'tool_error', id: 'call_1', name: 'list_dir', error: 'bad json' },
    ]);
  });

  it('maps a DONE listDirectory step to a tool_result keyed on metadata.toolCall.id', () => {
    const step: CascadeStep = {
      type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { toolCall: { id: 'call_1', name: 'list_dir' } },
      listDirectory: { directoryPathUri: 'file:///proj', results: [{ name: 'a.txt', sizeBytes: 10 }] },
    };
    expect(mapCascadeStepToEvents(step)).toEqual([
      {
        type: 'tool_result',
        id: 'call_1',
        name: 'list_dir',
        result: JSON.stringify({ directoryPathUri: 'file:///proj', results: [{ name: 'a.txt', sizeBytes: 10 }] }),
      },
    ]);
  });

  it('sources the tool_result title from metadata.toolSummary, a sibling of metadata.toolCall', () => {
    // The confirmed-live location for the title (step3-results.md), NOT
    // anything inside the announcing tool call's own arguments -- regression
    // coverage for a bug where this read from `argumentsJson.toolSummary`
    // instead, which is a different, unrelated field.
    const step: CascadeStep = {
      type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { toolCall: { id: 'call_1', name: 'list_dir' }, toolSummary: 'Listed project files' },
      listDirectory: {},
    };
    expect(mapCascadeStepToEvents(step)).toEqual([
      { type: 'tool_result', id: 'call_1', name: 'list_dir', result: '{}', description: 'Listed project files' },
    ]);
  });

  it('falls back to metadata.toolAction when toolSummary is absent, on both tool_result and tool_error', () => {
    const doneStep: CascadeStep = {
      type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { toolCall: { id: 'call_1', name: 'list_dir' }, toolAction: 'list_directory' },
      listDirectory: {},
    };
    expect(mapCascadeStepToEvents(doneStep)[0]).toMatchObject({ description: 'list_directory' });

    const erroredStep: CascadeStep = {
      type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY',
      status: 'CORTEX_STEP_STATUS_ERROR',
      metadata: { toolCall: { id: 'call_2', name: 'list_dir' }, toolAction: 'list_directory' },
      error: { shortError: 'boom' },
    };
    expect(mapCascadeStepToEvents(erroredStep)[0]).toMatchObject({ description: 'list_directory' });
  });

  it('maps a DONE codeAction step, carrying the raw payload for a later snapshot builder', () => {
    const codeAction = {
      actionSpec: { createFile: { instruction: 'x', path: { absoluteUri: 'file:///proj/a.txt' }, overwrite: true } },
      actionResult: {
        edit: {
          diff: { unifiedDiff: { lines: [{ text: 'hello', type: 'UNIFIED_DIFF_LINE_TYPE_INSERT' }] } },
          absoluteUri: 'file:///proj/a.txt',
          createFile: true,
        },
      },
    };
    const step: CascadeStep = {
      type: 'CORTEX_STEP_TYPE_CODE_ACTION',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { toolCall: { id: 'call_2', name: 'write_to_file' } },
      codeAction,
    };
    expect(mapCascadeStepToEvents(step)).toEqual([
      { type: 'tool_result', id: 'call_2', name: 'write_to_file', result: JSON.stringify(codeAction) },
    ]);
  });

  it('falls back to generic.result.result for an untyped step (documented, not live-observed)', () => {
    const step: CascadeStep = {
      type: 'CORTEX_STEP_TYPE_GENERIC',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { toolCall: { id: 'call_3', name: 'run_command' } },
      generic: { result: { result: 'exit code 0' } },
    };
    expect(mapCascadeStepToEvents(step)).toEqual([
      { type: 'tool_result', id: 'call_3', name: 'run_command', result: 'exit code 0' },
    ]);
  });

  it('maps an ERROR-status result step to tool_error using Step.error, not generic.result', () => {
    const step: CascadeStep = {
      type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY',
      status: 'CORTEX_STEP_STATUS_ERROR',
      metadata: { toolCall: { id: 'call_4', name: 'list_dir' } },
      error: { userErrorMessage: 'permission denied' },
    };
    expect(mapCascadeStepToEvents(step)).toEqual([
      { type: 'tool_error', id: 'call_4', name: 'list_dir', error: 'permission denied' },
    ]);
  });

  it('drops USER_INPUT/SYSTEM_MESSAGE steps -- they are the host input echoed back', () => {
    expect(mapCascadeStepToEvents({ type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' })).toEqual([]);
    expect(mapCascadeStepToEvents({ type: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE', status: 'CORTEX_STEP_STATUS_DONE' })).toEqual([]);
  });

  it('surfaces an ERROR_MESSAGE step only when shouldShowUser is set', () => {
    const shown: CascadeStep = {
      type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
      status: 'CORTEX_STEP_STATUS_DONE',
      errorMessage: { shouldShowUser: true, error: { userErrorMessage: 'boom' } },
    };
    expect(mapCascadeStepToEvents(shown)).toEqual([{ type: 'error', error: 'boom' }]);

    const modelOnly: CascadeStep = {
      type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
      status: 'CORTEX_STEP_STATUS_DONE',
      errorMessage: { shouldShowModel: true },
    };
    expect(mapCascadeStepToEvents(modelOnly)).toEqual([]);
  });
});

describe('isCascadeTurnTerminal -- terminal-signal detection', () => {
  it('is terminal for a planner response with no tool calls', () => {
    expect(isCascadeTurnTerminal(terminalPlannerResponse)).toBe(true);
  });

  // Decision point: a planner response that is still announcing a tool call
  // (non-empty toolCalls) must NOT be treated as the end of the turn -- more
  // steps (the tool's result, then another planner response) are still coming.
  it('is NOT terminal for a planner response that still has pending tool calls', () => {
    const step: CascadeStep = {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: { toolCalls: [{ id: 'call_1', name: 'list_dir', argumentsJson: '{}' }] },
    };
    expect(isCascadeTurnTerminal(step)).toBe(false);
  });

  it('is NOT terminal for a non-planner-response step, even if DONE', () => {
    expect(
      isCascadeTurnTerminal({
        type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY',
        status: 'CORTEX_STEP_STATUS_DONE',
        metadata: { toolCall: { id: 'call_1', name: 'list_dir' } },
      }),
    ).toBe(false);
  });

  it('is terminal when stopReason signals a cancelled generation, even with pending tool calls', () => {
    const step: CascadeStep = {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: {
        stopReason: STOP_REASON_CLIENT_STREAM_ERROR,
        toolCalls: [{ id: 'call_1', name: 'list_dir', argumentsJson: '{}' }],
      },
    };
    expect(isCascadeTurnTerminal(step)).toBe(true);
  });
});

describe('AntigravityCascadeProtocol.run -- polling loop', () => {
  it('sends blocking:false by default, and polls until a terminal planner response', async () => {
    const fake = fakeClient();
    fake.getCascadeTrajectorySteps
      .mockResolvedValueOnce({ steps: [] } satisfies GetCascadeTrajectoryStepsResult) // baseline capture
      .mockResolvedValueOnce({ steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_GENERATING' }] })
      .mockResolvedValueOnce({ steps: [terminalPlannerResponse] });

    const protocol = new AntigravityCascadeProtocol({ cascadeClient: client(fake), pollIntervalMs: 0 });
    const events = await collect(
      protocol.run({ cascadeId: 'c1', modelKeyOrEnum: 'MODEL_PLACEHOLDER_M318', userMessage: 'hi' }),
    );

    expect(fake.sendUserCascadeMessage).toHaveBeenCalledWith(
      expect.objectContaining({ cascadeId: 'c1', blocking: false }),
      expect.any(Number),
      undefined,
    );
    // 3 fetches: baseline, one GENERATING poll (no progress), one DONE poll.
    expect(fake.getCascadeTrajectorySteps).toHaveBeenCalledTimes(3);
    expect(events).toEqual([{ type: 'text', content: 'All done.' }, { type: 'complete' }]);
  });

  it('sends blocking:true when constructed with the blocking flag', async () => {
    const fake = fakeClient();
    fake.getCascadeTrajectorySteps
      .mockResolvedValueOnce({ steps: [] })
      .mockResolvedValueOnce({ steps: [terminalPlannerResponse] });

    const protocol = new AntigravityCascadeProtocol({ cascadeClient: client(fake), pollIntervalMs: 0, blocking: true });
    await collect(protocol.run({ cascadeId: 'c1', modelKeyOrEnum: 'MODEL_PLACEHOLDER_M318', userMessage: 'hi' }));

    expect(fake.sendUserCascadeMessage).toHaveBeenCalledWith(
      expect.objectContaining({ blocking: true }),
      expect.any(Number),
      undefined,
    );
  });

  it('captures the baseline step count as a cursor so a resumed cascade\'s prior turn is not re-emitted', async () => {
    const fake = fakeClient();
    fake.getCascadeTrajectorySteps
      .mockResolvedValueOnce({ steps: [{ type: 'CORTEX_STEP_TYPE_USER_INPUT' }, terminalPlannerResponse] }) // baseline: 2 prior steps
      .mockResolvedValueOnce({ steps: [terminalPlannerResponse] }); // this turn's own step, offset 2

    const protocol = new AntigravityCascadeProtocol({ cascadeClient: client(fake), pollIntervalMs: 0 });
    await collect(protocol.run({ cascadeId: 'c1', modelKeyOrEnum: 'MODEL_PLACEHOLDER_M318', userMessage: 'hi' }));

    expect(fake.getCascadeTrajectorySteps).toHaveBeenNthCalledWith(2, 'c1', 2, undefined, undefined);
  });

  it('announces a tool call, then resolves it once the matching result step arrives', async () => {
    const fake = fakeClient();
    const announce: CascadeStep = {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_DONE',
      plannerResponse: { toolCalls: [{ id: 'call_1', name: 'list_dir', argumentsJson: '{"DirectoryPath":"."}' }] },
    };
    const result: CascadeStep = {
      type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY',
      status: 'CORTEX_STEP_STATUS_DONE',
      metadata: { toolCall: { id: 'call_1', name: 'list_dir' } },
      listDirectory: { results: [] },
    };
    fake.getCascadeTrajectorySteps
      .mockResolvedValueOnce({ steps: [] })
      .mockResolvedValueOnce({ steps: [announce, result, terminalPlannerResponse] });

    const protocol = new AntigravityCascadeProtocol({ cascadeClient: client(fake), pollIntervalMs: 0 });
    const events = await collect(
      protocol.run({ cascadeId: 'c1', modelKeyOrEnum: 'MODEL_PLACEHOLDER_M318', userMessage: 'hi' }),
    );

    expect(events[0]).toEqual({ type: 'tool_call', id: 'call_1', name: 'list_dir', args: { DirectoryPath: '.' } });
    expect(events[1]).toEqual({ type: 'tool_result', id: 'call_1', name: 'list_dir', result: JSON.stringify({ results: [] }) });
    expect(events[events.length - 1]).toEqual({ type: 'complete' });
  });

  it('does not advance the cursor past a still-mutating step, so its eventual result is not lost', async () => {
    const fake = fakeClient();
    fake.getCascadeTrajectorySteps
      .mockResolvedValueOnce({ steps: [] })
      .mockResolvedValueOnce({
        steps: [{ type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY', status: 'CORTEX_STEP_STATUS_RUNNING' }],
      })
      .mockResolvedValueOnce({
        steps: [
          { type: 'CORTEX_STEP_TYPE_LIST_DIRECTORY', status: 'CORTEX_STEP_STATUS_DONE', metadata: { toolCall: { id: 'call_1', name: 'list_dir' } }, listDirectory: {} },
          terminalPlannerResponse,
        ],
      });

    const protocol = new AntigravityCascadeProtocol({ cascadeClient: client(fake), pollIntervalMs: 0 });
    const events = await collect(
      protocol.run({ cascadeId: 'c1', modelKeyOrEnum: 'MODEL_PLACEHOLDER_M318', userMessage: 'hi' }),
    );

    // Third call must re-fetch from the SAME offset (0) as the second, not
    // advance past the RUNNING step.
    expect(fake.getCascadeTrajectorySteps).toHaveBeenNthCalledWith(2, 'c1', 0, undefined, undefined);
    expect(fake.getCascadeTrajectorySteps).toHaveBeenNthCalledWith(3, 'c1', 0, undefined, undefined);
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
  });

  it('surfaces an error and stops, rather than hanging, when a step is WAITING on user interaction', async () => {
    const fake = fakeClient();
    fake.getCascadeTrajectorySteps
      .mockResolvedValueOnce({ steps: [] })
      .mockResolvedValueOnce({ steps: [{ type: 'CORTEX_STEP_TYPE_ASK_QUESTION', status: 'CORTEX_STEP_STATUS_WAITING' }] });

    const protocol = new AntigravityCascadeProtocol({ cascadeClient: client(fake), pollIntervalMs: 0 });
    const events = await collect(
      protocol.run({ cascadeId: 'c1', modelKeyOrEnum: 'MODEL_PLACEHOLDER_M318', userMessage: 'hi' }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect((events[0] as { error: string }).error).toMatch(/waiting on a user interaction/i);
    // Must not have kept polling forever.
    expect(fake.getCascadeTrajectorySteps).toHaveBeenCalledTimes(2);
  });

  it('surfaces a rejected SendUserCascadeMessage as an error event, not a thrown exception', async () => {
    const fake = fakeClient();
    fake.getCascadeTrajectorySteps.mockResolvedValueOnce({ steps: [] });
    fake.sendUserCascadeMessage.mockRejectedValueOnce(new Error('neither PlanModel nor RequestedModel specified'));

    const protocol = new AntigravityCascadeProtocol({ cascadeClient: client(fake), pollIntervalMs: 0 });
    const events = await collect(
      protocol.run({ cascadeId: 'c1', modelKeyOrEnum: 'MODEL_PLACEHOLDER_M318', userMessage: 'hi' }),
    );

    expect(events).toEqual([{ type: 'error', error: 'neither PlanModel nor RequestedModel specified' }]);
    expect(fake.getCascadeTrajectorySteps).toHaveBeenCalledTimes(1);
  });

  it('times out rather than polling forever when the wall-clock deadline passes', async () => {
    const fake = fakeClient();
    fake.getCascadeTrajectorySteps
      .mockResolvedValueOnce({ steps: [] })
      .mockResolvedValue({ steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_GENERATING' }] });

    const protocol = new AntigravityCascadeProtocol({ cascadeClient: client(fake), pollIntervalMs: 0 });
    const events = await collect(
      protocol.run({ cascadeId: 'c1', modelKeyOrEnum: 'MODEL_PLACEHOLDER_M318', userMessage: 'hi', timeoutMs: 1 }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
    expect((events[0] as { error: string }).error).toMatch(/timed out/i);
  });

  it('respects an aborted signal instead of continuing to poll', async () => {
    const fake = fakeClient();
    const controller = new AbortController();
    fake.getCascadeTrajectorySteps.mockResolvedValueOnce({ steps: [] });
    fake.sendUserCascadeMessage.mockImplementationOnce(async () => {
      controller.abort();
    });

    const protocol = new AntigravityCascadeProtocol({ cascadeClient: client(fake), pollIntervalMs: 0 });
    const events = await collect(
      protocol.run({
        cascadeId: 'c1',
        modelKeyOrEnum: 'MODEL_PLACEHOLDER_M318',
        userMessage: 'hi',
        abortSignal: controller.signal,
      }),
    );

    expect(events).toEqual([]);
    // Must not have polled after the abort.
    expect(fake.getCascadeTrajectorySteps).toHaveBeenCalledTimes(1);
  });
});

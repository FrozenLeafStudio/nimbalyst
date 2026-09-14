// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AntigravityCascadeClient,
  buildAddTrackedWorkspaceRequest,
  buildCancelCascadeInvocationRequest,
  buildGetCascadeTrajectoryStepsRequest,
  buildLoadTrajectoryRequest,
  buildSendUserCascadeMessageRequest,
  buildStartCascadeRequest,
  toTrackedWorkspacePath,
  toWorkspaceUri,
} from '../AntigravityCascadeClient';
import type { AntigravityServerManager } from '../AntigravityServerManager';

type FakeServer = {
  ensureRunning: ReturnType<typeof vi.fn>;
  endpointEpoch: ReturnType<typeof vi.fn>;
  callRpc: ReturnType<typeof vi.fn>;
  resolveModelEnum: ReturnType<typeof vi.fn>;
};

function fakeServer(epoch = 'epoch-1'): FakeServer {
  return {
    ensureRunning: vi.fn().mockResolvedValue({ httpsPort: 1, csrf: epoch, owned: true }),
    endpointEpoch: vi.fn().mockReturnValue(epoch),
    callRpc: vi.fn().mockResolvedValue({}),
    resolveModelEnum: vi.fn().mockResolvedValue('MODEL_RESOLVED'),
  };
}

function client(server: FakeServer): AntigravityCascadeClient {
  return new AntigravityCascadeClient(server as unknown as AntigravityServerManager);
}

afterEach(() => vi.restoreAllMocks());

describe('workspace path/URI conversion', () => {
  it('converts a Windows path to the forward-slash form AddTrackedWorkspace wants', () => {
    expect(toTrackedWorkspacePath('C:\\Users\\steph\\proj')).toBe('C:/Users/steph/proj');
  });

  it('converts a Windows path to the file:// URI form StartCascade wants', () => {
    expect(toWorkspaceUri('C:\\Users\\steph\\proj')).toBe('file:///C:/Users/steph/proj');
  });
});

describe('request builders', () => {
  it('builds AddTrackedWorkspace with the plain-path shape confirmed live', () => {
    expect(buildAddTrackedWorkspaceRequest('C:\\proj')).toEqual({ workspace: 'C:/proj' });
  });

  it('builds StartCascade with the exact fields the live probe required', () => {
    expect(buildStartCascadeRequest('C:\\proj', 'MODEL_PLACEHOLDER_M318')).toEqual({
      workspaceUris: ['file:///C:/proj'],
      requestedModel: 'MODEL_PLACEHOLDER_M318',
      source: 'CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT',
      trajectoryType: 'CORTEX_TRAJECTORY_TYPE_CASCADE',
    });
  });

  it('builds LoadTrajectory keyed on cascadeId, not trajectoryId', () => {
    expect(buildLoadTrajectoryRequest('cascade-1')).toEqual({ cascadeId: 'cascade-1' });
  });

  it('builds GetCascadeTrajectorySteps with an inclusive stepOffset cursor', () => {
    expect(buildGetCascadeTrajectoryStepsRequest('cascade-1', 5)).toEqual({
      cascadeId: 'cascade-1',
      stepOffset: 5,
    });
  });

  it('builds SendUserCascadeMessage with the ModelOrAlias shape and the honoured bound field', () => {
    const body = buildSendUserCascadeMessageRequest({
      cascadeId: 'cascade-1',
      text: 'hello',
      modelEnum: 'MODEL_PLACEHOLDER_M318',
      blocking: false,
      maxGeneratorInvocations: 40,
      completionMaxTokens: 8192,
      userInteractionTimeoutSeconds: 30,
      toolOutputMaxBytes: 48_000,
    });
    expect(body).toEqual({
      cascadeId: 'cascade-1',
      items: [{ text: 'hello' }],
      blocking: false,
      cascadeConfig: {
        plannerConfig: {
          // {model: <enum>} -- a DIFFERENT shape from StartCascade's bare
          // enum string. Confirmed live: the bare-string shape 500s here.
          requestedModel: { model: 'MODEL_PLACEHOLDER_M318' },
          toolConfig: {
            autoAllowAllInteractions: true,
            autoInteractionBehavior: 'AUTO_INTERACTION_BEHAVIOR_ALLOW_ALL',
            userInteractionTimeoutSeconds: 30,
            toolOutput: { maxOutputBytes: 48_000 },
          },
          completionConfigOverride: { maxTokens: 8192 },
        },
        executorConfig: { maxGeneratorInvocations: 40 },
      },
    });
  });

  // Decision point: the plan is explicit that `plannerConfig.maxOutputTokens`
  // is parsed, echoed back, and silently ignored by the server (confirmed
  // live: maxOutputTokens=1 still produced a 2,373-token response), while
  // `completionConfigOverride.maxTokens` is the field that is actually
  // honoured. A regression that reintroduces the ignored field would still
  // "work" against a mock, so assert its absence explicitly.
  it('never sends the ignored plannerConfig.maxOutputTokens field', () => {
    const body = buildSendUserCascadeMessageRequest({
      cascadeId: 'cascade-1',
      text: 'hello',
      modelEnum: 'MODEL_PLACEHOLDER_M318',
      blocking: false,
      maxGeneratorInvocations: 40,
      completionMaxTokens: 8192,
      userInteractionTimeoutSeconds: 30,
      toolOutputMaxBytes: 48_000,
    });
    const plannerConfig = (body.cascadeConfig as { plannerConfig: Record<string, unknown> }).plannerConfig;
    expect(plannerConfig.maxOutputTokens).toBeUndefined();
  });

  it('omits completionConfigOverride entirely when no bound is given, rather than sending an empty override', () => {
    const body = buildSendUserCascadeMessageRequest({
      cascadeId: 'cascade-1',
      text: 'hello',
      modelEnum: 'MODEL_PLACEHOLDER_M318',
      blocking: true,
      maxGeneratorInvocations: 40,
      userInteractionTimeoutSeconds: 30,
      toolOutputMaxBytes: 48_000,
    });
    const plannerConfig = (body.cascadeConfig as { plannerConfig: Record<string, unknown> }).plannerConfig;
    expect(plannerConfig.completionConfigOverride).toBeUndefined();
    expect(body.blocking).toBe(true);
  });

  // Phase 2A step 6: [LIVE] step3-mcp-results.md -- customizationDiscoveryConfig
  // is the proven-live path that exposes Nimbalyst's tools to the model.
  it('includes customizationDiscoveryConfig.mcp.servers when mcpEndpoints are given', () => {
    const body = buildSendUserCascadeMessageRequest({
      cascadeId: 'cascade-1',
      text: 'hello',
      modelEnum: 'MODEL_PLACEHOLDER_M318',
      blocking: false,
      maxGeneratorInvocations: 40,
      userInteractionTimeoutSeconds: 30,
      toolOutputMaxBytes: 48_000,
      mcpEndpoints: [{ serverName: 'nimbalyst', url: 'http://127.0.0.1:3456/mcp/core', bearerToken: 't' }],
    });
    const plannerConfig = (body.cascadeConfig as { plannerConfig: Record<string, unknown> }).plannerConfig;
    expect(plannerConfig.customizationDiscoveryConfig).toEqual({
      mcp: {
        servers: [{
          serverName: 'nimbalyst',
          serverUrl: 'http://127.0.0.1:3456/mcp/core?token=t',
          headers: { Authorization: 'Bearer t' },
        }],
      },
    });
  });

  it('omits customizationDiscoveryConfig entirely when no MCP endpoints are given', () => {
    const body = buildSendUserCascadeMessageRequest({
      cascadeId: 'cascade-1',
      text: 'hello',
      modelEnum: 'MODEL_PLACEHOLDER_M318',
      blocking: false,
      maxGeneratorInvocations: 40,
      userInteractionTimeoutSeconds: 30,
      toolOutputMaxBytes: 48_000,
      mcpEndpoints: [],
    });
    const plannerConfig = (body.cascadeConfig as { plannerConfig: Record<string, unknown> }).plannerConfig;
    expect(plannerConfig.customizationDiscoveryConfig).toBeUndefined();
  });
});

describe('AntigravityCascadeClient.sendUserCascadeMessage', () => {
  it('resolves a bare model key to an enum before calling SendUserCascadeMessage', async () => {
    const server = fakeServer();
    const c = client(server);

    await c.sendUserCascadeMessage({
      cascadeId: 'cascade-1',
      text: 'hi',
      modelKeyOrEnum: 'gemini-3-flash-agent',
      blocking: false,
      maxGeneratorInvocations: 40,
      userInteractionTimeoutSeconds: 30,
      toolOutputMaxBytes: 48_000,
    });

    expect(server.resolveModelEnum).toHaveBeenCalledWith('gemini-3-flash-agent');
    expect(server.callRpc).toHaveBeenCalledWith(
      'SendUserCascadeMessage',
      expect.objectContaining({
        cascadeId: 'cascade-1',
        cascadeConfig: expect.objectContaining({
          plannerConfig: expect.objectContaining({ requestedModel: { model: 'MODEL_RESOLVED' } }),
        }),
      }),
      expect.any(Number),
      undefined,
    );
  });

  it('skips resolution when already given a server enum', async () => {
    const server = fakeServer();
    const c = client(server);

    await c.sendUserCascadeMessage({
      cascadeId: 'cascade-1',
      text: 'hi',
      modelKeyOrEnum: 'MODEL_PLACEHOLDER_M318',
      blocking: false,
      maxGeneratorInvocations: 40,
      userInteractionTimeoutSeconds: 30,
      toolOutputMaxBytes: 48_000,
    });

    expect(server.resolveModelEnum).not.toHaveBeenCalled();
  });
});

describe('AntigravityCascadeClient.getCascadeTrajectorySteps', () => {
  it('calls GetCascadeTrajectorySteps with the given cursor and returns the parsed steps', async () => {
    const server = fakeServer();
    server.callRpc.mockResolvedValue({ steps: [{ type: 'CORTEX_STEP_TYPE_USER_INPUT' }] });
    const c = client(server);

    const result = await c.getCascadeTrajectorySteps('cascade-1', 3);

    expect(server.callRpc).toHaveBeenCalledWith(
      'GetCascadeTrajectorySteps',
      { cascadeId: 'cascade-1', stepOffset: 3 },
      expect.any(Number),
      undefined,
    );
    expect(result).toEqual({ steps: [{ type: 'CORTEX_STEP_TYPE_USER_INPUT' }] });
  });
});

describe('AntigravityCascadeClient.ensureWorkspaceTracked', () => {
  it('calls AddTrackedWorkspace once per workspace per epoch', async () => {
    const server = fakeServer();
    const c = client(server);
    await c.ensureWorkspaceTracked('C:\\proj');
    await c.ensureWorkspaceTracked('C:\\proj');
    expect(server.callRpc).toHaveBeenCalledTimes(1);
    expect(server.callRpc).toHaveBeenCalledWith(
      'AddTrackedWorkspace',
      { workspace: 'C:/proj' },
      expect.any(Number),
      undefined,
    );
  });

  it('re-adds after the endpoint epoch changes (a respawn forgets server-side tracking)', async () => {
    const server = fakeServer('epoch-1');
    const c = client(server);
    await c.ensureWorkspaceTracked('C:\\proj');
    server.endpointEpoch.mockReturnValue('epoch-2');
    await c.ensureWorkspaceTracked('C:\\proj');
    expect(server.callRpc).toHaveBeenCalledTimes(2);
  });
});

describe('AntigravityCascadeClient.startCascade', () => {
  it('resolves a bare model key to an enum before calling StartCascade', async () => {
    const server = fakeServer();
    server.callRpc.mockResolvedValue({ cascadeId: 'c1' });
    const c = client(server);

    const result = await c.startCascade('C:\\proj', 'gemini-3-flash-agent');

    expect(server.resolveModelEnum).toHaveBeenCalledWith('gemini-3-flash-agent');
    expect(server.callRpc).toHaveBeenCalledWith(
      'StartCascade',
      expect.objectContaining({ requestedModel: 'MODEL_RESOLVED' }),
      expect.any(Number),
      undefined,
    );
    expect(result).toEqual({ cascadeId: 'c1' });
  });

  it('skips resolution when already given a server enum', async () => {
    const server = fakeServer();
    server.callRpc.mockResolvedValue({ cascadeId: 'c1' });
    const c = client(server);

    await c.startCascade('C:\\proj', 'MODEL_PLACEHOLDER_M318');

    expect(server.resolveModelEnum).not.toHaveBeenCalled();
  });

  it('throws when StartCascade returns no cascadeId', async () => {
    const server = fakeServer();
    server.callRpc.mockResolvedValue({});
    const c = client(server);

    await expect(c.startCascade('C:\\proj', 'MODEL_PLACEHOLDER_M318')).rejects.toThrow(
      /no cascadeId/,
    );
  });
});

describe('AntigravityCascadeClient.ensureCascade', () => {
  it('starts fresh when no persisted cascade id is given', async () => {
    const server = fakeServer();
    server.callRpc.mockResolvedValue({ cascadeId: 'new-cascade' });
    const c = client(server);

    const result = await c.ensureCascade({
      workspacePath: 'C:\\proj',
      modelKeyOrEnum: 'MODEL_PLACEHOLDER_M318',
    });

    expect(server.callRpc).toHaveBeenCalledWith(
      'StartCascade',
      expect.anything(),
      expect.any(Number),
      undefined,
    );
    expect(server.callRpc.mock.calls.map((c: unknown[]) => c[0])).not.toContain('LoadTrajectory');
    expect(result).toEqual({ cascadeId: 'new-cascade', resumed: false });
  });

  it('reattaches via LoadTrajectory when a persisted id resolves, without starting a new cascade', async () => {
    const server = fakeServer();
    server.callRpc.mockResolvedValue({}); // LoadTrajectory response shape
    const c = client(server);

    const result = await c.ensureCascade({
      workspacePath: 'C:\\proj',
      modelKeyOrEnum: 'MODEL_PLACEHOLDER_M318',
      persistedCascadeId: 'old-cascade',
    });

    expect(server.callRpc).toHaveBeenCalledWith(
      'LoadTrajectory',
      { cascadeId: 'old-cascade' },
      expect.any(Number),
      undefined,
    );
    expect(server.callRpc.mock.calls.map((c: unknown[]) => c[0])).not.toContain('StartCascade');
    expect(result).toEqual({ cascadeId: 'old-cascade', resumed: true });
  });

  it('falls back to starting fresh when LoadTrajectory rejects a stale id', async () => {
    const server = fakeServer();
    server.callRpc.mockImplementation(async (method: string) => {
      if (method === 'LoadTrajectory') throw new Error('not found');
      if (method === 'StartCascade') return { cascadeId: 'fresh-cascade' };
      return {};
    });
    const c = client(server);

    const result = await c.ensureCascade({
      workspacePath: 'C:\\proj',
      modelKeyOrEnum: 'MODEL_PLACEHOLDER_M318',
      persistedCascadeId: 'stale-cascade',
    });

    expect(result).toEqual({ cascadeId: 'fresh-cascade', resumed: false });
  });
});

describe('buildCancelCascadeInvocationRequest', () => {
  // [LIVE] step3-results.md probe cancel1: this exact body returned 200.
  it('defaults killBackgroundTasks to true, matching the live probe', () => {
    expect(buildCancelCascadeInvocationRequest('cascade-1')).toEqual({
      cascadeId: 'cascade-1',
      killBackgroundTasks: true,
    });
  });

  it('honours an explicit killBackgroundTasks override', () => {
    expect(buildCancelCascadeInvocationRequest('cascade-1', false)).toEqual({
      cascadeId: 'cascade-1',
      killBackgroundTasks: false,
    });
  });
});

describe('AntigravityCascadeClient.cancelInvocation', () => {
  it('calls CancelCascadeInvocation with the cascade id', async () => {
    const server = fakeServer();
    const c = client(server);

    await c.cancelInvocation('cascade-1');

    expect(server.callRpc).toHaveBeenCalledWith(
      'CancelCascadeInvocation',
      { cascadeId: 'cascade-1', killBackgroundTasks: true },
      expect.any(Number),
      undefined,
    );
  });
});

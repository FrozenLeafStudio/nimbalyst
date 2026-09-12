// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { SyncProvider, ProjectConfig } from '@nimbalyst/runtime/sync/types';
import { createProjectConfigSync } from '../sync/projectConfigSync';

const command = { name: 'investigate', source: 'project' as const };
const action = { id: 'review', label: 'Review', body: 'Review this change' };

function setup() {
  const send = vi.fn(async (_path: string, _config: ProjectConfig) => {});
  const provider = { syncProjectConfig: send } as unknown as SyncProvider;
  const deps = {
    getProvider: () => provider,
    getGitRemoteHash: async () => 'remote-hash',
    getEnabledProjects: () => ['/project'],
    isProjectEnabled: (path: string): boolean => path === '/project',
    discoverCommands: vi.fn(async () => [command]),
    discoverActions: vi.fn(async () => [action]),
    warn: vi.fn(),
  };
  return { sync: createProjectConfigSync(deps), deps, send, provider };
}

describe('mobile project config lifecycle', () => {
  it('does not erase slash commands when actions load before the desktop composer', async () => {
    const { sync, send } = setup();
    await sync.syncProjectActionsToMobile('/project', [action]);
    expect(send).toHaveBeenLastCalledWith('/project', expect.objectContaining({
      commands: [command], actions: [action],
    }));
  });

  it('discovers a cold project on connection without any renderer request, and replays commands loaded offline', async () => {
    const { sync, send, deps, provider } = setup();
    await sync.refresh();
    expect(send).toHaveBeenLastCalledWith('/project', expect.objectContaining({ commands: [command] }));

    deps.getProvider = () => null as unknown as SyncProvider;
    const native = { name: 'compact', source: 'builtin' };
    await sync.syncProjectCommandsToMobile('/project', [command, native]);
    expect(send).toHaveBeenCalledTimes(1);
    deps.getProvider = () => provider;
    await sync.refresh();
    expect(send).toHaveBeenLastCalledWith('/project', expect.objectContaining({ commands: [command, native], actions: [action] }));
  });

  it('waits for transport readiness and retries a failed connection on the next refresh', async () => {
    const { sync, send, deps, provider } = setup();
    provider.waitForIndexReady = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    await sync.refresh();
    expect(send).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to sync project config'), expect.any(Error));
    await sync.refresh();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not let delayed discovery replace a newer renderer command list', async () => {
    const { sync, send, deps } = setup();
    let finish!: (commands: typeof command[]) => void;
    deps.discoverCommands.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const refreshing = sync.refresh();
    await vi.waitFor(() => expect(deps.discoverCommands).toHaveBeenCalled());
    const updated = { name: 'new-command', source: 'project' };
    const update = sync.syncProjectCommandsToMobile('/project', [updated]);
    finish([command]);
    await Promise.all([refreshing, update]);
    expect(send.mock.calls.every(([, config]) => config.commands[0].name === updated.name)).toBe(true);
  });

  it('never publishes to a replacement account or a project disabled during discovery', async () => {
    for (const changeAccount of [true, false]) {
      const { sync, send, deps } = setup();
      deps.discoverCommands.mockImplementationOnce(async () => {
        if (changeAccount) deps.getProvider = () => ({}) as SyncProvider;
        else deps.isProjectEnabled = () => false;
        return [command];
      });
      await sync.refresh();
      expect(send).not.toHaveBeenCalled();
    }
  });
});

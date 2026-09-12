import type { SyncProvider, SyncedSlashCommand } from '@nimbalyst/runtime/sync/types';
import type { ActionPrompt } from '../ActionPromptParser';
import { composeProjectConfig, toSyncedActionPrompts, type ProjectConfigSlices } from './projectConfigComposer';

export interface ProjectConfigSyncDependencies {
  getProvider(): SyncProvider | null;
  getEnabledProjects(): string[];
  isProjectEnabled(workspacePath: string): boolean;
  discoverCommands(workspacePath: string): Promise<SyncedSlashCommand[]>;
  discoverActions(workspacePath: string): Promise<ActionPrompt[]>;
  getGitRemoteHash(workspacePath: string): Promise<string | undefined>;
  warn(message: string, error?: unknown): void;
}

/** Owns both slices of the whole-object config, independently of mounted composers. */
export function createProjectConfigSync(deps: ProjectConfigSyncDependencies) {
  const projects = new Map<string, ProjectConfigSlices>();
  const pending = new Map<string, Promise<void>>();

  function manifests(commands: Array<{ name: string; description?: string; source: string }>): SyncedSlashCommand[] {
    return commands.map(({ name, description, source }) => ({
      name, description, source: source as SyncedSlashCommand['source'],
    }));
  }

  function slicesFor(path: string): ProjectConfigSlices {
    let slices = projects.get(path);
    if (!slices) {
      slices = { commands: [], lastCommandsUpdate: 0, actions: [], lastActionsUpdate: 0 };
      projects.set(path, slices);
    }
    return slices;
  }

  function setActions(slices: ProjectConfigSlices, actions: ActionPrompt[]): void {
    const projected = toSyncedActionPrompts(actions);
    if (projected.droppedForCount || projected.droppedForSize || projected.truncatedCount) {
      deps.warn('[SyncManager] Mobile action prompts exceeded the sync budget', projected);
    }
    slices.actions = projected.actions;
    slices.lastActionsUpdate = Date.now();
  }

  function publish(path: string): Promise<void> {
    const provider = deps.getProvider();
    if (!provider?.syncProjectConfig || !deps.isProjectEnabled(path)) return Promise.resolve();
    // Serialize encryption/sends per project so an older whole-object write cannot
    // land after a newer command or action update. Failures must not poison retries.
    const job = (pending.get(path) ?? Promise.resolve()).then(async () => {
      const current = () => deps.getProvider() === provider && deps.isProjectEnabled(path);
      if (!current()) return;
      await provider.waitForIndexReady?.();
      if (!current()) return;
      const slices = slicesFor(path);
      if (!slices.lastCommandsUpdate) {
        const commands = await deps.discoverCommands(path);
        // A renderer may have supplied the richer provider-native list while
        // discovery was running. Never replace it with the cold-start fallback.
        if (!slices.lastCommandsUpdate) {
          slices.commands = manifests(commands);
          slices.lastCommandsUpdate = Date.now();
        }
      }
      if (!slices.lastActionsUpdate) {
        const actions = await deps.discoverActions(path);
        if (!slices.lastActionsUpdate) setActions(slices, actions);
      }
      const gitRemoteHash = await deps.getGitRemoteHash(path);
      if (!current()) return;
      await provider.syncProjectConfig!(path, composeProjectConfig({ ...slices, gitRemoteHash }));
    }).catch(error => deps.warn(`[SyncManager] Failed to sync project config for ${path}`, error));
    pending.set(path, job);
    void job.then(() => { if (pending.get(path) === job) pending.delete(path); });
    return job;
  }

  async function syncProjectCommandsToMobile(path: string, commands: Array<{ name: string; description?: string; source: string }>): Promise<void> {
    const slices = slicesFor(path);
    slices.commands = manifests(commands);
    slices.lastCommandsUpdate = Date.now();
    await publish(path);
  }

  async function syncProjectActionsToMobile(path: string, actions: ActionPrompt[]): Promise<void> {
    setActions(slicesFor(path), actions);
    await publish(path);
  }

  let refreshing: Promise<void> | undefined;
  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    // Include cached worktree paths only while their parent remains sync-enabled.
    const paths = new Set([...deps.getEnabledProjects(), ...projects.keys()]);
    refreshing = Promise.all([...paths].filter(deps.isProjectEnabled).map(publish)).then(() => {});
    void refreshing.finally(() => { refreshing = undefined; });
    return refreshing;
  }

  return { syncProjectCommandsToMobile, syncProjectActionsToMobile, refresh };
}

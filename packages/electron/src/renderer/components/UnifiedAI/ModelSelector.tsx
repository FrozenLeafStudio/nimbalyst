import React, { useState, useEffect } from 'react';
import {
  autoUpdate,
  flip,
  FloatingPortal,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import { useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { getProviderIcon } from '@nimbalyst/runtime/ui/icons/ProviderIcons';
import { isAgentProvider, shouldBlockStartedSessionProviderSwitch } from '@nimbalyst/runtime/ai/server/types';
import { getClaudeCodeModelLabel } from '../../utils/modelUtils';
import { advancedSettingsAtom, aiProviderSettingsAtom } from '../../store/atoms/appSettings';
import { setWindowModeAtom } from '../../store/atoms/windowMode';
import { navigateToSettingsAtom } from '../../store/atoms/settingsNavigation';
import type { SettingsCategory } from '../Settings/SettingsSidebar';
import { AlphaBadge } from '../common/AlphaBadge';
import { HelpTooltip } from '../../help';
import { isDirectChatProvider, isProviderVisible } from '../../utils/chatProviderVisibility';

const ALPHA_PROVIDERS = new Set(['opencode', 'copilot-cli', 'grok-build', 'cursor-agent', 'antigravity-gemini-agent']);
const TYPEAHEAD_RESET_MS = 700;

interface Model {
  id: string;
  name: string;
  provider: string;
  /** Kept only because something still refers to it; discovery did not return it. */
  unavailable?: boolean;
}

interface ProviderHealth {
  state: 'ok' | 'degraded';
  reason?: string;
  detail?: string;
  retryable?: boolean;
}

type ProviderType = 'agent' | 'model';

interface ModelSelectorProps {
  currentModel: string;  // Full provider:model ID
  onModelChange: (modelId: string) => void;
  sessionHasMessages?: boolean;  // Whether current session has any messages
  currentProvider?: string | null;  // Current session provider
  /**
   * Render the current model as a non-interactive chip (no dropdown). Used for
   * committed claude-code-cli sessions where the model is fixed at spawn — we
   * still want to SHOW which provider/model is running, just not let it change.
   */
  readOnly?: boolean;
  /** Tooltip shown on the read-only chip explaining why it can't change. */
  readOnlyTitle?: string;
  /**
   * Monotonic signal from the AI input to open the picker from a keyboard
   * shortcut. Keeping the trigger here makes the menu own its focus behavior.
   */
  openRequest?: number;
  /** Restore focus to the AI input when Escape dismisses the menu. */
  onKeyboardDismiss?: () => void;
  /**
   * Why the selection cannot be used, or null when it can. `hidden` is the
   * user's own doing and needs different wording from a withdrawn model.
   */
  onAvailabilityChange?: (reason: 'hidden' | 'withdrawn' | null) => void;
}

export function ModelSelector({
  currentModel,
  onModelChange,
  sessionHasMessages = false,
  currentProvider = null,
  readOnly = false,
  readOnlyTitle,
  openRequest,
  onKeyboardDismiss,
  onAvailabilityChange,
}: ModelSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [models, setModels] = useState<Record<string, Model[]>>({});
  const [providerLabels, setProviderLabels] = useState<Record<string, string>>({});
  const [providerIcons, setProviderIcons] = useState<Record<string, string>>({});
  const [providerHealth, setProviderHealth] = useState<Record<string, ProviderHealth>>({});
  const [loading, setLoading] = useState(false);
  const [catalogSettled, setCatalogSettled] = useState(false);
  const aiProviderSettings = useAtomValue(aiProviderSettingsAtom);
  const advancedSettings = useAtomValue(advancedSettingsAtom);
  const { providers } = aiProviderSettings;
  const setWindowMode = useSetAtom(setWindowModeAtom);
  const navigateToSettings = useSetAtom(navigateToSettingsAtom);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const lastOpenRequestRef = React.useRef(openRequest);
  const typeaheadQueryRef = React.useRef('');
  const typeaheadResetTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const { refs, floatingStyles, context } = useFloating({
    open: isOpen,
    onOpenChange: setIsOpen,
    placement: 'top-start',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(4),
      flip({ fallbackPlacements: ['bottom-start', 'top-end', 'bottom-end'], padding: 8 }),
      shift({ padding: 8 }),
      windowControlsClearance(),
    ],
  });
  const dismiss = useDismiss(context, {
    // Escape is handled on the menu so the AI input can reclaim focus.
    escapeKey: false,
    outsidePress: (event) => !(event.target as Element | null)?.closest?.('.help-tooltip'),
  });
  const role = useRole(context, { role: 'menu' });
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss, role]);

  const loadModels = React.useCallback(async () => {
    setLoading(true);
    try {
      const response = await window.electronAPI.aiGetModels();
      if (response.success && response.grouped) {
        setModels(response.grouped);
        const meta = response as {
          providerLabels?: Record<string, string>;
          providerIcons?: Record<string, string>;
          providerHealth?: Record<string, ProviderHealth>;
        };
        if (meta.providerLabels) setProviderLabels(meta.providerLabels);
        if (meta.providerIcons) setProviderIcons(meta.providerIcons);
        setProviderHealth(meta.providerHealth ?? {});
        setCatalogSettled(true);
      }
    } catch (error) {
      console.error('Failed to load models:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  React.useLayoutEffect(() => {
    if (openRequest === undefined || openRequest === lastOpenRequestRef.current) return;
    lastOpenRequestRef.current = openRequest;
    setIsOpen(true);
  }, [openRequest]);

  // Preload before the user opens the picker. The main process serves its last
  // successful catalog immediately and refreshes stale providers in the
  // background, so mounting a new session input never turns a click into a
  // network/CLI discovery boundary.
  useEffect(() => {
    setModels({});
    setCatalogSettled(false);
    void loadModels();
  }, [providers, loadModels]);

  const resetTypeahead = React.useCallback(() => {
    typeaheadQueryRef.current = '';
    if (typeaheadResetTimerRef.current) {
      clearTimeout(typeaheadResetTimerRef.current);
      typeaheadResetTimerRef.current = null;
    }
  }, []);

  useEffect(() => resetTypeahead, [resetTypeahead]);

  useEffect(() => {
    if (!isOpen) resetTypeahead();
  }, [isOpen, resetTypeahead]);

  const handleModelSelect = (modelId: string) => {
    resetTypeahead();
    onModelChange(modelId);
    setIsOpen(false);
  };

  const getEnabledModelOptions = React.useCallback((): HTMLButtonElement[] => {
    if (!menuRef.current) return [];
    return Array.from(
      menuRef.current.querySelectorAll<HTMLButtonElement>('.model-selector-option:not([aria-disabled="true"])')
    );
  }, []);

  const focusMenu = React.useCallback((menu: HTMLDivElement) => {
    const options = Array.from(
      menu.querySelectorAll<HTMLButtonElement>('.model-selector-option:not([aria-disabled="true"])')
    );
    const currentOption = options.find(option => option.dataset.modelId === currentModel);
    (currentOption ?? options[0] ?? menu).focus();
  }, [currentModel]);

  const setMenuReference = React.useCallback((node: HTMLDivElement | null) => {
    refs.setFloating(node);
    menuRef.current = node;
    // A portal's children may attach after the parent's layout effects. Focus
    // from the ref as well so reopening a cached list never waits for another
    // state change before keyboard navigation becomes active.
    if (node) focusMenu(node);
  }, [refs.setFloating, focusMenu]);

  const handleOptionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const options = getEnabledModelOptions();
    const currentIndex = options.indexOf(event.currentTarget);

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      resetTypeahead();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const nextIndex = Math.max(0, Math.min(options.length - 1, currentIndex + direction));
      options[nextIndex]?.focus();
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleModelSelect(event.currentTarget.dataset.modelId!);
      return;
    }

  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      resetTypeahead();
      setIsOpen(false);
      onKeyboardDismiss?.();
      return;
    }

    if (
      event.key.length !== 1
      || event.key.trim() === ''
      || event.metaKey
      || event.ctrlKey
      || event.altKey
      || event.nativeEvent.isComposing
    ) return;

    event.preventDefault();
    typeaheadQueryRef.current += event.key.toLowerCase();

    if (typeaheadResetTimerRef.current) clearTimeout(typeaheadResetTimerRef.current);
    typeaheadResetTimerRef.current = setTimeout(resetTypeahead, TYPEAHEAD_RESET_MS);

    const query = typeaheadQueryRef.current;
    const matches = getEnabledModelOptions()
      .map(option => {
        const name = option.dataset.modelName?.toLowerCase() ?? '';
        const id = option.dataset.modelId?.toLowerCase() ?? '';
        const searchable = `${name} ${id}`;
        const tokens = searchable.split(/[^a-z0-9]+/).filter(Boolean);
        const score = name.startsWith(query)
          ? 0
          : tokens.some(token => token.startsWith(query))
            ? 1
            : searchable.includes(query)
              ? 2
              : -1;
        return { option, score };
      })
      .filter(match => match.score >= 0)
      .sort((a, b) => a.score - b.score);

    matches[0]?.option.focus();
  };

  const getSettingsCategoryForModel = (modelId: string): SettingsCategory => {
    const provider = modelId.split(':')[0];
    switch (provider) {
      case 'claude':
      case 'claude-code':
      case 'openai':
      case 'openai-codex':
      case 'opencode':
      case 'copilot-cli':
      case 'grok-build':
      case 'cursor-agent':
      case 'antigravity-gemini-agent':
      case 'lmstudio':
        return provider;
      case 'openai-codex-acp':
        // Settings still live under the OpenAI Codex panel.
        return 'openai-codex';
      default:
        return 'claude-code';
    }
  };

  const handleConfigureModels = () => {
    setIsOpen(false);
    navigateToSettings({
      category: getSettingsCategoryForModel(currentModel),
      scope: 'application',
    });
    setWindowMode('settings');
  };

  const getCurrentModelName = () => {
    // Voice sessions run the OpenAI Realtime voice agent, not the Claude
    // model the session row defaults its `model` field to. Label it by
    // provider so the chip doesn't misreport e.g. "Sonnet 4.6".
    if (currentProvider === 'openai-realtime') return 'OpenAI Voice Agent';

    if (!currentModel) return 'Select Model';

    // Find the model in our list
    for (const providerModels of Object.values(models)) {
      const model = providerModels.find(m => m.id === currentModel);
      if (model) return model.name;
    }

    // Fallback - strip provider prefix for display
    if (currentModel.startsWith('claude-code')) {
      return getClaudeCodeModelLabel(currentModel);
    }
    const [, ...modelParts] = currentModel.split(':');
    return modelParts.join(':') || currentModel;
  };

  /** True when the user hid this exact model in Settings. */
  const currentModelHidden = React.useMemo(() => {
    if (!currentModel) return false;
    const owning = currentModel.split(':')[0];
    return providers?.[owning]?.hiddenModels?.includes(currentModel) === true;
  }, [currentModel, providers]);

  /**
   * Each guard prevents a specific false positive:
   * - unsettled catalog: would fire on every mount, before the first fetch
   * - degraded provider: a partial outage would read as total loss
   * - empty catalog: we learned nothing, rather than everything vanishing
   */
  const currentModelMissing = React.useMemo(() => {
    if (!currentModel || !catalogSettled) return false;
    const groups = Object.values(models);
    if (groups.length === 0 || groups.every(g => g.length === 0)) return false;
    const owningProvider = currentModel.split(':')[0];
    if (providerHealth[owningProvider]?.state === 'degraded') return false;
    return !groups.some(providerModels => providerModels.some(m => m.id === currentModel));
  }, [currentModel, catalogSettled, models, providerHealth]);

  /** Non-blocking: the models we did find stay listed and selectable. */
  const renderProviderHealthNotice = (provider: string) => {
    const health = providerHealth[provider];
    if (!health || health.state !== 'degraded') return null;
    return (
      <div
        className="model-selector-health-notice mx-2 mb-1 px-2 py-1.5 rounded text-[10px] leading-snug text-[var(--nim-warning,#b45309)] bg-[var(--nim-bg-secondary)]"
        role="status"
        data-testid={`model-health-${provider}`}
      >
        <div className="flex items-start gap-1.5">
          <MaterialSymbol icon="warning" size={12} className="shrink-0 mt-[1px]" />
          <span className="flex-1">
            {health.detail ?? 'This model list may be incomplete.'}
          </span>
        </div>
        {health.retryable && (
          <button
            type="button"
            className="model-selector-health-retry mt-1 ml-[18px] underline cursor-pointer bg-transparent border-none p-0 text-[10px] text-[var(--nim-warning,#b45309)]"
            onClick={(e) => {
              e.stopPropagation();
              void loadModels();
            }}
          >
            Retry
          </button>
        )}
      </div>
    );
  };

  /**
   * A provider that auto-disables when its backend is missing contributes no
   * group, so its notice has nowhere to render. Surfaced only when the current
   * selection belongs to it, so other users are not nagged.
   */
  const orphanedHealthProviders = React.useMemo(() => {
    const owning = currentModel ? currentModel.split(':')[0] : null;
    if (!owning) return [] as string[];
    return Object.entries(providerHealth)
      .filter(([provider, health]) => health?.state === 'degraded' && provider === owning)
      .filter(([provider]) => (models[provider]?.length ?? 0) === 0)
      .map(([provider]) => provider);
  }, [providerHealth, models, currentModel]);

  useEffect(() => {
    // A read-only chip has no menu to open, so reporting would disable sending
    // with no way to choose another model.
    if (readOnly) return onAvailabilityChange?.(null);
    if (currentModelHidden) return onAvailabilityChange?.('hidden');
    onAvailabilityChange?.(currentModelMissing ? 'withdrawn' : null);
  }, [currentModelMissing, currentModelHidden, onAvailabilityChange, readOnly]);

  const getProviderLabel = (provider: string) => {
    // Extension-contributed providers carry their manifest displayName from
    // ai:getModels; prefer it over the prettified-id fallback below.
    if (providerLabels[provider]) return providerLabels[provider];
    switch (provider) {
      case 'claude': return 'Claude Chat';
      // The default agent, and the one a Claude subscription runs on without any
      // extra setup. What it's built on lives in the hover help, so the
      // parenthetical here is spent steering the choice instead.
      case 'claude-code': return 'Claude Agent (Recommended)';
      case 'claude-code-cli': return 'Claude Code CLI';
      case 'openai': return 'OpenAI';
      case 'openai-codex': return 'OpenAI Codex';
      case 'openai-codex-acp': return 'OpenAI Codex (ACP)';
      case 'opencode': return 'OpenCode';
      case 'copilot-cli': return 'GitHub Copilot';
      case 'grok-build': return 'Grok Build';
      case 'cursor-agent': return 'Cursor Agent';
      case 'antigravity-gemini-agent': return 'Gemini';
      case 'lmstudio': return 'LMStudio';
      default: {
        // Extension-contributed providers carry their contribution id here
        // (e.g. "antigravity-gemini-agent"). Prettify it for the group header
        // rather than showing the raw id; the per-model names already come
        // from the extension manifest.
        const cleaned = provider.replace(/-agent$/, '').replace(/[-_]+/g, ' ').trim();
        return cleaned.replace(/\b\w/g, (c) => c.toUpperCase()) || provider;
      }
    }
  };

  // Built-in chat-model providers are a small closed set. Built-in agent CLIs
  // are matched by isAgentProvider. Anything left over is an extension-
  // contributed agent provider id (e.g. antigravity-gemini-agent), which we
  // group under "Agents" so it surfaces the same way Codex / Claude Code do --
  // without the renderer needing the main-process AgentProviderRegistry.
  // Extension providers ship a Material icon name in their manifest; prefer it
  // so the picker header matches the Agent Providers sidebar. Built-ins fall
  // back to getProviderIcon.
  const renderProviderIcon = (provider: string, size: number) => {
    const ext = providerIcons[provider];
    if (ext) return <MaterialSymbol icon={ext} size={size} />;
    return getProviderIcon(provider, { size });
  };

  const getProviderType = (provider: string): ProviderType => {
    if (isAgentProvider(provider)) return 'agent';
    if (isDirectChatProvider(provider)) return 'model';
    return 'agent';
  };

  const isProviderSwitchDisabled = (targetProvider: string): boolean => {
    return shouldBlockStartedSessionProviderSwitch(currentProvider, targetProvider, sessionHasMessages);
  };

  const isSectionDisabled = (sectionType: 'agent' | 'model'): boolean => {
    if (!sessionHasMessages || !currentProvider) return false;
    const currentProviderType = getProviderType(currentProvider);
    return sectionType !== currentProviderType;
  };

  const preservedProvider = sessionHasMessages ? currentProvider : null;
  const visibleModels = Object.fromEntries(
    Object.entries(models).filter(([provider]) => isProviderVisible(provider, {
      revealAll: advancedSettings.showDirectChatProviders,
      settings: aiProviderSettings,
      preserveProviderId: preservedProvider,
    })),
  );

  // Group providers by type (agents vs models)
  const groupedProviders = Object.entries(visibleModels).reduce((acc, [provider, providerModels]) => {
    const isAgent = getProviderType(provider) === 'agent';
    const type = isAgent ? 'agents' : 'models';
    if (!acc[type]) acc[type] = {};
    acc[type][provider] = providerModels;
    return acc;
  }, {} as Record<'agents' | 'models', Record<string, Model[]>>);

  // Capture focus as soon as the popup opens, including while models are still
  // loading. Once options exist, move focus to the active model (or the first
  // available one) so Arrow keys work immediately.
  React.useLayoutEffect(() => {
    if (!isOpen) return;
    if (menuRef.current) focusMenu(menuRef.current);
  }, [isOpen, loading, models, focusMenu]);

  // Read-only chip: show the running provider/model without a dropdown. Used by
  // committed claude-code-cli sessions where the model is fixed at spawn, and
  // by voice sessions (openai-realtime) whose model isn't user-selectable.
  const readOnlyFlagged = currentModelMissing || currentModelHidden;
  if (readOnly || currentProvider === 'openai-realtime') {
    return (
      <div className="model-selector inline-block">
        <span
          className={`model-selector-button model-selector-readonly flex items-center gap-1 px-2 py-[3px] rounded-xl text-[11px] font-medium whitespace-nowrap max-w-[200px] bg-[var(--nim-bg-secondary)] border cursor-default ${readOnlyFlagged ? 'model-selector-button-unavailable text-[var(--nim-warning,#b45309)] border-[var(--nim-warning,#b45309)]' : 'text-[var(--nim-text-muted)] border-[var(--nim-border)]'}`}
          aria-label={
            readOnlyFlagged
              ? `Current model unavailable: ${getCurrentModelName()}`
              : `Current model: ${getCurrentModelName()}`
          }
          data-testid="model-picker"
          title={
            currentModelHidden
              ? 'You hid this model in Settings.'
              : currentModelMissing
                ? `"${currentModel}" is no longer offered by its provider.`
                : readOnlyTitle
          }
        >
          {readOnlyFlagged && (
            <MaterialSymbol icon="warning" size={12} className="shrink-0" data-testid="model-picker-unavailable-icon" />
          )}
          <span className="model-selector-label overflow-hidden text-ellipsis">{getCurrentModelName()}</span>
        </span>
      </div>
    );
  }

  return (
    <div className="model-selector inline-block">
      <button
        ref={refs.setReference}
        className={`model-selector-button flex items-center gap-1 px-2 py-[3px] rounded-xl text-[11px] font-medium cursor-pointer transition-all duration-200 outline-none whitespace-nowrap max-w-[200px] bg-[var(--nim-bg-secondary)] border hover:bg-[var(--nim-bg-hover)] ${currentModelMissing ? 'model-selector-button-unavailable text-[var(--nim-warning,#b45309)] border-[var(--nim-warning,#b45309)]' : 'text-[var(--nim-text-muted)] border-[var(--nim-border)] hover:border-[var(--nim-primary)]'}`}
        aria-label={
          currentModelMissing
            ? `Current model unavailable: ${getCurrentModelName()}`
            : `Current model: ${getCurrentModelName()}`
        }
        title={
          currentModelMissing
            ? `"${currentModel}" is no longer offered by its provider. Pick another model — sending will fail until you do.`
            : currentModelHidden
              ? `You hid this model in Settings. Pick another model, or unhide it, to keep sending.`
              : undefined
        }
        data-testid="model-picker"
        {...getReferenceProps({
          onClick: () =>
            setIsOpen(open => {
              const next = !open;
              // Refetch on open: the preload effect only reruns when
              // `providers` changes, but a locally-discovered catalog
              // (Antigravity) can become reachable while the window stays up.
              if (next) void loadModels();
              return next;
            }),
        })}
      >
        {(currentModelMissing || currentModelHidden) && (
          <MaterialSymbol icon="warning" size={12} className="shrink-0" data-testid="model-picker-unavailable-icon" />
        )}
        <span className="model-selector-label overflow-hidden text-ellipsis">{getCurrentModelName()}</span>
        <MaterialSymbol icon="expand_more" size={14} className={`model-selector-arrow transition-transform duration-200 shrink-0 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <FloatingPortal>
          <div
            ref={setMenuReference}
            className="model-selector-dropdown nim-scrollbar min-w-[240px] max-w-[320px] max-h-[min(400px,calc(100vh-24px))] overflow-y-auto rounded-lg p-1 z-[1000] bg-[var(--nim-bg)] border border-[var(--nim-border)] shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
            style={floatingStyles}
            tabIndex={-1}
            {...getFloatingProps({ onKeyDown: handleMenuKeyDown })}
          >
          {loading ? (
            <div className="model-selector-loading p-3 text-center text-xs text-[var(--nim-text-faint)]">Loading models...</div>
          ) : Object.keys(visibleModels).length === 0 ? (
            <div className="model-selector-empty p-3 text-center text-xs text-[var(--nim-text-faint)]">No models available</div>
          ) : (
            <>
              {/* Agents Section */}
              {groupedProviders.agents && Object.keys(groupedProviders.agents).length > 0 && (
                <>
                  <div className="model-selector-section-header px-2 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--nim-text-faint)]">Agents</div>
                  {isSectionDisabled('agent') && (
                    <div className="model-selector-disabled-notice px-2 pt-1 pb-1.5 text-[11px] italic text-[var(--nim-text-faint)]">
                      Start a new session to use agents
                    </div>
                  )}
                  {orphanedHealthProviders.map(provider => (
                    <div key={`orphan-${provider}`} className="model-selector-provider-group mb-1">
                      <div className="model-selector-provider-header flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-[var(--nim-text-muted)]">
                        {renderProviderIcon(provider, 12)}
                        {getProviderLabel(provider)}
                      </div>
                      {renderProviderHealthNotice(provider)}
                    </div>
                  ))}
                  {Object.entries(groupedProviders.agents).map(([provider, providerModels]) => (
                    <div key={provider} className="model-selector-provider-group mb-1">
                      {/* Hover help (NIM-825): providers with a
                          model-picker-provider-<id> HelpContent entry get a
                          tooltip explaining what they are (e.g. Claude Agent
                          vs Claude Code CLI); others render unchanged. */}
                      <HelpTooltip testId={`model-picker-provider-${provider}`} placement="right">
                        <div
                          className="model-selector-provider-header flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-[var(--nim-text-muted)]"
                          data-testid={`model-picker-provider-${provider}`}
                        >
                          {renderProviderIcon(provider, 12)}
                          <span>{getProviderLabel(provider)}</span>
                          {ALPHA_PROVIDERS.has(provider) && <AlphaBadge size="xs" />}
                        </div>
                      </HelpTooltip>
                      {renderProviderHealthNotice(provider)}
                      {providerModels.map(model => {
                        const isCurrent = model.id === currentModel;
                        const isDisabled = isProviderSwitchDisabled(provider);
                        const disabledTooltip = 'Start a new session to switch providers after the session has started';
                        // Separate from isDisabled, which is the unrelated
                        // mid-session provider lock. This stays selectable.
                        const isUnavailable = model.unavailable === true;
                        const unavailableTooltip =
                          'Not currently offered by this provider. It is listed because it is still selected somewhere.';
                        return (
                          <button
                            key={model.id}
                            className={`model-selector-option flex items-center justify-between gap-2 pl-6 pr-2 py-1.5 w-full border-none rounded text-xs cursor-pointer transition-[background] duration-150 text-left text-[var(--nim-text)] ${isCurrent ? 'selected bg-[var(--nim-bg-secondary)] text-[var(--nim-primary)]' : ''} ${isDisabled ? 'disabled opacity-50 cursor-not-allowed' : 'hover:bg-[var(--nim-bg-hover)]'}`}
                            onClick={() => !isDisabled && handleModelSelect(model.id)}
                            onKeyDown={handleOptionKeyDown}
                            title={isDisabled ? disabledTooltip : isUnavailable ? unavailableTooltip : undefined}
                            aria-disabled={isDisabled}
                            data-model-id={model.id}
                            data-model-name={model.name}
                          >
                            <span className={`model-selector-option-name flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${isDisabled || isUnavailable ? 'text-[var(--nim-text-faint)]' : ''}`}>
                              {model.name}
                              {isUnavailable && (
                                <span className="model-selector-option-unavailable ml-1 text-[10px] italic">(unavailable)</span>
                              )}
                            </span>
                            {isDisabled ? (
                              <MaterialSymbol icon="block" size={14} className="disabled-icon text-[var(--nim-text-faint)]" />
                            ) : isCurrent ? (
                              <MaterialSymbol icon="check" size={14} />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </>
              )}

              {/* Chat with open document Section */}
              {groupedProviders.models && Object.keys(groupedProviders.models).length > 0 && (
                <>
                  {groupedProviders.agents && Object.keys(groupedProviders.agents).length > 0 && (
                    <div className="model-selector-divider h-px my-1 bg-[var(--nim-border)]" />
                  )}
                  <div className="model-selector-section-header px-2 pt-1.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.5px] text-[var(--nim-text-faint)]">Chat with open document</div>
                  {isSectionDisabled('model') && (
                    <div className="model-selector-disabled-notice px-2 pt-1 pb-1.5 text-[11px] italic text-[var(--nim-text-faint)]">
                      Start a new session to use chat models
                    </div>
                  )}
                  {Object.entries(groupedProviders.models).map(([provider, providerModels]) => (
                    <div key={provider} className="model-selector-provider-group mb-1">
                      <div className="model-selector-provider-header flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-[var(--nim-text-muted)]">
                        {renderProviderIcon(provider, 12)}
                        {getProviderLabel(provider)}
                      </div>
                      {renderProviderHealthNotice(provider)}
                      {providerModels.map(model => {
                        const isCurrent = model.id === currentModel;
                        const isDisabled = isProviderSwitchDisabled(provider);
                        const disabledTooltip = 'Start a new session to switch providers after the session has started';
                        const isUnavailable = model.unavailable === true;
                        const unavailableTooltip =
                          'Not currently offered by this provider. It is listed because it is still selected somewhere.';
                        return (
                          <button
                            key={model.id}
                            className={`model-selector-option flex items-center justify-between gap-2 pl-6 pr-2 py-1.5 w-full border-none rounded text-xs cursor-pointer transition-[background] duration-150 text-left text-[var(--nim-text)] ${isCurrent ? 'selected bg-[var(--nim-bg-secondary)] text-[var(--nim-primary)]' : ''} ${isDisabled ? 'disabled opacity-50 cursor-not-allowed' : 'hover:bg-[var(--nim-bg-hover)]'}`}
                            onClick={() => !isDisabled && handleModelSelect(model.id)}
                            onKeyDown={handleOptionKeyDown}
                            title={isDisabled ? disabledTooltip : isUnavailable ? unavailableTooltip : undefined}
                            aria-disabled={isDisabled}
                            data-model-id={model.id}
                            data-model-name={model.name}
                          >
                            <span className={`model-selector-option-name flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${isDisabled || isUnavailable ? 'text-[var(--nim-text-faint)]' : ''}`}>
                              {model.name}
                              {isUnavailable && (
                                <span className="model-selector-option-unavailable ml-1 text-[10px] italic">(unavailable)</span>
                              )}
                            </span>
                            {isDisabled ? (
                              <MaterialSymbol icon="block" size={14} className="disabled-icon text-[var(--nim-text-faint)]" />
                            ) : isCurrent ? (
                              <MaterialSymbol icon="check" size={14} />
                            ) : null}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </>
              )}

              {/* Configure Models */}
              <div className="model-selector-divider h-px my-1 bg-[var(--nim-border)]" />
              <button
                className="model-selector-configure flex items-center gap-2 px-2 py-1.5 w-full bg-transparent border-none rounded text-xs cursor-pointer transition-[background] duration-150 text-left text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
                onClick={handleConfigureModels}
              >
                <MaterialSymbol icon="settings" size={14} />
                <span>Configure models</span>
              </button>
            </>
          )}
          </div>
        </FloatingPortal>
      )}
    </div>
  );
}

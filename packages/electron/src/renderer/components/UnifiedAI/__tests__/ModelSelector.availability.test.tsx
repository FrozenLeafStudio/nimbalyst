// @vitest-environment jsdom
/**
 * Does the picker tell the truth about whether the selected model still exists?
 *
 * The bug these cover: a session pinned to a model its provider no longer
 * offers rendered as an ordinary model name, because getCurrentModelName()
 * fell back to stripping the provider prefix. Nothing warned until the user
 * typed a prompt and the turn failed.
 *
 * The second half is the risk the fix introduces. "Not in the catalog" is also
 * true before the catalog arrives, and true for every model when the provider
 * is degraded. Warning in either case would be worse than the original bug, so
 * those negative cases are tested as carefully as the positive one.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from '../ModelSelector';
import { aiProviderSettingsAtom } from '../../../store/atoms/appSettings';

vi.mock('@floating-ui/react', () => ({
  autoUpdate: vi.fn(),
  flip: vi.fn(() => ({ name: 'flip' })),
  offset: vi.fn(() => ({ name: 'offset' })),
  shift: vi.fn(() => ({ name: 'shift' })),
  size: vi.fn(() => ({ name: 'size' })),
  FloatingPortal: ({ children }: { children: React.ReactNode }) => children,
  useDismiss: vi.fn(() => ({})),
  useRole: vi.fn(() => ({})),
  useInteractions: vi.fn(() => ({
    getReferenceProps: (p: Record<string, unknown> = {}) => p,
    getFloatingProps: (p: Record<string, unknown> = {}) => p,
  })),
  useFloating: vi.fn(() => ({
    refs: { setReference: vi.fn(), setFloating: vi.fn() },
    floatingStyles: {},
    context: {},
  })),
}));

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: ({ icon, ...rest }: { icon: string } & Record<string, unknown>) => (
    <span data-icon={icon} {...rest} />
  ),
}));
vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', () => ({ getProviderIcon: () => null }));
vi.mock('@nimbalyst/runtime/ui/floating/windowControlsClearance', () => ({
  windowControlsClearance: () => ({ name: 'clearance' }),
}));
vi.mock('../../common/AlphaBadge', () => ({ AlphaBadge: () => null }));
vi.mock('../../../help', () => ({
  HelpTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const GEMINI = 'antigravity-gemini-agent';
const DEAD_ID = `${GEMINI}:gemini-3.8-flash-high`;
const LIVE_ID = `${GEMINI}:gemini-3.6-flash-high`;

type Health = { state: 'ok' | 'degraded'; reason?: string; detail?: string; retryable?: boolean };

/** Never resolves, so the pre-fetch window can be observed deliberately. */
const PENDING = new Promise<never>(() => {});

function mockGetModels(opts: {
  grouped?: Record<string, Array<{ id: string; name: string; provider: string; unavailable?: boolean }>>;
  providerHealth?: Record<string, Health>;
  pending?: boolean;
}) {
  const aiGetModels = vi.fn(() =>
    opts.pending
      ? PENDING
      : Promise.resolve({
          success: true,
          grouped: opts.grouped ?? {},
          providerLabels: {},
          providerIcons: {},
          providerHealth: opts.providerHealth ?? {},
        }),
  );
  (window as unknown as { electronAPI: unknown }).electronAPI = { aiGetModels };
  return aiGetModels;
}

function renderPicker(currentModel: string) {
  return render(
    <JotaiProvider store={createStore()}>
      <ModelSelector currentModel={currentModel} onModelChange={vi.fn()} />
    </JotaiProvider>,
  );
}

/**
 * The health notice lives inside the dropdown, so it only exists once the menu
 * is open. Open it the way a user would rather than reaching into state.
 */
async function openPicker() {
  const chip = await screen.findByTestId('model-picker');
  fireEvent.click(chip);
  return chip;
}

const liveCatalog = {
  [GEMINI]: [{ id: LIVE_ID, name: 'Gemini 3.6 Flash (High)', provider: GEMINI }],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the selected model is gone', () => {
  it('marks the chip when a healthy catalog does not contain it', async () => {
    mockGetModels({ grouped: liveCatalog });

    renderPicker(DEAD_ID);

    await waitFor(() => {
      expect(screen.getByTestId('model-picker-unavailable-icon')).toBeTruthy();
    });
    const chip = screen.getByTestId('model-picker');
    expect(chip.getAttribute('aria-label')).toMatch(/unavailable/i);
  });

  it('names the missing id in the tooltip, so the cause is not a guess', async () => {
    mockGetModels({ grouped: liveCatalog });

    renderPicker(DEAD_ID);

    await waitFor(() => {
      expect(screen.getByTestId('model-picker').getAttribute('title')).toContain(DEAD_ID);
    });
  });

  it('leaves a model that IS in the catalog completely unmarked', async () => {
    mockGetModels({ grouped: liveCatalog });

    renderPicker(LIVE_ID);

    await waitFor(() => {
      expect(screen.getByTestId('model-picker')).toBeTruthy();
    });
    expect(screen.queryByTestId('model-picker-unavailable-icon')).toBeNull();
    expect(screen.getByTestId('model-picker').getAttribute('aria-label')).not.toMatch(/unavailable/i);
  });
});

describe('reporting availability to the composer', () => {
  /**
   * The composer cannot work this out itself -- the picker owns the catalog and
   * the loading state. It needs the answer to refuse a turn that would fail.
   */
  it('reports "withdrawn" once a trustworthy catalog is missing the selection', async () => {
    const onAvailabilityChange = vi.fn();
    mockGetModels({ grouped: liveCatalog });

    render(
      <JotaiProvider store={createStore()}>
        <ModelSelector
          currentModel={DEAD_ID}
          onModelChange={vi.fn()}
          onAvailabilityChange={onAvailabilityChange}
        />
      </JotaiProvider>,
    );

    await waitFor(() => {
      expect(onAvailabilityChange).toHaveBeenCalledWith('withdrawn');
    });
  });

  it('never reports a problem while the catalog is still loading', async () => {
    const onAvailabilityChange = vi.fn();
    mockGetModels({ pending: true });

    render(
      <JotaiProvider store={createStore()}>
        <ModelSelector
          currentModel={DEAD_ID}
          onModelChange={vi.fn()}
          onAvailabilityChange={onAvailabilityChange}
        />
      </JotaiProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('model-picker')).toBeTruthy();
    });
    // Blocking the composer on a not-yet-loaded catalog would lock the user out
    // of their own session for no reason.
    expect(onAvailabilityChange).not.toHaveBeenCalledWith('withdrawn');
  });

  it('reports null for a healthy selection', async () => {
    const onAvailabilityChange = vi.fn();
    mockGetModels({ grouped: liveCatalog });

    render(
      <JotaiProvider store={createStore()}>
        <ModelSelector
          currentModel={LIVE_ID}
          onModelChange={vi.fn()}
          onAvailabilityChange={onAvailabilityChange}
        />
      </JotaiProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('model-picker')).toBeTruthy();
    });
    // Asserting on the reason, not just "not true" -- the callback no longer
    // takes a boolean, so a stale `not.toHaveBeenCalledWith(true)` would pass
    // no matter what the component did.
    expect(onAvailabilityChange).toHaveBeenCalledWith(null);
    expect(onAvailabilityChange).not.toHaveBeenCalledWith('withdrawn');
    expect(onAvailabilityChange).not.toHaveBeenCalledWith('hidden');
  });
});

describe('a model the user hid in Settings', () => {
  /**
   * Hiding is the user's own action, so "no longer offered by its provider"
   * would be a lie. The turn is still refused -- they asked for the model to be
   * gone -- but the reason has to name what actually happened.
   */
  function renderWithHidden(hidden: string[], currentModel: string, onAvailabilityChange = vi.fn()) {
    const store = createStore();
    store.set(aiProviderSettingsAtom, {
      ...store.get(aiProviderSettingsAtom),
      providers: {
        ...store.get(aiProviderSettingsAtom).providers,
        [GEMINI]: { enabled: true, hiddenModels: hidden },
      },
    } as never);
    render(
      <JotaiProvider store={store}>
        <ModelSelector
          currentModel={currentModel}
          onModelChange={vi.fn()}
          onAvailabilityChange={onAvailabilityChange}
        />
      </JotaiProvider>,
    );
    return onAvailabilityChange;
  }

  it('reports "hidden", not "withdrawn"', async () => {
    mockGetModels({ grouped: liveCatalog });
    const onAvailabilityChange = renderWithHidden([DEAD_ID], DEAD_ID);

    await waitFor(() => {
      expect(onAvailabilityChange).toHaveBeenCalledWith('hidden');
    });
    expect(onAvailabilityChange).not.toHaveBeenCalledWith('withdrawn');
  });

  it('still reports "withdrawn" for a model nobody hid', async () => {
    mockGetModels({ grouped: liveCatalog });
    const onAvailabilityChange = renderWithHidden([], DEAD_ID);

    await waitFor(() => {
      expect(onAvailabilityChange).toHaveBeenCalledWith('withdrawn');
    });
    expect(onAvailabilityChange).not.toHaveBeenCalledWith('hidden');
  });

  it('leaves a hidden model that is not the current selection alone', async () => {
    mockGetModels({ grouped: liveCatalog });
    const onAvailabilityChange = renderWithHidden([DEAD_ID], LIVE_ID);

    await waitFor(() => {
      expect(screen.getByTestId('model-picker')).toBeTruthy();
    });
    expect(onAvailabilityChange).toHaveBeenCalledWith(null);
  });
});

describe('cases that must NOT warn', () => {
  /**
   * The regression this fix could most easily introduce. The preload effect
   * clears the catalog and refetches, so between mount and response every
   * model is "missing".
   */
  it('stays silent while the catalog is still loading', async () => {
    mockGetModels({ pending: true });

    renderPicker(DEAD_ID);

    await waitFor(() => {
      expect(screen.getByTestId('model-picker')).toBeTruthy();
    });
    expect(screen.queryByTestId('model-picker-unavailable-icon')).toBeNull();
  });

  it('stays silent on an empty catalog, which means we learned nothing', async () => {
    mockGetModels({ grouped: {} });

    renderPicker(DEAD_ID);

    await waitFor(() => {
      expect(screen.getByTestId('model-picker')).toBeTruthy();
    });
    expect(screen.queryByTestId('model-picker-unavailable-icon')).toBeNull();
  });

  it('stays silent when the owning provider is degraded', async () => {
    // Everything looks absent under a degraded catalog; claiming the selection
    // is gone would turn a partial outage into a false report.
    mockGetModels({
      grouped: liveCatalog,
      providerHealth: {
        [GEMINI]: { state: 'degraded', reason: 'version-gated', detail: 'Antigravity rejected this build.' },
      },
    });

    renderPicker(DEAD_ID);
    await openPicker();

    await waitFor(() => {
      expect(screen.getByTestId(`model-health-${GEMINI}`)).toBeTruthy();
    });
    expect(screen.queryByTestId('model-picker-unavailable-icon')).toBeNull();
  });
});

describe('a model flagged unavailable by its provider', () => {
  /**
   * `AIModel.unavailable` has existed since #916 and OpenCode sets it today,
   * but nothing rendered it -- a flagged model looked identical to a working
   * one. This is the consumer that was missing.
   */
  it('is labelled in the menu rather than looking like any other model', async () => {
    mockGetModels({
      grouped: {
        [GEMINI]: [
          { id: LIVE_ID, name: 'Gemini 3.6 Flash (High)', provider: GEMINI },
          { id: DEAD_ID, name: 'gemini-3.8-flash-high', provider: GEMINI, unavailable: true },
        ],
      },
    });

    renderPicker(LIVE_ID);
    await openPicker();

    const row = await waitFor(() => {
      const el = document.querySelector(`[data-model-id="${DEAD_ID}"]`);
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(row.textContent).toContain('(unavailable)');
  });

  it('stays selectable, because a selection must never be silently erased', async () => {
    const onModelChange = vi.fn();
    mockGetModels({
      grouped: {
        [GEMINI]: [
          { id: DEAD_ID, name: 'gemini-3.8-flash-high', provider: GEMINI, unavailable: true },
        ],
      },
    });

    render(
      <JotaiProvider store={createStore()}>
        <ModelSelector currentModel={LIVE_ID} onModelChange={onModelChange} />
      </JotaiProvider>,
    );
    await openPicker();

    const row = await waitFor(() => {
      const el = document.querySelector(`[data-model-id="${DEAD_ID}"]`);
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(row.getAttribute('aria-disabled')).not.toBe('true');
  });
});

describe('degraded catalog notice', () => {
  it('explains the cause instead of showing a short list as a complete one', async () => {
    mockGetModels({
      grouped: liveCatalog,
      providerHealth: {
        [GEMINI]: {
          state: 'degraded',
          reason: 'not-installed',
          detail: 'Antigravity is not installed, so no models could be discovered.',
          retryable: false,
        },
      },
    });

    renderPicker(LIVE_ID);
    await openPicker();

    const notice = await screen.findByTestId(`model-health-${GEMINI}`);
    expect(notice.textContent).toContain('Antigravity is not installed');
  });

  it('offers a retry only when retrying could plausibly help', async () => {
    mockGetModels({
      grouped: liveCatalog,
      providerHealth: {
        [GEMINI]: { state: 'degraded', reason: 'version-gated', detail: 'Out of date.', retryable: false },
      },
    });

    renderPicker(LIVE_ID);
    await openPicker();

    const notice = await screen.findByTestId(`model-health-${GEMINI}`);
    expect(notice.textContent).not.toContain('Retry');
  });

  it('offers a retry when retrying could help, and refetches on click', async () => {
    const aiGetModels = mockGetModels({
      grouped: liveCatalog,
      providerHealth: {
        [GEMINI]: {
          state: 'degraded',
          reason: 'not-running',
          detail: 'Could not reach the Antigravity language server.',
          retryable: true,
        },
      },
    });

    renderPicker(LIVE_ID);
    await openPicker();

    const notice = await screen.findByTestId(`model-health-${GEMINI}`);
    const retry = notice.querySelector('.model-selector-health-retry') as HTMLElement | null;
    expect(retry, 'a retryable failure must offer a retry').toBeTruthy();

    const before = aiGetModels.mock.calls.length;
    fireEvent.click(retry!);
    await waitFor(() => {
      expect(aiGetModels.mock.calls.length).toBeGreaterThan(before);
    });
  });

  /**
   * Scenario 4 from manual testing: with Antigravity uninstalled the provider
   * auto-disables and drops out of the catalog entirely, so the group that
   * would have carried the notice does not exist. The user saw a yellow chip
   * and no explanation anywhere.
   */
  it('still explains a degraded provider that contributes no models at all', async () => {
    mockGetModels({
      grouped: { 'claude-code': [{ id: 'claude-code:opus', name: 'Opus', provider: 'claude-code' }] },
      providerHealth: {
        [GEMINI]: {
          state: 'degraded',
          reason: 'not-installed',
          detail: 'Antigravity is not installed. Install it from https://antigravity.google',
          retryable: false,
        },
      },
    });

    renderPicker(DEAD_ID);
    await openPicker();

    const notice = await screen.findByTestId(`model-health-${GEMINI}`);
    expect(notice.textContent).toContain('Antigravity is not installed');
  });

  it('does not nag about a missing provider the user is not using', async () => {
    // Same degraded provider, but the current selection belongs to someone
    // else. Showing it here would be noise, and noise is what teaches people
    // to ignore warnings.
    mockGetModels({
      grouped: { 'claude-code': [{ id: 'claude-code:opus', name: 'Opus', provider: 'claude-code' }] },
      providerHealth: {
        [GEMINI]: { state: 'degraded', reason: 'not-installed', detail: 'Antigravity is not installed.' },
      },
    });

    renderPicker('claude-code:opus');
    await openPicker();

    await waitFor(() => {
      expect(screen.getByTestId('model-picker')).toBeTruthy();
    });
    expect(screen.queryByTestId(`model-health-${GEMINI}`)).toBeNull();
  });

  it('shows no notice at all when every provider is healthy', async () => {
    mockGetModels({ grouped: liveCatalog, providerHealth: {} });

    renderPicker(LIVE_ID);
    await openPicker();

    await waitFor(() => {
      expect(screen.getByTestId('model-picker')).toBeTruthy();
    });
    expect(screen.queryByTestId(`model-health-${GEMINI}`)).toBeNull();
  });
});

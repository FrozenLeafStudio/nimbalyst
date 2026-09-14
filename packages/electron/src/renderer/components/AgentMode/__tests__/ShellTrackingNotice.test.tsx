import React from 'react';
import { it, expect, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { ShellTrackingNotice } from '../ShellTrackingNotice';

it('refreshes coverage for the selected scope and ignores late responses from an old session', async () => {
  const original = window.electronAPI;
  let finishOld!: (value: any) => void;
  let update!: (id: string) => void;
  const invoke = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        })
    )
    .mockResolvedValueOnce([{ sessionId: 'b', state: 'no-detected-fault', reasons: {}, turns: [] }]);
  const unsubscribe = vi.fn();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      invoke,
      on: (_: string, fn: typeof update) => {
        update = fn;
        return unsubscribe;
      },
    },
  });
  try {
    const { rerender } = render(<ShellTrackingNotice sessionIds={['a']} />);
    rerender(<ShellTrackingNotice sessionIds={['b']} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    finishOld([{ sessionId: 'a', state: 'degraded', reasons: { quota: 1 }, turns: [] }]);
    await Promise.resolve();
    expect(screen.queryByTestId('shell-tracking-notice')).toBeNull();
    invoke.mockResolvedValueOnce([
      { sessionId: 'b', state: 'degraded', reasons: { persistence: 1 }, turns: [] },
    ]);
    update('b');
    await screen.findByText('File tracking incomplete');
    expect(screen.getByText('File links could not be saved.')).toBeDefined();
    expect(screen.queryByText('The session reached its file tracking limit.')).toBeNull();
  } finally {
    cleanup();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: original });
  }
});

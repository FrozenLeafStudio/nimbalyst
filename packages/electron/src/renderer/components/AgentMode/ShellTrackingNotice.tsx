import React, { useEffect, useState } from 'react';
import { shellCoverageDetails, type ShellCoverageSummary } from '@nimbalyst/runtime/ai/shellTrackingCoverage';

/** Requeries on persisted link/coverage updates; old requests cannot replace a new scope. */
export function ShellTrackingNotice({ sessionIds }: { sessionIds: string[] }) {
  const key = [...new Set(sessionIds)].sort().join(',');
  const [coverage, setCoverage] = useState<ShellCoverageSummary[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const ids = key ? key.split(',') : [];
    let disposed = false;
    let version = 0;
    const load = async () => {
      const request = ++version;
      try {
        const result = await window.electronAPI.invoke('session-files:coverage', ids);
        if (!disposed && request === version) {
          setCoverage(result);
          setFailed(false);
        }
      } catch {
        if (!disposed && request === version) {
          setCoverage([]);
          setFailed(true);
        }
      }
    };
    setCoverage([]);
    setFailed(false);
    void load();
    const unsubscribe = window.electronAPI.on('session-files:updated', (id: string) => {
      if (ids.includes(id)) void load();
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [key]);
  const details = shellCoverageDetails(coverage);
  if (!failed && !details.length) return null;
  return (
    <details
      className="px-3 py-2 text-xs border-b border-[var(--nim-border)] text-[var(--nim-text-secondary)]"
      data-testid="shell-tracking-notice"
    >
      <summary className="cursor-pointer">
        {failed ? 'File tracking status unavailable' : 'File tracking incomplete'}
      </summary>
      <p className="mt-2">Some edits may be missing from this list. Review your changes before committing.</p>
      {details.length > 0 && (
        <ul className="mt-1 list-disc pl-4">
          {details.map((detail) => (
            <li key={detail}>{detail}.</li>
          ))}
        </ul>
      )}
    </details>
  );
}

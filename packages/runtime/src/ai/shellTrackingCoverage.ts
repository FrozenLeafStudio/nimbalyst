/** Instrumentation health is separate from inferred file ownership. */
export const shellCoverageReasons = {
  missingPre: 'Tool ran without an acknowledged tracking hook',
  unmatchedTool: 'Tool tracking ended without a completion signal',
  staleEvent: 'Late or contradictory tool events were ignored',
  suspiciousWindow: 'A tool tracking window could not be reconciled',
  interrupted: 'Tracking was interrupted before its turn finished',
  unavailable: 'Shell tracking could not start',
  watcherLoss: 'The workspace file watcher was interrupted',
  hookFailure: 'A tracking hook could not be delivered',
  overlap: 'Concurrent activity made ownership uncertain',
  uninstrumented: 'Another active session was not instrumented',
  overflow: 'Tracking exceeded its bounded capacity',
  throttled: 'File links could not be saved within the rate limit',
  quota: 'The session reached its file tracking limit',
  persistence: 'File links could not be saved',
  readFailure: 'Changed files could not be inspected',
  drainTimeout: 'Tracking did not finish draining',
  coveragePersistence: 'Tracking diagnostics could not be saved',
  excluded: 'Unsupported or excluded file events were skipped',
  knownWrite: 'Known editor writes were excluded',
} as const;
export type ShellCoverageReason = keyof typeof shellCoverageReasons;
export type ShellCoverageCounts = Partial<Record<ShellCoverageReason, number>>;
export interface ShellCoverageTurn {
  turnId: string;
  firstAt: number;
  lastAt: number;
  reasons: ShellCoverageCounts;
}
export interface ShellCoverageSummary {
  sessionId: string;
  state: 'unknown' | 'no-detected-fault' | 'degraded' | 'unavailable';
  reasons: ShellCoverageCounts;
  firstAt?: number;
  lastAt?: number;
  turns: ShellCoverageTurn[];
}
export function hasShellCoverageGap(reasons: ShellCoverageCounts): boolean {
  return Object.entries(reasons).some(
    ([reason, count]) => count && reason !== 'excluded' && reason !== 'knownWrite'
  );
}
export function shellCoverageDetails(coverage: ShellCoverageSummary[]): string[] {
  const reasons = new Set<ShellCoverageReason>();
  for (const item of coverage)
    for (const reason of Object.keys(item.reasons) as ShellCoverageReason[]) {
      if (reason !== 'excluded' && reason !== 'knownWrite' && item.reasons[reason]) reasons.add(reason);
    }
  return [...reasons].map((reason) => shellCoverageReasons[reason]);
}

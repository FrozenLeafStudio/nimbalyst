# Codex shell file tracking

Codex's native tool hooks delimit execution windows; the shared workspace watcher supplies candidate paths. Links are inferred, preserve their file timestamps, and never establish exclusive ownership of a whole-file diff. Structured edits and known editor saves retain their existing handling. A failed MCP call does not disable later shell tracking: definitive app-server completion retires its window even when the post-hook is missing.

## Lifecycle and recovery

The protocol observer accepts only the root thread and current turn, rejects late events from ended turns, and retains yielded commands until a numeric exit code arrives. The attribution service keeps bounded terminal identities so delayed or duplicate hooks cannot reopen a completed tool. Start notifications without pre-hooks guard against false attribution; they cannot establish an earlier write boundary. Unmatched windows are reported before turn/process cleanup. Old generation cleanup cannot close a new generation.

A five-minute window age produces a diagnostic when subsequent activity arrives; it never proves that a command has stopped. Watcher recovery invalidates cached baselines and suppresses attribution for the affected turn. Future turns can recover normally. Unannounced external writers, detached writes, excluded paths, and uncached deletions remain inference limits.

## Persistence and coverage

File-link persistence returns explicit persisted, excluded, throttled, quota, or failed outcomes. Transient failure and throttling receive at most three attempts, using the same frozen evidence. A candidate is marked recorded only after persistence succeeds. Exhausted retries produce a coverage gap; they do not invent historical content or transfer the event to another tool.

[ShellTrackingCoverage](../packages/electron/src/main/services/ai/ShellTrackingCoverage.ts) maintains cumulative reason counts and the latest 32 turn summaries. These are event counts, not counts of missing files. Known editor saves and deliberate exclusions are separate from tracking faults. Health states are unknown, no detected fault, degraded, and unavailable. No detected fault is not a completeness guarantee.

The local `shell_tracking_coverage` table holds one bounded JSON summary per session and cascades on session deletion. The service creates it lazily on either database engine; SQLite migration 43 also creates the destination before a PGLite cutover, and the migrator copies the records. Session metadata and synchronization are untouched. Per-session writes are serialized and coalesced; load failure must not overwrite previously persisted history. An unfinished turn marker becomes an interruption reason after restart. Earlier gaps survive healthy turns and history compaction.

Database failures stay visible in memory and are retried on later activity or flush. A persistent storage outage cannot guarantee durability; the implementation reports it rather than claiming diagnostics were saved. Commit preparation bounds waiting for accepted file events and terminal cleanup to 1.5 seconds, followed by a separately bounded diagnostics flush. A timeout returns incomplete coverage. Draining cannot recover writes that the watcher never observed.

## User surfaces

The file sidebar reads `session-files:coverage` and refreshes on coalesced `session-files:updated` notifications. Scope changes fence stale responses. A gap displays “File tracking incomplete” with its reasons. Commit context carries the same summary, including when the recorded file list is empty, and tells the agent to reconcile its actual work against current diffs. Git status supplies candidates, not session ownership. Explicit file selection remains authoritative.

## Verification

Focused tests inject missing/late events, failed persistence, throttling, quotas, watcher loss, slow drains, stale turn cleanup, restart, database load failure, and competing UI responses. Real PGLite and SQLite fixtures verify persistence and session-deletion cleanup; a real backend migration verifies coverage survives cutover. The isolated real-Codex Playwright fixture writes before and after an actual failed MCP lookup, verifies sequential session owners and a read-only control, and checks durable coverage and commit context. Run that contract test when the bundled Codex or hook integration changes. Native execution is verified separately per platform.

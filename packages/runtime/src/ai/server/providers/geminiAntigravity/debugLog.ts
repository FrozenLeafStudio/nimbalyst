/**
 * LOCAL DEBUG ONLY -- not for upstream.
 *
 * A structured event log for Gemini/Antigravity turns, written as JSONL when
 * NIMBALYST_GEMINI_DEBUG_LOG names a file. Disabled otherwise, at the cost of
 * one env lookup per call.
 *
 * Why this exists rather than the raw-response log: that one appends after
 * getModelResponse returns, so a turn that TIMES OUT produces no record at all
 * -- which is the case worth diagnosing. Events here bracket the RPC, so a
 * timeout is logged with its prompt size, budget and elapsed time.
 *
 * Events are correlated by turnId. The loop owns the turn; the server manager
 * runs underneath it and has no reference to it, so the id lives in a
 * module-level slot (see below) rather than being threaded through six
 * signatures that would all have to be reverted before a PR.
 */

interface TurnContext {
  turnId: string;
  iteration: number;
}

/**
 * Module-level, not AsyncLocalStorage.
 *
 * The first version used ALS with `enterWith` from the provider. It did not
 * survive: 22 of 24 iterations logged `turnId: null`, because the async
 * generator resumes in a context that never inherited the store. `run()` is no
 * better -- it cannot wrap a generator's whole lifetime.
 *
 * A module-level slot is correct for one turn at a time, which is what the
 * server manager (a singleton) serialises anyway. Two concurrent sessions would
 * interleave and the later turn would win; acceptable for a local debug aid,
 * and visible because turnId would flip mid-sequence.
 */
let current: TurnContext | null = null;

/** Head and tail, because a runaway generation repeats at the END. */
const KEEP_HEAD = 8_000;
const KEEP_TAIL = 8_000;

function logPath(): string | undefined {
  return process.env.NIMBALYST_GEMINI_DEBUG_LOG || undefined;
}

/**
 * Start a turn whose id nested RPC events will carry.
 *
 * Cleared by endTurn() so a later stray event cannot claim a finished turn.
 */
export function beginTurn(turnId: string): void {
  current = { turnId, iteration: 0 };
}

export function endTurn(): void {
  current = null;
}

export function setIteration(n: number): void {
  if (current) current.iteration = n;
}

/**
 * Clamp a payload to head+tail. Truncating only the head hides exactly the
 * repetition that identifies a runaway generation.
 */
export function clampPayload(text: string): string {
  if (text.length <= KEEP_HEAD + KEEP_TAIL) return text;
  const cut = text.length - KEEP_HEAD - KEEP_TAIL;
  return `${text.slice(0, KEEP_HEAD)}\n...[${cut} chars cut]...\n${text.slice(-KEEP_TAIL)}`;
}

export function logEvent(ev: string, data: Record<string, unknown> = {}): void {
  const path = logPath();
  if (!path) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { appendFileSync } = require('fs') as typeof import('fs');
    const line = JSON.stringify({
      t: new Date().toISOString(),
      ev,
      turnId: current?.turnId,
      iteration: current?.iteration,
      ...data,
    });
    appendFileSync(path, line + '\n');
  } catch {
    // Debug logging must never break a turn.
  }
}

/** Wall-clock helper so every duration in the log is measured the same way. */
export function started(): () => number {
  const t0 = Date.now();
  return () => Date.now() - t0;
}

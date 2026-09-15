# Fix the Gemini usage meter

> **Working doc — delete this file before the PR ships.** It exists to hand this
> task to another agent with the investigation already done.

Branch: `fix/gemini-usage-meter`, cut from `origin/main`. Every file below is
byte-identical on `main` and `dev`, so this lands as a standalone PR with no
dependency on the in-flight Gemini Cascade work.

---

## The one-sentence version

The chip reads the wrong RPC. `GetUserStatus` exposes a single per-model quota
fraction; the real data — the same two numbers Antigravity's own Models & Usage
panel shows — lives in **`RetrieveUserQuotaSummary`**, pre-grouped and
pre-labelled by the server. Switch sources and most of the current code deletes
itself.

---

## The correct data source

`RetrieveUserQuotaSummary`, request body `{}`. Verified live against a
Google AI Pro account on 2026-09-14. Real response, trimmed only for length:

```jsonc
{
  "response": {
    "groups": [
      {
        "displayName": "Gemini Models",
        "description": "Models within this group: Gemini Flash, Gemini Pro",
        "buckets": [
          {
            "bucketId": "gemini-weekly",
            "displayName": "Weekly Limit Remaining",
            "description": "You have used some of your weekly limit, it will fully refresh in 21 hours, 56 minutes.",
            "window": "weekly",
            "remainingFraction": 0.7836881,
            "resetTime": "2026-09-15T21:55:32Z"
          },
          {
            "bucketId": "gemini-5h",
            "displayName": "Five Hour Limit Remaining",
            "description": "You have used some of your 5-hour limit, it will fully refresh in 1 hour, 32 minutes.",
            "window": "5h",
            "remainingFraction": 0.8160709,
            "resetTime": "2026-09-15T01:31:25Z"
          }
        ]
      },
      {
        "displayName": "Claude and GPT models",
        "description": "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
        "buckets": [
          { "bucketId": "3p-weekly", "displayName": "Weekly Limit Remaining",    "window": "weekly", "remainingFraction": 1, "resetTime": "2026-09-21T23:59:01Z" },
          { "bucketId": "3p-5h",     "displayName": "Five Hour Limit Remaining", "window": "5h",     "remainingFraction": 1, "resetTime": "2026-09-15T04:59:01Z" }
        ]
      }
    ],
    "description": "Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens. ..."
  }
}
```

Field notes, from the live payload rather than the proto:

- `window` is `"weekly"` or `"5h"`. This is the field to branch on — not array order.
- `remainingFraction` is `0..1` at full precision (7 significant figures). A
  displayed 1% move is a real 1% of quota, not a rounding artifact.
- `resetTime` is ISO8601 **UTC** (`Z` suffix).
- `description` is server-authored, human-readable, and already says
  "refresh in 21 hours, 56 minutes". Render it; do not recompute it.
- `description` was **present on the Gemini buckets and absent on the
  Claude/GPT buckets.** Treat it as optional.
- These numbers match Antigravity's own UI exactly (78% weekly / 82% five-hour),
  which is how the mapping was confirmed.

**Caveat:** this payload is from one account on one tier (Pro). Group
`displayName`s and `bucketId`s on Free/Ultra/Teams are unverified. Code
defensively — match on `window`, tolerate unknown groups, and never index by
position.

---

## What is wrong today

### 1. Both rings show the same number

`AntigravityUsageMeter.getSnapshot()` reads
`userStatus.cascadeModelConfigData.clientModelConfigs[].quotaInfo`, which is
only `{ remainingFraction, resetTime }` per model.

That fraction is **not per-model**. On the probed account, 11 of 14 model
configs returned the identical `0.8160709` / identical reset time — it is the
one shared Gemini five-hour pool, repeated against every Gemini model. The 3
outliers at `1` are the Claude/GPT pool.

`GeminiUsageService.convertSnapshot()` then sorts models by remaining fraction
and labels the lowest "most-constrained model" and the second-lowest
"next-most-constrained". With 11 exact ties that sort is arbitrary among equals,
and **both slots receive the same value.** The popover renders one number twice
under two different headings.

### 2. The time-elapsed bars are invented

`GeminiUsagePopover.tsx:138-139` hardcodes `5 * 60 * 60 * 1000` and
`7 * 24 * 60 * 60 * 1000`, then `calculateTimeElapsedPercent()` (line 36)
derives a window start by subtracting those constants from the server's reset
time. Nothing in the payload reports a window duration. The weekly bucket's real
window is a week, but it is paired against whichever model sorted second — which
may be a five-hour bucket. Delete this math; the server already sends the
sentence you want.

### 3. Refresh cadence makes per-turn attribution impossible

`recordActivity()` (`GeminiUsageService.ts:103`) only refreshes when waking from
sleep:

```js
if (this.isSleeping) { this.isSleeping = false; this.startPolling(); await this.refresh(); }
```

Once awake, a turn just bumps a timestamp. Real refresh is `POLL_INTERVAL_MS`
= **30 minutes** (line 89). So an observed jump cannot be attributed to the
conversation that appeared to cause it. Refresh on turn completion.

### 4. Computed-then-discarded data

- `AntigravityUsageMeter` computes `snapshot.warn`. **Nothing reads it** —
  `convertSnapshot` drops it at the service boundary.
- `convertSnapshot` builds a `credits` block. **The popover never renders it**
  (zero occurrences of `credits` in `GeminiUsagePopover.tsx`). It only affects
  chip visibility, via `geminiUsageAtoms.ts`.
- `tokenUsage` is declared in both the main and renderer interfaces and never
  populated. `geminiUsageAvailableAtom` gates visibility partly on
  `tokenUsage?.totalTokens > 0` — a condition that can never be true.

### 5. Misleading internal names

`GeminiUsageData.fiveHour` / `.sevenDay` are Codex's window names (the file
header says it "mirrors CodexUsageService 1:1"). Today they hold "arbitrary
model A / arbitrary model B". After this fix `fiveHour` becomes genuinely the
5h bucket, but `sevenDay` should be renamed — the real second window is
**weekly**, and Antigravity's own label is "Weekly Limit Remaining".

---

## Trap: the credits fields are vestigial. Do not surface them.

`planStatus` reports `monthlyPromptCredits: 50000` against
`availablePromptCredits: 500`, and `monthlyFlowCredits: 150000` against
`availableFlowCredits: 100`. That reads as "1% of credits left" and
`AntigravityUsageMeter.isLowCredit()` duly sets `warn: true`.

**It is a false alarm, and this cost the previous investigation a wrong
conclusion.** Evidence it is vestigial Codeium/Windsurf plan scaffolding rather
than live Google quota:

- `planInfo` siblings are all Windsurf IDE features: `hasAutocompleteFastMode`,
  `hasTabToJump`, `allowStickyPremiumModels`, `canCustomizeAppIcon`,
  `monthlyFlexCreditPurchaseAmount`. "Flow credits" is Windsurf terminology.
- The live Google-era structure is `userStatus.userTier`
  (`id: g1-pro-tier`, `name: Google AI Pro`), which carries its own separate
  `availableCredits: [{ creditType: GOOGLE_ONE_AI, ... }]`.
- Antigravity's own Models & Usage panel shows healthy quota (78% / 82%) and a
  *disabled* "Enable AI Credit Overages" toggle, with no credit warning.
- `gemini.google.com/usage` independently showed 0% used on both windows.

So `warn` is not merely unused — wiring it up as-is would produce a permanent
false warning. Either drop `isLowCredit`/`warn` entirely, or re-point it at the
real buckets.

---

## What to build

1. **Add `getQuotaSummary()`** to `AntigravityServerManager` alongside
   `getUserStatus()` (same `rpc()` helper, method
   `RetrieveUserQuotaSummary`, body `{}`).
2. **Rewrite `AntigravityUsageMeter`** to return the grouped buckets as its
   snapshot. Drop the per-model `clientModelConfigs` scan and `isLowCredit`.
   Keep `getUsage()` only if something else still needs plan identity.
3. **Simplify `convertSnapshot`**: select the Gemini group, map
   `window === '5h'` → primary and `window === 'weekly'` → secondary. No sorting,
   no tie-breaking. Carry the server's `displayName` and `description` through.
   Rename `sevenDay` → `weekly`.
4. **Strip the invented window math** from `GeminiUsagePopover.tsx`:
   `calculateTimeElapsedPercent`, `sessionWindowMs`, `weeklyWindowMs`,
   `windowDurationMs`. Render the server `description` instead; fall back to a
   relative time off `resetTime` when it is absent (the Claude/GPT buckets).
5. **Refresh on turn completion.** `MessageStreamingHandler.ts:~2970` already
   calls `recordActivity()` per Gemini turn; make that path refresh rather than
   only waking. Keep the 30-minute poll as the idle backstop and keep the
   never-spawn guard (`currentEndpoint() === null`) exactly as it is.
6. **Delete the dead `tokenUsage` field** and its unreachable clause in
   `geminiUsageAvailableAtom`.

Out of scope unless it falls out for free: showing the Claude/GPT group. This is
the *Gemini* chip; Claude has its own.

---

## Verifying against the live server

Read-only, cheap, never spawns anything. The hub must already be running (it is,
after any Gemini turn). Discover the endpoint rather than hardcoding it — the
CSRF token is regenerated per launch:

```powershell
$p = Get-CimInstance Win32_Process -Filter 'Name="language_server.exe"' |
  Where-Object { $_.CommandLine -match '--subclient_type hub' } | Select-Object -First 1
$csrf = if ($p.CommandLine -match '--csrf_token (\S+)') { $matches[1] } else { '' }
$port = Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId |
  Select-Object -ExpandProperty LocalPort -Unique | Sort-Object -Descending | Select-Object -First 1

Invoke-RestMethod -SkipCertificateCheck -Method Post -Body '{}' `
  -Headers @{ 'x-codeium-csrf-token' = $csrf; 'Content-Type' = 'application/json' } `
  -Uri "https://127.0.0.1:$port/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary" |
  ConvertTo-Json -Depth 7
```

Cross-check the result against Antigravity's own **Settings → Models** panel.
They should agree to the percent. That is the acceptance test for the mapping.

---

## Testing

Per `CLAUDE.md`, behavioural changes ship with a unit test, and the test must
fail when the decision is inverted.

- Pure-function coverage on the new bucket mapping is the valuable part: feed
  the recorded payload above as a fixture and assert 5h → primary, weekly →
  secondary, independent of array order. Invert the mapping and confirm red.
- Cover the degenerate shapes: unknown `window`, missing `description`, a group
  with no Gemini bucket, an empty `groups` array.
- Do **not** add presentation tests for ring colours or label strings.
- `packages/electron/src/main/mcp/__tests__/` has the local convention for
  testing an exported pure helper out of a larger main-process module.

Gate before pushing: `npm run typecheck && npm run test:prepush`.

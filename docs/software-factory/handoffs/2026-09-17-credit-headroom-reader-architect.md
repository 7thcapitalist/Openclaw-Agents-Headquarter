# Architect handoff — `credit headroom reader`

## Proposed design

Three pieces, split so the acceptance criteria map directly onto isolated, pure,
easily-tested units — no piece does its own subprocess/filesystem I/O except the
two named "collect" helpers, which are thin and swappable.

### 1. `factory/lib/model-usage-window.mjs` (new — the shared parsing extraction)

```js
export function parseUsageWindow(modelsOut) {
  // returns { shortWindow, weekWindow }, each either
  //   { percentLeft: number, resetIn: string|null }  or  null
}
```

Extracted verbatim from `checkOpenAiSeat` (`scripts/factory-doctor.mjs:32-33`):
the `5h\s+(\d+)%\s+left(?:\s+⏱\s*([^\n·]+))?` regex, unchanged. The `Week`
regex is widened from `Week\s+(\d+)%\s+left` to also capture an optional
`⏱\s*([^\n·]+)` group — the live sample in the product handoff
(`Week 48% left ⏱2d 3h`) shows the CLI already emits this text; today's doctor
simply never reads it because `checkOpenAiSeat`'s `detail` string never needed
a week reset time. Widening the capture group is additive: `week[2]` is a new
optional group, `week[1]` (percent) is untouched, so nothing that already
matched can stop matching or capture a different value.

`scripts/factory-doctor.mjs`'s `checkOpenAiSeat` is refactored to call
`parseUsageWindow(modelsOut)` for its `window5h`/`week` values instead of
inlining the regexes, then keeps its existing cooldown regex and
ok/warn/fail/detail-string logic exactly as-is. Output text and levels are
byte-identical to today — `factory/test/factory-doctor.test.mjs` should pass
unmodified, which is the regression check for "no change to factory-doctor.mjs's
existing check behavior/output text."

### 2. `factory/lib/credit-headroom.mjs` (new — the reader)

A pure core plus two thin I/O helpers, mirroring the dependency-injection style
already used in `factory/lib/hq/activity.mjs` (`buildAgentActivity({ seats = null })`
defaulting to `readConfiguredSeats()`).

**Pure core — no filesystem or subprocess access:**

```js
export function readCreditHeadroom({
  modelsOut,      // string — raw `openclaw models` (or `models status`) output
  pipelineSeats,  // [{ roleId, seat }]     — from collectPipelineSeats()
  seatPauses,     // [{ actor, stage, at }] — from collectRecentSeatPauses()
  now = Date.now(),
  lookbackHours = 24,
}) {
  // returns SeatHeadroomRecord[], one per unique seat in pipelineSeats
}
```

`SeatHeadroomRecord`:

```js
{
  seat: "openai/gpt-5.6-sol",       // cleanSeat()-normalized, from hq/seats.mjs
  roles: ["backend-builder"],        // pipeline role ids currently on this seat
  status: "available" | "unknown",
  shortWindow: { percentLeft, resetIn } | null,
  weekWindow:  { percentLeft, resetIn } | null,
  reason: string | null,             // set only when status === "unknown"
  inference: {                       // set only when status === "unknown"
    basis: "no-recent-seat-exhaustion-events" | "recent-seat-exhaustion-events",
    windowHours: number,
    sampleCount?: number,
    note: string,                    // states plainly that this is inferred, not read
  } | null,
}
```

Logic per unique seat (deduped from `pipelineSeats`, so two roles on one seat
produce one record with `roles: [a, b]`):

- `vendor = seat.split("/")[0]`.
- If `vendor === "openai"` and `parseUsageWindow(modelsOut).shortWindow?.percentLeft`
  is a number: `status: "available"`, `shortWindow`/`weekWindow` copied straight
  from the parse (per the edge case — a week percent with no reset, or vice
  versa, is reported as-is with the missing half `null`; only a missing core
  *percent* forces `unknown`). No `reason`, no `inference` — those fields never
  appear on an available seat.
- Otherwise `status: "unknown"`, `shortWindow: null`, `weekWindow: null`, and a
  `reason` chosen by `describeUnknownReason(seat, modelsOut)`:
  - a per-seat `<seat>...[indeterminate]` (or `...indeterminate`) marker found
    in `modelsOut` → `"openclaw models status reports this seat as [indeterminate]"`.
  - `vendor === "openai"` but the window didn't parse this run (e.g. auth store
    unreadable) → `"openclaw models status did not report a 5h usage window for
    this seat"`.
  - anything else → `"openclaw models status does not report a numeric usage
    window for this seat"`.
  - This never throws and never omits a seat: an empty/garbage `modelsOut`
    just means no marker and no parse, so every non-openai seat (and even an
    openai seat, if its window failed to parse that run) safely falls into the
    generic reason.
- Inference (unknown seats only): filter `seatPauses` to entries whose `actor`
  is one of this seat's `roles` and whose `at` falls within
  `[now - lookbackHours*3600*1000, now]`. This is the seat-exhaustion inference,
  attributed through the **role**, not through any text/provider match on the
  dispatch record — see "seat attribution" below for why.
  - matches found → `{ basis: "recent-seat-exhaustion-events", windowHours,
    sampleCount: matches.length, note: "<n> seatExhausted dispatch(es) recorded
    for role(s) <roles> in the last <windowHours>h — this is an inference from
    the absence/presence of exhaustion events, not a direct read of remaining
    headroom." }`
  - none found → same shape with `basis: "no-recent-seat-exhaustion-events"`
    and a note stating the absence, explicitly labeled as an inference.

**Thin I/O helpers (real wiring point for a later CLI/doctor/dashboard task, not
used by this task's tests except to prove they don't reach into the cost ledger):**

```js
// Config-sourced seat set for configured pipeline roles — reuses hq/seats.mjs
// exactly as-is, no new seat registry.
export function collectPipelineSeats({ configPath } = {}) {
  const { seats, defaultSeat } = readConfiguredSeats({ configPath });
  return Object.keys(seats)
    .map((roleId) => ({ roleId, resolved: resolveSeat({ runtimeAgentId: roleId, runtimeModel: null, seats, defaultSeat }) }))
    .filter((r) => r.resolved?.primary)
    .map((r) => ({ roleId: r.roleId, seat: r.resolved.primary }));
}

// Walks dashboard/backend/data/factory/**/state.json exactly like
// checkFactoryActivity/checkAgentProductivity already do, collecting
// seatExhausted dispatch records. Never throws; unreadable files are skipped.
export function collectRecentSeatPauses({ hqRoot, now = Date.now(), lookbackHours = 24 }) { ... }

// Convenience wrapper: I/O helpers + readCreditHeadroom. Not required by the
// acceptance criteria (no CLI this iteration) but is the obvious call site for
// the doctor/dashboard consumer this task explicitly defers.
export function readPipelineCreditHeadroom({ modelsOut, hqRoot, configPath, now, lookbackHours } = {}) { ... }
```

### Why the seat-exhaustion inference is attributed by role, not by text match

A paused dispatch (`recordSeatPause`, `factory/lib/task-workflow.mjs:495-523`)
is recorded *before* the harness ever ran — there is no `usage.model` /
`usage.provider` on it (those only exist on completed dispatches, see
`checkAgentProductivity`'s `d.usage?.model` read). The only identifying field
is `dispatch.actor`, a **logical role id** (`"architect"`, `"backend-builder"`,
...), not a seat string. So the only sound join is role → seat, via the same
`hq/seats.mjs` config lookup used to build the seat set in the first place.
This directly satisfies the edge case in the product handoff: "two different
OpenAI models are two different seats for this purpose" — matching on the role
that was actually paused, rather than a substring of a provider name, cannot
cross-attribute one seat's exhaustion to a different seat that happens to
share a vendor prefix.

## Files/components likely affected

**New:**
- `factory/lib/model-usage-window.mjs` — shared window/week parsing.
- `factory/lib/credit-headroom.mjs` — the reader (pure core + two I/O helpers).
- `factory/test/model-usage-window.test.mjs`
- `factory/test/credit-headroom.test.mjs`

**Modified:**
- `scripts/factory-doctor.mjs` — `checkOpenAiSeat` calls the extracted parser;
  no output/behavior change.

**Read, not modified (existing sources of truth this reader calls into):**
- `factory/lib/hq/seats.mjs` — `readConfiguredSeats`, `resolveSeat`, `cleanSeat`.
- `factory/lib/task-workflow.mjs` — not imported; only its *output shape*
  (`dispatch.seatExhausted`, `dispatch.actor`, `dispatch.completedAt`) is relied
  on, via the `dashboard/backend/data/factory/**/state.json` files it writes.

**Never imported (verified by a source-scan test — see Verification plan):**
`factory/lib/hq/cost-ledger.mjs`, `factory/lib/hq/company-state.mjs`,
`factory/lib/hq/budget-snapshot.mjs`.

## Key tradeoffs

1. **Global (non-seat-scoped) window parsing, matching today's doctor exactly.**
   `parseUsageWindow` searches the whole `modelsOut` text for one `5h ... left`
   / `Week ... left` pair, the same way `checkOpenAiSeat` already does — it does
   not scope by seat identifier within the text. This is correct for today's
   pipeline (confirmed: exactly one `openai/*` seat, one window pair in the
   output) and keeps the extraction a true reuse rather than a new parser. If a
   second `openai/*` seat is ever added to the pipeline, both would incorrectly
   read the same parsed window. Recorded as a known limitation, not solved here
   — solving it means inventing new per-seat text scoping, which is out of this
   task's "reuse, don't reimplement" boundary.
2. **Pure core + thin I/O wrappers**, rather than one function that shells out
   and reads files itself. Slightly more surface area, but it turns every
   acceptance-criteria case (indeterminate handling, partial-data reporting,
   inference labeling, non-upgrading semantics) into a fast deterministic unit
   test with no `child_process`/`fs` mocking — directly serves "npm run
   test:factory passes" and the "always unknown, never available" proof.
3. **Role-based (not text-based) seat-exhaustion attribution** — see above.
   The alternative (matching on any provider substring in the dispatch record)
   was rejected because it doesn't exist as data and would be exactly the kind
   of cross-match the product handoff calls out as a risk.

## Risks

- The `Week` regex widening is a real (if additive) change to shared parsing
  logic, not just a copy-paste. The concrete mitigation is procedural, not
  architectural: after the refactor, run the existing
  `factory/test/factory-doctor.test.mjs` unmodified and confirm it's still
  green — that test already pins `checkOpenAiSeat`'s exact output strings for
  cooldown/low/ok cases, so any drift the widened regex accidentally introduced
  would fail it immediately.
- The `vendor === "openai"` gate is a stand-in for genuine per-seat text
  scoping (tradeoff #1 above). Low probability of mattering before this module
  gets a real consumer (this task explicitly ships with none), but a future
  task adding a second OpenAI-family seat should revisit `parseUsageWindow`
  before trusting this reader's numbers for that seat.
- `collectRecentSeatPauses` walks every `state.json` under
  `dashboard/backend/data/factory/`, identically to what `checkFactoryActivity`
  and `checkAgentProductivity` already do on every `npm run factory:doctor` run
  today. No new performance class is introduced, but it's the same O(n) walk
  duplicated a third time in this file tree — acceptable per repo convention
  (the two existing checks don't share a walk helper either), not something
  this task should refactor into a shared utility unprompted.

## Verification plan

1. `npm run test:factory` — full suite must stay green (baseline recorded by
   product stage: 1994/1994 passing before this task, see
   `evidence/test-factory-baseline.log` from the product handoff).
2. Targeted: `node --test factory/test/model-usage-window.test.mjs
   factory/test/credit-headroom.test.mjs factory/test/factory-doctor.test.mjs`.
3. New tests to write (mapped 1:1 to acceptance criteria):
   - `model-usage-window.test.mjs`: real-shaped OpenAI text → correct
     percent+resetIn for both windows; missing `⏱` part → percent present,
     `resetIn: null`; no match at all → both windows `null`.
   - `credit-headroom.test.mjs`:
     - openai seat + parseable `modelsOut` → `status: "available"`, correct
       fields, `reason`/`inference` both absent (not just falsy — assert the
       keys carry `null`, matching the documented contract).
     - `anthropic/claude-sonnet-5` seat + `[indeterminate]` text →
       `status: "unknown"`, reason mentions indeterminate.
     - table of malformed/empty/partial `modelsOut` values × every non-openai
       seat → always `"unknown"`, never `"available"`, never a numeric value —
       this is the acceptance criterion "a seat with unreadable headroom is
       always reported as unknown, never as available."
     - inference only ever appears on unknown records; a seat whose role has a
       `seatExhausted` pause inside the lookback window →
       `basis: "recent-seat-exhaustion-events"`; none inside the window →
       `"no-recent-seat-exhaustion-events"`; an available seat's record has
       `inference: null` even when unrelated `seatPauses` exist.
     - two roles on two different unknown seats, only one role has a recent
       pause → inference attaches to that seat's record only (proves the
       role→seat join doesn't cross-match).
     - static source-scan: `readFileSync` both new module files and assert
       none contain the substrings `cost-ledger`, `company-state`, or
       `budget-snapshot` — the deterministic proof that the cost ledger is
       never consulted as a headroom signal.
4. Manual smoke (optional, builder's discretion, not gating): pipe a real
   `openclaw models` run through `readPipelineCreditHeadroom` in a scratch
   script and eyeball it against the three live seats — there's no CLI/dashboard
   wiring in this task's scope to do this automatically.

## Decision Card

None. Every choice above (module location/split, the `openai` vendor gate, the
24h lookback default already set by product, role-based attribution) is a
reversible engineering detail resolvable from the existing codebase, per the
product handoff's own "Open strategic decisions: None." The one limitation
worth a future human's attention (tradeoff #1 / risk #2, the single-OpenAI-seat
assumption) is not a founder-level concern today — it carries no privacy,
spend, public, product-direction, scope, irreversible, security-posture, or
legal weight, since the pipeline has exactly one OpenAI seat in reality — so it
is recorded here rather than escalated.

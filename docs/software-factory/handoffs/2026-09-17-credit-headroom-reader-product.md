# Product handoff — `credit headroom reader`

## Problem
No shared code answers "how much room is left on each model seat before the pipeline stalls." `scripts/factory-doctor.mjs`'s `checkOpenAiSeat` parses `openclaw models` output for the OpenAI seat's 5h/week windows, but that parsing is private to the doctor script and only covers OpenAI. The other two seats in active use — `anthropic/claude-sonnet-5` via the `claude-cli` runtime, and `github-copilot/gpt-4.1` — never report a numeric window at all; `openclaw models status` marks both `[indeterminate]` (confirmed live: `Runtime auth` block shows `status=indeterminate` for `anthropic via claude-cli`, and `Model route issues` lists both `anthropic/claude-sonnet-5` and `github-copilot/gpt-4.1` as `[indeterminate]`). Today nothing distinguishes "we read 12% left" from "we have no idea" — a caller has no way to avoid silently treating an unreadable seat as either exhausted or fully available.

## Desired outcome
A read-only module reports, per pipeline model seat: percent of the short window left, percent of the weekly window left, and time to each reset when the provider gives one — sourced by reusing (not re-deriving) the existing `openclaw models status` parsing in `scripts/factory-doctor.mjs`. A seat whose status can't be parsed (the `claude-cli` seat's permanent `[indeterminate]`, or any other seat `openclaw models status` doesn't emit a percentage for) is reported as `unknown` with an explicit machine-readable reason — never as available, never with a guessed number. For an `unknown` seat, the reader may additionally check `factory/lib/seat-exhaustion.mjs` dispatch records for that seat over a recent window and note the absence of exhaustion events — but that note is always labeled as an inference, distinct from the directly-read fields, and never upgrades the seat's status away from `unknown`. The cost ledger (`factory/lib/hq/company-state.mjs`, `factory/lib/hq/budget-snapshot.mjs`) is never consulted — it tracks spend, not remaining provider quota, and the two have diverged before (see grounding notes).

## Scope

### In
- A shared module (location/internal structure are the architect's call) exposing a read function that, given `openclaw models status` output (or a way to obtain it) and optionally recent dispatch history, returns one record per seat: short-window percent left + reset time, weekly-window percent left + reset time, or `status: "unknown"` + reason, plus an optional labeled inference block.
- Extraction of the window/week percent-and-reset parsing currently inline in `checkOpenAiSeat` (`scripts/factory-doctor.mjs:30-42`) into shared code both the doctor and the new reader call — no second copy of those regexes.
- The seat set is whatever `factory/lib/hq/seats.mjs` (`readConfiguredSeats` / `resolveSeat`) resolves for configured pipeline roles today, not a hardcoded list — so a routing change doesn't silently stop covering a seat.
- The seat-exhaustion inference: for an `unknown` seat, scan recent dispatch records for `seatExhausted: true` entries attributable to that seat (via `factory/lib/seat-exhaustion.mjs`'s existing detection, following the same `dashboard/backend/data/factory/**/state.json` walk pattern `checkFactoryActivity`/`checkAgentProductivity` already use) and, if none found in the window, attach `inference: { basis: "no-recent-seat-exhaustion-events", windowHours: 24, note: "..." }`. A 24h lookback is the default (matching the existing "stale" threshold `checkSessions` already uses in the same file) — a reversible constant, not a contract.
- Tests under `factory/test/` proving: the OpenAI-style path reports correct percents/resets from real-shaped `openclaw models status` text; an indeterminate/unparseable seat always reports `unknown` (never `available`, never a numeric value) across a range of malformed/partial inputs; the inference block only ever appears on `unknown` seats and is visibly labeled as inferred; the cost ledger is never imported or read by this module.
- `npm run test:factory` passes.

### Out
- No CLI entry point and no wiring into `npm run factory:doctor` or a dashboard widget this iteration — this task defines the shared read function; a consumer (doctor, a future `npm run factory:report` field, or a dashboard card) can call it in a later task without re-deriving the parsing.
- No change to `openclaw models status` itself, to `factory-doctor.mjs`'s existing check behavior/output text, to the workflow engine, or to `seat-exhaustion.mjs`'s exported behavior beyond calling it.
- No write path anywhere — this module has no side effects on factory state, sessions, or auth profiles.
- No attempt to make the `claude-cli` seat's readiness determinable by other means (e.g. probing) — its `[indeterminate]` status is a known, permanent characteristic of the synthetic profile (documented in `docs/software-factory/handoffs/2026-09-09-reliability-overhaul.md`), not a bug to work around.

## Grounding notes (confirmed against current code, not assumed)
- Live `openclaw models status` output today: OpenAI shows `openai usage: 5h 100% left ⏱4h 59m · Week 48% left ⏱2d 3h` (exactly what `checkOpenAiSeat`'s regexes already parse). `github-copilot` shows only static auth-profile lines, no percent at all. `Runtime auth` shows `anthropic via claude-cli uses claude-cli ... status=indeterminate`, and `Model route issues` lists `anthropic/claude-sonnet-5 [indeterminate]` and `github-copilot/gpt-4.1 [indeterminate]`. So today there are effectively three seats in play and only one (`openai`) ever has a readable numeric window — the other two must always resolve to `unknown`, which is exactly what the acceptance criteria require and what the tests should pin down.
- `factory/lib/hq/seats.mjs` already resolves "which seat does role X route to" from live runtime + config, and is the existing source of truth for the seat set — reuse it rather than inventing a second seat registry.
- `factory/lib/seat-exhaustion.mjs` already classifies harness errors as `exhausted`/`throttled` and is the only sanctioned inference signal per the constraints; `factory/lib/task-workflow.mjs`'s `recordSeatPause` is the existing writer of `dispatch.seatExhausted` records this reader would scan (read-only).
- Cost ledger code (`factory/lib/hq/company-state.mjs`, `factory/lib/hq/budget-snapshot.mjs`) tracks spend/budget, a materially different signal from remaining provider quota (a seat can be well under budget and still be rate-limited, or vice versa) — this is the basis for the "never a headroom signal" constraint, not an arbitrary exclusion.

## Acceptance criteria
(Founder-specified criteria carried forward verbatim; all confirmed observable and testable against the current codebase during this stage.)

- For the OpenAI seat, reports percent of short window left, percent of weekly window left, and time to each reset, parsed by reusing `scripts/factory-doctor.mjs`'s existing `openclaw models status` parsing rather than a second copy.
- For `claude-cli` seats currently reporting `indeterminate`, reports status `unknown` with an explicit reason, never as available or with a numeric headroom value.
- The only allowed inference for an unknown seat is the absence of seat-exhaustion events (`factory/lib/seat-exhaustion.mjs`) over a recent window, and that result is explicitly labeled as an inference, not a direct read.
- The cost ledger is never used as a headroom signal.
- A test proves that a seat with unreadable headroom is always reported as unknown, never as available.
- `npm run test:factory` passes.

## Edge cases (for architect/builder attention)
- `openclaw models status` output with no seats parseable at all (e.g. auth store unreadable) — every seat must still resolve to `unknown` with a reason, never throw and never omit a seat silently.
- A seat that has partial data (e.g. a week percent but no reset time, or vice versa) — report what's readable, `null` the rest, still `unknown` only if the core percent itself is missing.
- A seat with `seatExhausted` events inside the lookback window — the inference block should reflect that (or be omitted / state "recent exhaustion observed" rather than claiming absence), since the constraint is about not overclaiming availability, not about hiding real signal.
- Seat-name matching between `openclaw models status` seat identifiers (e.g. `anthropic/claude-sonnet-5`) and dispatch-record actor/model fields must not silently cross-match a different seat sharing a provider name (e.g. two different OpenAI models are two different seats for this purpose).

## Non-goals
No CLI, no dashboard UI, no change to `factory-doctor.mjs`'s current output, no workflow-engine change, no new way to determine `claude-cli` readiness, no cost-ledger involvement.

## Open strategic decisions
None. The seat set, the parsing-reuse boundary, the inference window default (24h), and the inference's non-upgrading semantics were all resolvable from the existing codebase (`seats.mjs`, `factory-doctor.mjs`, `seat-exhaustion.mjs`, live `openclaw models status` output) and are recorded above as grounding notes and reversible defaults for the architect, not founder decisions.

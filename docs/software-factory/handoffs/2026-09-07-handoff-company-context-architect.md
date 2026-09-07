# Architect handoff — `handoff company context`

Outcome: route every handoff through `assembleAgentContext()` so project-scoped,
budgeted, redacted company context precedes the existing factory/project pack —
without changing `writeHandoff()`'s signature, the try/catch degradation, or any
JSON schema.

Evidence baseline: `npm run test:factory` → 252 pass / 0 fail on the worktree
branch before any change.

---

## 1. Proposed design

### 1.1 The single production change

In `factory/lib/handoff.mjs`:

1. Replace the import
   `import { assembleContextPack } from "./intel/assemble.mjs";`
   with
   `import { assembleAgentContext } from "./hq/company-context.mjs";`

2. Add `companyState = null` to the destructured options object of
   `writeHandoff(...)`. This is a new **optional property on the existing single
   options object**, not a new positional parameter — arity stays 1 and every
   current call site keeps working unchanged. The product contract explicitly
   frames this as "pass `companyState` through the existing options object
   without changing `writeHandoff()`'s signature".

3. In the existing `try` block, change

   ```js
   contextBlock = `${assembleContextPack({ hqRoot, state }).text}\n\n`;
   ```

   to

   ```js
   contextBlock = `${assembleAgentContext({ hqRoot, state, companyState }).text}\n\n`;
   ```

   The surrounding `try { ... } catch (error) { contextBlock = "## Factory
   context (global)\n\n- ...unavailable: ${error.message}..." }` stays byte-for-byte
   as-is. `assembleAgentContext` calls `assembleContextPack` **first** (before it
   builds the company section), so the one throw path that exists today — a
   structurally broken `factory/projects.json` — still propagates to the same
   `catch` and produces the same fallback block. `buildCompanyContextSection`
   swallows its own fs errors into `warnings` and does not throw, so it cannot
   introduce a new failure mode.

   Optional (cosmetic, non-blocking): widen the fallback wording from
   `project & factory context assembly unavailable` to
   `company, project & factory context assembly unavailable`. The existing test
   asserts `/context assembly unavailable:/`, which still matches. Leave the
   decision to the builder.

No other production file changes. `assembleAgentContext` already returns
`text` = `` `${company.text}\n\n${base.text}` ``, where `company.text` starts
with `## Company context` and `base.text` starts with `## Factory context
(global)`. Prepending is therefore automatic; ordering does not need to be
enforced in `handoff.mjs`.

### 1.2 `companyState` sourcing — explicitly deferred, and that is correct

`buildCompanyState()` (`factory/lib/hq/company-state.mjs`) is `async` and does
read-only GitHub / OpenClaw-runtime / discovery work. `writeHandoff()` is
synchronous and sits on the dispatch hot path (`prepareDispatch`,
`task-initializer`, the concurrent review fan-out). Calling `buildCompanyState`
from inside `writeHandoff` would either require making `writeHandoff` async (a
real signature/contract change, out of scope and prohibited) or block the
dispatch loop on network I/O.

Decision: `companyState` stays an **optional injected input**, default `null`.
When `null`, `buildCompanyContextSection` still emits the durable, offline part
of the section — company mission (from HQ `context/ownership.json` /
`context/MISSION.md`) plus the two isolation guardrail lines — and simply omits
the live per-project signal lines (`Project health`, `Current priority`,
`Current risks`, `Founder decisions pending`). That is a strict improvement over
today (agents currently see none of this) and fully satisfies every acceptance
criterion, all of which are about the wrapper's behaviour, not about a live
feed.

A future task can thread a already-built `companyState` from an async caller
(e.g. `runOneStage` builds it once per run and passes it into
`prepareDispatch → writeHandoff`). No schema or signature change needed then
either — it is the same optional property. Recorded as a follow-up, not a
blocker.

### 1.3 Tests to add (in `factory/test/intel-handoff.test.mjs`)

All assert against the **final rendered handoff file** produced by
`writeHandoff`, i.e. end-to-end through the wrapper. The existing `tempState` /
temp-worktree helpers are reused; a `companyState` literal is passed through the
options object.

1. **Ordering** — `## Company context` appears, and its index is `<` the index
   of `## Factory context (global)`, which is `<` `## Project context:`.
2. **Project isolation** — build with a `companyState` holding two projects
   (the task's project + a decoy `campuscart` with its own priorities, risks,
   and a pending decision). Assert the task-project signals render and
   `assert.doesNotMatch(body, /campuscart/i)`. Mirrors the existing
   `hq-company-context` isolation test but at the handoff layer.
3. **Budget / truncation** — pass a `companyState` whose project row has an
   oversized `intelligencePriorities` / risk-title string (> the 1200-char
   `COMPANY_BUDGET`). Assert the body contains
   `… (company section truncated)` and that the company block length is bounded.
4. **Secret redaction** — embed a secret-shaped token (e.g.
   `AKIA` + 16 uppercase/digits, or `sk-` + 20+ chars) inside a `companyState`
   risk title or decision question, **and** in the HQ `context/ownership.json`
   `mission`. Assert the raw token is absent from the body and
   `[redacted: aws-akia]` (resp. `[redacted: openai-sk]`) is present.
5. **Graceful degradation** — reuse the existing broken-`projects.json` fake-HQ
   setup; assert the handoff still writes, contains
   `/context assembly unavailable:/`, still contains the role prompt, and does
   **not** contain a partial `## Company context` header (the throw happens
   before any block is assembled, so the whole `contextBlock` is the fallback).
6. **companyState omitted** — no `companyState` key at all: assert
   `## Company context` and the company mission line still render, and none of
   the live-signal lines (`Current priority:`, `Project health:`) appear.

The existing three `intel-handoff` tests stay unchanged and must still pass
(they already do after 1.1 because the factory/project pack is delegated
untouched).

## 2. Files / components affected

| Path | Change |
| --- | --- |
| `factory/lib/handoff.mjs` | swap import; add optional `companyState` to options; call `assembleAgentContext` in the existing `try` |
| `factory/test/intel-handoff.test.mjs` | add the 6 cases in §1.3; keep the 3 existing cases |
| `factory/lib/hq/company-context.mjs` | **no change** — used as the tested drop-in wrapper per the constraint |
| `factory/lib/intel/assemble.mjs` | **no change** |
| `factory/lib/common/redact.mjs` | **no change** |
| callers (`openclaw-protocol.mjs`, `openclaw-runner.mjs`, `task-initializer.mjs`) | **no change** — they keep calling `writeHandoff` without `companyState`; behaviour is additive |

## 3. Key tradeoffs

- **Optional-null `companyState` vs. wiring a live feed now.** Chosen: optional.
  Keeps `writeHandoff` sync, keeps the dispatch path off the network, keeps the
  change to ~4 lines, and still delivers the durable company-mission + isolation
  block on every handoff. Cost: live per-project signal lines are dark until a
  follow-up threads `companyState` from an async caller.
- **Wrapper delegation vs. inlining.** Chosen: delegate entirely to
  `assembleAgentContext`. The proven assembler stays the single owner of
  factory/project rendering; `handoff.mjs` gains no branching logic and no
  second copy of budgeting/redaction.
- **Fallback wording.** Leaving the existing string vs. widening it to name the
  company layer. Minor; either passes the regex. Deferred to builder.

## 4. Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| A secret in `companyState` (risk title, decision question) or HQ `context/ownership.json` reaches the handoff file | High | `buildCompanyContextSection` already runs the whole section through `scrubText` (`common/redact.mjs`) before clamping. Test §1.3.4 locks this in at the handoff layer. |
| Cross-project leakage via `companyState.projects` / `.decisions` | Medium | Wrapper filters strictly by the resolved project key (`resolveProjectForState` → `entry.key || state.task.project`). Test §1.3.2 locks it in. |
| New throw path from the company section breaks handoff writing | Medium | `buildCompanyContextSection` catches its own fs errors into `warnings`; `assembleContextPack` runs first inside the wrapper, so the only throw is the pre-existing broken-`projects.json` case already covered by the existing `try/catch` and test §1.3.5. |
| Context-pack bloat in the handoff | Low–Medium | Company section capped at `COMPANY_BUDGET = 1200` chars via `clampSection`; factory/project sections keep their existing `SECTION_BUDGETS`. Net add ≤ ~1.2 KB. Test §1.3.3 verifies the cap. |
| State-dir key (repo basename) vs. registry key mismatch (known project risk) | Low here | This change does not touch key resolution; it reuses `resolveProjectForState` exactly as `assemble.mjs` does today. |
| Silent regression in existing handoff structure | Low | The 3 existing `intel-handoff` tests + full `npm run test:factory` (252 tests) are the gate. |

## 5. Verification plan

1. `npm run test:factory` on the worktree branch — must stay green
   (baseline: 252 pass / 0 fail, captured above). This is the acceptance
   criterion "existing factory test suite remains green".
2. New `intel-handoff.test.mjs` cases §1.3.1–§1.3.6 all pass, each asserting on
   the rendered handoff file.
3. Manual spot check: run `initializeTask` (or the existing
   `task-entrypoints` / `openclaw-integration` flows already in the suite) and
   eyeball a generated `handoff-*.md` — `## Company context` is the first block,
   immediately followed by `## Factory context (global)` then
   `## Project context:`.
4. Grep the generated handoff in the redaction test for the raw secret token —
   must be absent.
5. Confirm `git diff --stat` touches only `factory/lib/handoff.mjs` and
   `factory/test/intel-handoff.test.mjs`.

## 6. Decision Card

None required. The contract is specific, the wrapper is pre-built and tested,
and the one genuine design question (how `companyState` is sourced) resolves to
the reversible, in-scope default of "optional, `null` until a later task threads
it from an async caller" — no product, security, cost, or irreversibility
consequence.

---

## Result

PASS — design is a ~4-line delegation change in `factory/lib/handoff.mjs` plus
six additive handoff tests; no schema, signature, or degradation-path change;
all risks have an existing or specified test.

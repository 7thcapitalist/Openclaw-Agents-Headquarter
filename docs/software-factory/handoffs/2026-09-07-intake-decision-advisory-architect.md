# Architect handoff — intake decision advisory

Task: `obj-1d7c5ba6-intake-decision-advisory`
Outcome: Integrate the deterministic decision classifier into validated
natural-language intake and surface `decision-request` / `ask` (and, defensively,
`block`) classifications as **advisory** information before dispatch, without
blocking dispatch.

Status: **PASS** — proceed to build. No founder-level decision required
(the founder already decided: everything stays advisory and non-blocking; no
schema changes).

---

## 1. Proposed design

### 1.1 Where classification happens

Add classification **inside `createContractFromObjective()`**
(`factory/lib/natural-language-intake.mjs`), immediately after
`validateTaskContract()` succeeds and the `id` check passes, and **before** the
contract JSON is written to `intake/<id>.json`.

This is the single point in the natural-language path where the contract is both
*produced* and *validated*, which is exactly what the acceptance criteria
require. The `init` / `factory-task` entrypoints (pre-built contract already on
disk) and the objective-decomposition path are out of scope — they never call
`createContractFromObjective()` (see §4).

### 1.2 Inputs to `classifyDecision()`

```js
import { classifyDecision, loadDecisionProtocol } from "./intel/classify.mjs";

const protocol = loadDecisionProtocol(hqRoot);            // factory/decision-protocol.json, embedded fallback
const classification = classifyDecision({
  text: objective.trim(),                                 // founder's raw request text
  fields: { risk: contract.risk, workType: contract.workType },
  protocol,
});
```

- `text` — the natural-language objective (the same string already used to build
  the intake prompt). `workType` is passed through `fields` for forward
  compatibility even though the current protocol does not branch on it; the
  acceptance criteria explicitly require it to be supplied.
- `hqRoot` — `createContractFromObjective()` does not currently receive it. Add an
  **optional** `hqRoot` parameter defaulting to the package root derived from
  `import.meta.url`:

  ```js
  import { fileURLToPath } from "url";
  const DEFAULT_HQ_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  export async function createContractFromObjective({ objective, repo, issue, project, stateRoot,
    hqRoot = DEFAULT_HQ_ROOT, protocol = null, execute = executeChiefOfStaff }) { ... }
  ```

  `protocol` is an optional injection seam for tests; when `null`, load from
  `hqRoot`. This is an additive, backward-compatible signature change — not a
  JSON schema and not `writeHandoff()`.
- `startFromObjective()` in `scripts/openclaw-factory.mjs` passes its existing
  `hqRoot` constant through.

### 1.3 The advisory field on the contract

When `classification.outcome` is `decision-request`, `ask`, or `block`, attach a
single namespaced field to the contract object:

```jsonc
"advisory": {
  "decisionClassification": {
    "advisory": true,
    "blocksDispatch": false,
    "label": "ADVISORY — founder sign-off recommended before merge; does not block dispatch.",
    "outcome": "decision-request",          // raw classifier outcome: decision-request | ask | block
    "surfacedAs": "decision-request",        // block is represented to the founder as decision-request
    "trigger": "privacy",                    // classifier trigger id (rule id, "risk:high", or "blocking")
    "reason": "Privacy / data-retention posture is a founder call.",
    "matchedRule": {                          // the protocol rule that fired, resolved from the loaded protocol
      "id": "privacy",
      "outcome": "decision-request",
      "reason": "Privacy / data-retention posture is a founder call.",
      "source": "trigger"                     // "trigger" | "riskBinding" | "blocking"
    },
    "protocolVersion": 1,
    "classifier": "factory/lib/intel/classify.mjs",
    "classifiedAt": "2026-09-07T00:00:00.000Z"
  }
}
```

When `classification.outcome === "continue"`: **no field is added**. The contract
is byte-for-byte what it is today and follows the existing dispatch path
unchanged.

`matchedRule` resolution (no classifier logic is duplicated — this only *looks
up* the rule the classifier already identified):

| `classification.trigger` | `matchedRule` source |
| --- | --- |
| an id present in `protocol.triggers[]` | that trigger object, plus `source: "trigger"` |
| `"risk:high"` | `{ id: "risk:high", outcome: "decision-request", reason: <classification.reason>, source: "riskBinding" }` |
| `"blocking"` | `{ id: "blocking", outcome: "ask", reason: <classification.reason>, source: "blocking" }` |
| `null` / unknown | `matchedRule: null` (should not occur for the surfaced outcomes) |

Rationale for shape:
- A dedicated `advisory` container (rather than loose top-level keys) keeps the
  contract's core surface untouched and makes the "this is advisory" boundary
  obvious to every downstream reader and to auditors.
- `advisory: true` / `blocksDispatch: false` / `label` are redundant on purpose —
  any consumer that renders only one of them still shows the advisory nature.
- No free-form founder text is copied into the field (only the static protocol
  `reason` and rule id). This keeps the secret-leak surface at zero for
  `state.json` and the handoff (see §5).

### 1.4 Persistence & propagation (already works, no engine change)

1. `createContractFromObjective()` writes the contract — now possibly carrying
   `advisory` — to `intake/<id>.json`.
2. `initializeTask()` re-reads that file, `validateTaskContract()` ignores
   unknown fields, `createState()` → `sanitizeTaskContract()` deletes only the
   `founderApproval*` family, so `advisory` survives into `state.task.advisory`
   and is persisted in `state.json`. Durable and auditable **before any stage
   runs**.
3. No `state` / request / result JSON schema is touched; there is no JSON-schema
   validator for the contract or state (confirmed — `validateTaskContract()` is
   imperative and tolerant; `factory/schemas/*` cover requests/results/config
   only).

### 1.5 Surfacing "before dispatch"

Three complementary surfaces, in order of importance:

1. **Persisted on `state.task.advisory`** (§1.4) — written by `initializeTask()`
   before `runToTerminal()` is ever called. This is the durable, auditable
   record and satisfies "attached to the contract through an allowed advisory
   field."
2. **`handoff-product.md`** — extend the renderer in `factory/lib/handoff.mjs`
   with an `## Advisory decision classification` section, emitted **only when
   `state.task.advisory?.decisionClassification` exists**. This puts the notice
   in front of the first stage (product) and the founder reading the handoff,
   literally before dispatch. `writeHandoff()`'s **signature is unchanged**; the
   section is inert for every contract that has no advisory (all non-NL-intake
   contracts, all existing tests).
3. **`startFromObjective()` return value + a stderr notice** — before calling
   `runToTerminal()`, if `intake.contract.advisory` is present, write one
   clearly-labelled line to `console.warn` (`[decision-advisory] <id>: <outcome>
   / <trigger> — advisory only, not blocking`) and include `advisory` on the
   returned object. The dashboard persists the returned object on the founder
   job; the stderr line lands in CLI/job logs at intake time.

None of these halt or gate `runToTerminal()`. Ordinary (`continue`) contracts hit
none of them.

### 1.6 Control flow (natural-language `start`)

```
createContractFromObjective()
  ├─ execute Chief of Staff  → raw JSON
  ├─ validateTaskContract()  → contract            (unchanged)
  ├─ id check                                        (unchanged)
  ├─ NEW: protocol = loadDecisionProtocol(hqRoot)
  ├─ NEW: c = classifyDecision({ text: objective, fields:{risk,workType}, protocol })
  ├─ NEW: if c.outcome ∈ {decision-request, ask, block}
  │         contract.advisory = { decisionClassification: {…} }
  ├─ write intake/<id>.json  (now may include advisory)
  └─ return { contract, contractPath, advisory }     (advisory: new, optional)

startFromObjective()
  ├─ intake = await createContractFromObjective(… hqRoot …)
  ├─ NEW: if intake.advisory → console.warn("[decision-advisory] …")
  ├─ initialize() → initializeTask() → state.task.advisory persisted, handoff-product.md rendered
  └─ runToTerminal()                                  (unchanged; never gated)
```

---

## 2. Files / components affected

| File | Change | Risk |
| --- | --- | --- |
| `factory/lib/natural-language-intake.mjs` | Import `classifyDecision`/`loadDecisionProtocol`; add optional `hqRoot`/`protocol` params; classify after validation; attach `contract.advisory` for the three surfaced outcomes; add `advisory` to the return object. | Low — additive, `continue` path unchanged. |
| `scripts/openclaw-factory.mjs` | In `startFromObjective()`, pass `hqRoot`; emit the `console.warn` advisory line before `runToTerminal()`; include `advisory` in the response. | Low. |
| `factory/lib/handoff.mjs` | Render an `## Advisory decision classification` section **iff** `state.task.advisory?.decisionClassification` is set. Signature unchanged. | Low — guarded, inert otherwise. |
| `factory/test/intake-decision-advisory.test.mjs` (new) | Cover every protocol trigger family + `risk:high` + `blocking` + reversible work + persistence/handoff/non-blocking assertions. | None (test-only). |
| `docs/software-factory/handoffs/2026-09-07-intake-decision-advisory-architect.md` | This document. | None. |

**Not touched:** the 7-stage state machine, `completeStage`/`createState`/
`resumeState`/`routeStageFailure`, `writeHandoff()` signature,
`factory/lib/intel/classify.mjs`, `factory/decision-protocol.json`,
`factory/schemas/*`, the objective-decomposition path, `run.sh`, worktree
isolation, human-merge mode.

---

## 3. Key tradeoffs

- **Classify in `createContractFromObjective()` vs. in `startFromObjective()`.**
  Chosen: inside `createContractFromObjective()`. It is the only place the
  contract is produced *and* validated, it is reused by any future caller of that
  function, and it lets the advisory be persisted through the normal
  `initializeTask()` path with zero engine change. Cost: the function needs
  `hqRoot` (solved with an optional param + derived default).
- **Namespaced `advisory` object vs. loose top-level keys.** Chosen: a single
  `advisory` container. Keeps the core contract surface identical, makes the
  advisory boundary unmistakable, and is trivial to ignore.
- **Represent `block` as `decision-request` vs. add a distinct advisory kind.**
  Chosen: keep the raw `outcome` (`block`) for the audit trail but set
  `surfacedAs: "decision-request"` so the founder view never has a second,
  engine-looking status. Matches the founder decision verbatim. The current
  classifier cannot emit `block`; this branch is defensive.
- **Handoff rendering change.** Chosen: add a guarded section. Slightly widens the
  blast radius (shared renderer) but is the most honest "surfaced before
  dispatch" location and is inert for every existing contract.
- **`ask` is advisory, not blocking.** The protocol treats `ask` as a blocking
  clarification; the founder decision overrides that for intake — it is attached
  and surfaced but never halts task creation or dispatch.

---

## 4. Out-of-scope paths (documented gap, not a regression)

- **`init` / `createTaskFromArgs` / `handleRequest({action:"init"})`** — consume a
  contract already written to disk; no natural-language step, so no classifier
  hook. Unchanged.
- **Objective decomposition** (`/api/founder/objectives` →
  `decomposeObjective()` → `runObjective()` → `initializeTask()`) — builds node
  contracts without `createContractFromObjective()`. Advisory classification for
  decomposed nodes is a reasonable **follow-up** but is not in this task's
  outcome ("validated natural-language intake"). Flag to product/founder if they
  want parity.

---

## 5. Risks & mitigations

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| A secret from the objective text leaks into `state.json` / handoff via the advisory | Low | Store **only** the static protocol `reason`, rule id, and outcome — never the objective text or any Chief-of-Staff output. Assert this in tests. |
| Advisory is mistaken for a hard gate by a downstream reader | Low | `advisory:true`, `blocksDispatch:false`, and a plain-English `label`, all redundant; `runToTerminal()` is never conditioned on it. Test asserts dispatch proceeds. |
| Handoff renderer change breaks existing handoff tests | Low | Section is emitted only when `state.task.advisory?.decisionClassification` is truthy; existing fixtures never set it. Run `intel-handoff` + `task-entrypoints` + full suite. |
| `contract.advisory` rejected by validation now or later | Low | `validateTaskContract()` ignores unknown fields; `sanitizeTaskContract()` strips only `founderApproval*`. Add a test that pins "advisory survives `createState()`". |
| Protocol file missing at runtime | Low (handled) | `loadDecisionProtocol()` already falls back to the embedded `DEFAULT_PROTOCOL`. |
| `hqRoot` mis-derivation when imported from an unusual path | Low | Default derived from `import.meta.url` (stable relative to `factory/lib/`); `startFromObjective()` passes the explicit `hqRoot` it already computes, which is the real code path. |
| Keyword false positives flag ordinary work | Medium (inherent to the classifier) | Acceptable — it is advisory and non-blocking by design; no mitigation needed beyond the label. Not this task's problem to fix. |

Rollback: revert the four non-test files; `intake/<id>.json` and `state.json`
simply stop carrying `advisory`. No migration, no persisted-state format break
(the field is additive and optional).

---

## 6. Verification plan

New test file `factory/test/intake-decision-advisory.test.mjs`, driving
`createContractFromObjective()` with a stubbed `execute` (pattern already used in
`task-entrypoints.test.mjs`) and an injected `protocol` (or a temp `hqRoot`):

1. **Trigger families** — one case each, asserting
   `contract.advisory.decisionClassification.trigger` and `.outcome`:
   `privacy`, `spend`, `public`, `product-direction`, `irreversible`,
   `security-posture`, `legal` (keyword triggers via objective text);
   `scope` (via `changesMilestonePriority` — note: only reachable if the contract
   or fields carry it; if not wired, assert it is documented as unreachable from
   plain intake text and covered at the `classifyDecision` unit level instead);
   `risk:high` (contract `risk: "high"`); `blocking` (`blocksAllProgress`
   → `outcome: "ask"`).
2. **Ordinary reversible work** — objective "Rename a helper and add a unit
   test"; assert **no** `advisory` key on the contract or `state.task`, and the
   written `intake/<id>.json` is unchanged in shape.
3. **Non-blocking** — a `decision-request` objective still drives
   `start` to `merge-ready` (extend the existing
   "natural-language start creates a contract and drives every stage" test or add
   a sibling); assert `runToTerminal` is reached.
4. **Persistence** — after `initializeTask()`, `state.task.advisory` equals what
   `createContractFromObjective()` attached; `createState()` does not strip it.
5. **Handoff surface** — `handoff-product.md` contains
   `Advisory decision classification` when advisory is present and does **not**
   when it is absent.
6. **No-leak** — advisory JSON contains no substring of the objective text / no
   Chief-of-Staff output.
7. **`block` representation** — feed a stub protocol whose trigger `outcome` is
   `block`; assert `outcome: "block"` is preserved but `surfacedAs:
   "decision-request"`.

Regression:
- `npm run test:factory` (`node --test factory/test/*.test.mjs`) — must stay
  green, with attention to `intel-classify`, `intel-handoff`, `task-entrypoints`,
  `task-workflow`, `openclaw-integration`, `objective-*`.
- `node scripts/factory-doctor.mjs` if it runs in this environment.

Observability: the `[decision-advisory]` stderr line at intake; the advisory
block in `state.json` and `handoff-product.md`; the `advisory` key on the founder
job result in the dashboard.

---

## 7. Decision Card

None required. The founder has already ruled: keep every classifier outcome
advisory and non-blocking in intake, represent `block` as a prominent
`decision-request`, never refuse task creation, no schema changes. This design
implements that ruling exactly.

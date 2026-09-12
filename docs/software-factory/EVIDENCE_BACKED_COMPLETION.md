# Evidence-Backed Completion (FCT-P0-05)

Status: implemented — SFD-2026-010 Batch 3.

This document states what the factory now accepts as proof that a stage did what
it claims, and what it deliberately still refuses to treat as proof.

## 1. The problem

The deterministic gate checked that each stage named at least one non-empty file
inside the worktree:

```js
export function verifyEvidence(paths, worktree) {
  // exists? inside the worktree? non-empty? → accepted
}
```

So a stage could write `All tests passed!` into `evidence/qa.md` and clear the
gate. Nothing tied evidence to the dispatch that produced it, to the commit
under review, or to the acceptance criteria it was supposed to prove. A stale
artifact from an earlier attempt counted. Evidence produced before a later code
change still counted.

## 2. What an evidence manifest binds

Every stage result now carries a versioned manifest
(`factory/lib/evidence-manifest.mjs`) binding evidence to a specific execution:

| Field | Purpose |
| --- | --- |
| `objectiveId`, `taskId` | which work this belongs to |
| `dispatchId`, `attempt` | which execution produced it — `attempt` is derived from the stage's dispatch count, so evidence reused from an earlier attempt is detectable |
| `stage`, `actor`, `runtime` | who produced it, and as what |
| `repo`, `branch`, `commitSha` | which tree it judged |
| `criteria[]` | which acceptance criteria it settles, and how |
| `artifacts[]` | path, type, size, **sha256**, command, exit status |
| `verdict`, `limitations` | the claim, and what it does not cover |

Every binding field comes from the factory's own state. An agent cannot claim
its evidence belongs to a different dispatch or commit.

Digests are computed here, from the real file on disk — never taken from what
the agent said.

## 3. The distinction the feature rests on

```
observed                 the factory ran the check and saw the exit status
asserted                 the agent says so — recorded, never proof
independently-verified   observed, and by a stage independent of the builder
```

`verifyManifest()` refuses to let a criterion be `proven` by:

- an **assertion** (`kind: "asserted"`),
- a `command-output` artifact whose exit status the factory did not observe,
- a `command-output` artifact that exited non-zero,
- an artifact that no longer matches its recorded digest,
- no artifact at all.

**This is why a fabricated text file cannot prove a test passed.** The agent can
write any log it likes; without an exit status the factory itself observed, the
criterion is not proven.

`manifestInputsFromResult()` sets `observed` and `kind` — never the agent. An
`observed: true` smuggled into a result file is ignored
(`evidence-protocol.test.mjs`).

## 4. Acceptance criterion identity

Criterion IDs are derived from the criterion's **text**, not its position
(`factory/lib/evidence-criteria.mjs`):

- stable across attempts, dispatches and stages, so a proof still refers to the
  same criterion later;
- position-independent, so reordering the list does not silently re-point
  existing proofs at different criteria;
- **changed by an edit**, so rewriting a criterion invalidates proofs made
  against the old wording rather than inheriting them.

Duplicate criteria get an explicit ordinal suffix so they remain distinct
entries. Note this makes the IDs different; it does not stop one artifact from
being cited by several criteria, which is legitimate (one test run can prove
more than one criterion).

## 5. Freezing the reviewed commit

Reviewer, QA and security run concurrently once the builder is done, so they
must judge the same tree. `openclaw-protocol.mjs` records the worktree's HEAD as
the builder's work settles, before the group is dispatched, and every downstream
manifest binds to that SHA.

A change after those verdicts is caught two ways:

- **At the gate.** `assertReleaseReady()` re-reads the worktree's HEAD and
  refuses if it has moved past the reviewed commit. This is the one that matters:
  comparing `manifest.commitSha` to `state.verifiedCommit.sha` compares two
  values *both* frozen at builder time, so they always agree and a commit landing
  after every reviewer signed off would sail through.
- **On a builder re-run.** `recordVerifiedCommit()` sees the new SHA, re-opens
  the review stages, and records an `evidence-invalidated` event.

A worktree that is not a git checkout has no commit to bind to. That is decided
**once, at task creation**, from the environment, and recorded as
`evidencePolicy` — never inferred later at the gate, where a missing commit
would be indistinguishable from a task that simply never froze one.

## 6. The release gate

For a task under the strong policy, `assertReleaseReady()` requires:

1. a recorded verified commit;
2. a manifest for every verification stage (reviewer, QA, security);
3. each manifest still verifying — digests intact, bindings correct, and bound
   to the verified commit.

Criterion **coverage** is the one part behind a switch,
`FACTORY_REQUIRE_CRITERION_PROOFS=1`, and the reason is stated plainly: only a
check the factory ran can prove a criterion, and today the factory runs its own
gate checks but does not yet execute a per-criterion verification suite. Turning
coverage on before that exists would block every task on a contract nothing can
currently satisfy.

`not-applicable` does **not** settle a criterion. Nothing constrains who
declares it, so an agent could otherwise mark every criterion N/A with a
one-line note and walk through the gate this switch is supposed to be. Scope is
the founder's call: such criteria are reported by `excusedCriteria()` and remain
outstanding.

What is **not** deferred: nothing weak is ever reported as strong. A stage
without observed proofs reads `asserted`, never `verified`.
`evidenceLedger()` and `excusedCriteria()` expose this, but **no consumer renders
them yet** — `completion-report.mjs` still shows only an artifact count, so a
founder reading the report today cannot yet see the asserted/verified split.
Wiring that display is outstanding work, listed below.

## 7. Compatibility

| | legacy task | strong task |
| --- | --- | --- |
| Created before this change, or without a git worktree | ✅ | |
| Created after, in a git checkout | | ✅ |
| Old file-existence gate | enforced | enforced |
| Manifests required at release | no | yes |
| Reported as | `legacy` / `asserted` | `verified` where earned |

Old state stays readable and old tasks still complete. They are never
retroactively described as verified — that would be exactly the silent upgrade
of weak evidence to strong evidence this work exists to prevent.

## 8. Agent contract

`factory/schemas/agent-result.schema.json` accepts evidence as either form:

```jsonc
"evidence": ["evidence/qa.md"]                       // still valid

"evidence": [                                         // richer, optional
  { "path": "evidence/qa.log", "id": "run",
    "type": "command-output", "command": "npm test", "exitStatus": 0 }
],
"criteria": [
  { "id": "AC-1f2e3d4c5b", "status": "proven", "artifacts": ["run"] },
  { "id": "AC-9a8b7c6d5e", "status": "blocked", "note": "staging unavailable" }
],
"limitations": "Not tested on Safari."
```

A criterion marked `blocked` or `not-applicable` **must say why**.

## 9. Security properties

- **Worktree containment** — evidence resolving outside the task worktree is
  refused: `..`, absolute paths, **and symlinks** (both a symlinked file and a
  symlinked directory component). Containment is re-checked against
  `realpathSync`, because a purely lexical check let `evidence/x -> /etc/passwd`
  through to be read and hashed off the factory host.
- **No command execution** — a `command` string in a manifest is recorded for a
  human to read. Nothing in the factory runs it.
- **Untrusted metadata** — `observed`, `kind`, and every digest are set by the
  factory. Exit status must be an integer, checked before it reaches a manifest.
- **Bounded** — artifacts over 50 MB are refused rather than hashed. Criterion
  proofs are capped by the number of criteria on the task; the artifact list is
  **not** length-capped, so a manifest may name many artifacts (20,000 built in
  ~250 ms). Each is hashed, so the real bound is total bytes.

## 10. Independent adversarial QA

This branch was reviewed by an independent agent that did not write it, before
any PR existed. It found the library sound — it could not forge a proof through
any supported path — and the **enforcement half dead**:

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| C1 | Critical | `initializeTask` calls `createState` *before* `git worktree add`, so the `.git` probe ran against a directory that could not exist yet. Every real task was `legacy` and the whole release gate was unreachable | **Fixed** — the policy is derived from the repo |
| C2 | Critical | The gate compared two values both frozen at builder time, so a commit landing after every reviewer signed off was never detected | **Fixed** — HEAD is re-read at the gate |
| H1 | High | Symlinked evidence escaped the worktree and was hashed off the host | **Fixed** — `realpath` containment |
| H2 | High | `not-applicable` settled a criterion on an agent's say-so, defeating the coverage switch | **Fixed** — reported, not self-granted |
| H3 | High | `dispatchId \|\| manifest.dispatchId` compared a field to itself | **Fixed** — no fallback; a missing id fails |
| H4 | High | `attempt` was comparable but never compared, and every manifest recorded `1` | **Fixed** — derived from the stage's dispatch count and checked |
| M3 | Medium | Duplicate artifact ids let a fabricated artifact shadow a failing one | **Fixed** — ids must be unique |
| M4 | Medium | A text file labelled `screenshot` bypassed the exit-status rule | **Assessed** — `kind` is factory-set, so an agent result can only produce `asserted`, which is rejected. Human evidence is legitimate and stays accepted, now marked `attestation: "human"` |
| M5 | Medium | `observed` is per-result, not per-artifact | **Open** — see below |
| M1/M2/M6 | Medium | No tests on the gate; ledger unconsumed; six doc overclaims | **Fixed** (tests, this section) / **Open** (display) |

The reviewer's mutation testing confirmed the library tests are not vacuous:
breaking each of three security lines produced exactly one failure.

### Known open items

- **M5** — `manifestInputsFromResult(result, { observed: true })` would stamp
  `observed` on *every* artifact in that result, and `exitStatus` is still the
  agent's number. Today nothing passes `observed: true`, so the value is a
  hardcoded `false` and the property holds. The first caller that legitimately
  reports a factory-run gate check must set `observed` per artifact and record
  the status it actually captured, or it will launder the rest of the result.
- **M2** — the completion report does not yet render evidence strength.

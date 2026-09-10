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
| `dispatchId`, `attempt` | which execution produced it |
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

Duplicate criteria get an explicit ordinal suffix so one proof cannot satisfy
both.

## 5. Freezing the reviewed commit

Reviewer, QA and security run concurrently once the builder is done, so they
must judge the same tree. `openclaw-protocol.mjs` records the worktree's HEAD as
the builder's work settles, before the group is dispatched, and every downstream
manifest binds to that SHA.

If the SHA later differs, the source changed after those verdicts were formed.
Their evidence was produced against a tree that no longer exists, so the review
stages are **re-opened** and an `evidence-invalidated` event is recorded. This is
what makes "changing code after QA invalidates review/QA/security" true rather
than aspirational.

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

What is **not** deferred: nothing weak is ever reported as strong. A stage
without observed proofs reads `asserted`, never `verified`, and
`evidenceLedger()` keeps the three classes apart for the completion report.

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
  refused, including via `..` and absolute paths.
- **No command execution** — a `command` string in a manifest is recorded for a
  human to read. Nothing in the factory runs it.
- **Untrusted metadata** — `observed`, `kind`, and every digest are set by the
  factory. Exit status must be an integer, checked before it reaches a manifest.
- **Bounded** — artifacts over 50 MB are refused rather than hashed; arrays and
  nesting are capped.

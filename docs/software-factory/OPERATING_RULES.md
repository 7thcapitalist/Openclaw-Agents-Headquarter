# Operating Rules

## Autonomy principle

Agents should resolve ordinary, reversible engineering choices without interrupting the founder. The founder owns direction; agents own execution.

## Branch and PR lifecycle — non-negotiable

`main` is the single canonical and permanent branch. Every change lands through
a new Pull Request targeting `main`; never push directly to `main`. This applies
to every actor — founder, Claude, Codex, Cursor, factory agents, automated
recovery, QA, infrastructure jobs.

```
latest main -> ephemeral branch/worktree -> ONE coherent change
  -> tests / QA / evidence -> PR targeting main -> review / gates
  -> merge -> delete branch -> delete worktree -> next work starts from new main
```

No long-lived feature, development, integration, or per-agent branches, and no
long-lived worktrees. Independent changes are separate PRs, never stacked on a
shared branch. Do not add unrelated work to an existing PR — open a new one from
the latest `main`. Full policy: `GIT_WORKFLOW.md` (SFD-2026-008).

## Do not escalate

Do not ask the founder about:
- variable/file names
- normal refactors
- test structure
- lint/type errors
- routine CI failures
- small dependency choices with no meaningful lock-in or cost
- reversible implementation details
- minor UI details already implied by the issue

When safe work can continue, record a **deferred decision** instead of stopping
the pipeline. Deferred decisions are shown together after the task reaches
merge-ready, in plain language with options `A`, `B`, or `Other`. Use a blocking
founder decision only when no safe progress is possible or a real authority,
privacy, destructive-operation, spend, or production gate must stop the work.

Make the best reasonable choice, document it, and continue.

## Escalate

Create a Decision Card when the choice materially affects one of these areas:
- product direction or target user
- scope or milestone priority
- privacy/data retention/security posture
- paid services or meaningful recurring spend
- public/external communication
- destructive production operations
- migrations that are difficult to reverse
- legal/compliance implications
- ambiguous UX tradeoffs that change the product promise

## Risk levels

### Low
Examples: copy change, isolated UI polish, tests, non-breaking refactor, internal docs.

Required before merge:
- tests/checks appropriate to the change
- one independent agent review
- no unresolved high-severity findings

V1: human still merges. Later this class may auto-merge.

### Medium
Examples: new API integration, auth flow, database write path, significant dependency, cross-cutting feature.

Required:
- implementation evidence
- independent cross-model review
- QA against acceptance criteria
- explicit rollback/recovery note when relevant
- human merge in V1

### High
Examples: production deletion, billing, secrets/permissions, public publishing, health/financial sensitive-data policy, irreversible migration.

Required:
- founder decision before the risky action
- architecture review
- explicit rollback plan
- human merge/deploy

## Cross-review matrix

- Codex builds -> Claude reviews by default.
- Claude builds -> Codex reviews by default.
- Frontend Builder (Codex) builds -> Claude reviews and QA verifies independently.
- UI changes should receive visual QA when possible.

Reviewer should not rewrite the feature unless necessary. It should identify concrete blocking/non-blocking findings and verify the acceptance criteria.

## Definition of done

A task is not done because an agent says “implemented.” It is done when:
1. acceptance criteria are satisfied,
2. relevant tests/checks pass,
3. independent review is complete,
4. QA evidence exists,
5. docs/state are updated where needed,
6. no required founder decision remains unresolved.

## Recovery of execution failures

Every execution failure is classified as `AGENT_ERROR`, `FACTORY_ERROR`,
`PROJECT_ERROR`, `INFRASTRUCTURE_ERROR`, `FOUNDER_DECISION_REQUIRED`, or
`UNKNOWN`. Recoverable failures remain work on the original task: the factory
records the immutable failure, dispatches bounded diagnosis/repair, independently
verifies the repair through an existing review or QA assignment, and resumes the
failed stage only after verification passes. The default recovery budget is
three attempts (`retry-recover`, `deeper-diagnosis`, `independent-review`).
Founder escalation must identify what failed, why, what the factory tried, what
the founder must decide, and what approval will do. Recovery never bypasses
high-risk approval, independent review, QA, security, release, or human merge
gates. Successful recovery is evidence for the learning queue, not permission
for the learning system to change factory behavior automatically.

# Operating Rules

## Autonomy principle

Agents should resolve ordinary, reversible engineering choices without interrupting the founder. The founder owns direction; agents own execution.

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
- Cursor builds -> Codex or Claude reviews.
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
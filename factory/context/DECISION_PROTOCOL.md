<!--
  Canonical prose for the founder-escalation contract. The machine form is
  factory/decision-protocol.json, evaluated by factory/lib/intel/classify.mjs.
  Distilled from docs/software-factory/OPERATING_RULES.md. If the two disagree,
  stop and surface it.
-->

# Decision protocol

Every judgement call an agent, the Chief of Staff, or a sensor faces resolves to
one of five outcomes. The default is **continue**. Bringing the founder
in is the exception — the product is attention compression.

## continue (default)

Reversible, in declared scope, no trigger hit. Examples: variable and file
names, normal refactors, test structure, lint and type fixes, routine CI
failures, small dependencies with no meaningful lock-in or cost, reversible
implementation details, minor UI already implied by the task.

Action: make the best reasonable choice, record it in the handoff summary and in
`MEMORY.md` when it is durable, and keep working.

## decision-request

A trigger is hit. Triggers:

- product direction or target user
- scope or milestone priority
- privacy, data-retention, or security posture
- paid services or meaningful recurring spend
- public / external communication
- destructive production operations
- migrations that are hard to reverse
- legal / compliance implications
- a UX tradeoff that changes the product promise

Action: emit a Decision Card (`factory/templates/decision-card.md`) with options,
tradeoffs, and a recommendation; add it to the project decision queue; block
**only the affected sub-task**; keep everything else moving. The founder answers
asynchronously. A recorded decision on the task also satisfies its later
high-risk builder authorization; do not ask the founder to approve the same
direction twice.

## decision-deferred

The team can safely finish the assigned work, but a legitimate choice is useful
for the founder to review afterward. This is not a blocker. The agent records a
short question, two options plus `Other`, and a recommendation. Headquarters
shows it only after the task reaches `merge-ready` or `merged`.

### Declaring the impact — required to reach the founder

A deferred decision reaches the Founder Inbox **only** if it declares an
`impact` naming which founder-owned concern it carries. Use one of the trigger
ids from `factory/decision-protocol.json`:

`privacy` · `spend` · `public` · `product-direction` · `scope` ·
`irreversible` · `security-posture` · `legal`

```json
{ "outcome": "decision-deferred",
  "decision": {
    "question": "Should the export include the user's raw health entries?",
    "impact": "privacy",
    "options": ["A. Aggregates only (recommended)", "B. Raw entries"],
    "recommendation": "A — raw entries widen the data we retain." } }
```

A decision with **no** `impact`, or one naming something not in that list, is
still recorded on the task and still appears in the completion report under
"Choices made along the way" — but the founder is not paged, because
`AGENTS.md` already assigns that call to you:

> Reversible implementation details should be decided autonomously. Escalate
> only strategic, costly, privacy-sensitive, destructive, or hard-to-reverse
> decisions.

Silence means *decide it yourself*. Escalation is a claim on the founder's
attention and has to be justified, not assumed. If you are weighing a
reversible implementation detail — which screen ships read-only this milestone,
which of two equivalent libraries, how a component is factored — make the call,
record it, and keep going.

## ask (rare)

The task cannot make *any* safe progress and one short factual clarification
unblocks it.

Action: post a time-boxed blocking question. If it times out, fall back to the
documented default and downgrade to a decision-request.

## block

A gate the workflow engine already owns has failed: missing evidence, failed
independent review, unresolved strategic decision, or a high-risk build without a
recorded signed founder approval. The engine handles this; the intelligence
layer only makes the reason legible. The high-risk signed-approval-before-build
gate is unchanged.

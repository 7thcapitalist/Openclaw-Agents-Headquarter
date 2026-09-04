<!--
  Canonical prose for the founder-escalation contract. The machine form is
  factory/decision-protocol.json, evaluated by factory/lib/intel/classify.mjs.
  Distilled from docs/software-factory/OPERATING_RULES.md. If the two disagree,
  stop and surface it.
-->

# Decision protocol

Every judgement call an agent, the Chief of Staff, or a sensor faces resolves to
exactly one of four outcomes. The default is **continue**. Bringing the founder
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
- any task classified `risk: "high"`

Action: emit a Decision Card (`factory/templates/decision-card.md`) with options,
tradeoffs, and a recommendation; add it to the project decision queue; block
**only the affected sub-task**; keep everything else moving. The founder answers
asynchronously.

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

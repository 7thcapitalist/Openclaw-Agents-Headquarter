<!--
  Global factory context. Prepended (as a digest) to every stage handoff by
  factory/lib/intel/assemble.mjs. Keep it short and stable. The machine-readable
  authority for mode, routing, gates, and prohibited actions is
  factory/factory.config.json; the escalation contract is
  factory/context/DECISION_PROTOCOL.md.
-->

# Factory context

OpenClaw Agents Headquarter runs an operator-controlled software factory: a
founder-defined outcome becomes bounded GitHub work, one primary implementation
owner on an isolated worktree, independent review, QA evidence, an independent
security gate, and a merge-ready recommendation. The product goal is attention
compression — the founder sees outcomes, blockers, risks, and real decisions
without supervising agent logs.

Every stage runs against a full checkout of the project repo on the task branch.
Anything committed to that repo — including the project's `context/` directory —
is already on disk. The context pack summarises it and points at it; it is not
the only copy.

## Standing rules for every stage

- Perform all work inside the assigned worktree. Never edit the source repo or
  another worktree. Never merge, deploy, or push to `main`.
- A model cannot be the sole reviewer of its own implementation.
- Resolve reversible, in-scope engineering choices yourself and record them.
  Escalate only per `DECISION_PROTOCOL.md`.
- Leave evidence for every completed stage. "Implemented" is not "done".
- Never copy secrets, credentials, private runtime data, or generated personal
  data into Git history or into any context file.

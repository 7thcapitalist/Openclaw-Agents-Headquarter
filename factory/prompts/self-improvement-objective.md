Mission — make this software factory materially better at its job. Its job is: turn a founder objective into shipped, reviewed work with the least founder attention, across many projects, getting faster and more reliable over time. Judge every change against that.

The six dimensions I care about, in priority order:
1. Agent quality & speed — better prompts/roles, fewer wasted stages, faster models where safe, the flaky product/main stage off the shared OpenAI seat, frontend-builder on a real capable path.
2. Parallelism — independent work runs concurrently: objective nodes, and stages within a task beyond just the review group, without weakening any gate or the worktree isolation.
3. Observability — I open Headquarters and understand in ten seconds what is running, what each agent produced, what is blocked, what needs me, and what it cost. Real names, no raw ids. Reports and evidence readable in the UI.
4. Founder input — when the factory needs me it is a plain question with one-click answers; infrastructure problems never reach me; I can retry, redirect, or approve in one action.
5. Learning — the factory records what went wrong and why, turns repeated decisions into rules the pipeline applies automatically, and measurably needs me less for the same class of task next time.
6. Multi-project management — registering a real repo + its context and sending it work is a two-minute, guided action; each project's health, cost, and open decisions are visible side by side.

This run: inspect the current codebase and the recent run history, then pick the 2 to 4 highest-leverage improvements you can fully ship now — concrete file changes with tests, not research write-ups. "Highest-leverage" = unblocks the most future work, removes the most founder toil, or removes the most unreliability. Prefer finishing one dimension well over touching all six. If two changes are independent, make them separate nodes so they run in parallel.

Constraints (do not violate):
- Every node is a real change on its own factory/<id> branch, through all seven stages and all five gates, ending in a PR the founder merges. Never push main, never merge, never deploy, never touch billing.
- Keep changes reversible and small per node. Do not break the task / dispatch / result JSON schemas or writeHandoff()'s signature without an explicit migration path in the node's plan.
- Preserve independent review, evidence at every stage, and worktree isolation. Do not add a self-modification shortcut.
- Keep the full factory test suite green and add tests for what you change.
- Do at least one change that a founder would feel the next morning, not only internal cleanup.

If you run low on model credits mid-run: finish or cleanly abandon the current node — never leave a half-committed branch or a task stuck active — record where you stopped in the objective report, and end. A later run continues from the new state.

Deliverable: one PR per node plus the integration PR, each explaining what got better and how a founder can tell.

# Self-Improvement Directive

A standing objective you send to the factory against the `openclaw-factory`
project (Decompose **on**) whenever you want it to make itself better. It is
written to be **re-run** — each run advances the mission by 2–4 shippable steps,
because the decomposer caps at 4 build nodes. To run it repeatedly overnight,
see "Running it all night" at the bottom.

---

## The prompt (paste this into "Start work")

> **Mission — make this software factory materially better at its job.** Its job
> is: turn a founder objective into shipped, reviewed work with the least
> founder attention, across many projects, getting faster and more reliable over
> time. Judge every change against that.
>
> **The six dimensions I care about, in priority order:**
> 1. **Agent quality & speed** — better prompts/roles, fewer wasted stages,
>    faster models where safe, the flaky `product`/`main` stage off the shared
>    OpenAI seat, `frontend-builder` on a real capable path.
> 2. **Parallelism** — independent work runs concurrently: objective nodes,
>    and stages within a task beyond just the review group, without weakening
>    any gate or the worktree isolation.
> 3. **Observability** — I open Headquarters and understand in ten seconds what
>    is running, what each agent produced, what is blocked, what needs me, and
>    what it cost. Real names, no raw ids. Reports and evidence readable in the
>    UI.
> 4. **Founder input** — when the factory needs me it is a plain question with
>    one-click answers; infrastructure problems never reach me; I can retry,
>    redirect, or approve in one action.
> 5. **Learning** — the factory records what went wrong and why, turns repeated
>    decisions into rules the pipeline applies automatically, and measurably
>    needs me less for the same class of task next time.
> 6. **Multi-project management** — registering a real repo + its context and
>    sending it work is a two-minute, guided action; each project's health,
>    cost, and open decisions are visible side by side.
>
> **This run:** inspect the current codebase and the recent run history, then
> pick the **2 to 4 highest-leverage improvements you can fully ship now** —
> concrete file changes with tests, not research write-ups. "Highest-leverage" =
> unblocks the most future work, removes the most founder toil, or removes the
> most unreliability. Prefer finishing one dimension well over touching all six.
> If two changes are independent, make them separate nodes so they run in
> parallel.
>
> **Constraints (do not violate):**
> - Every node is a real change on its own `factory/<id>` branch, through all
>   seven stages and all five gates, ending in a PR I merge. Never push `main`,
>   never merge, never deploy, never touch billing.
> - Keep changes reversible and small per node. Do not break the task /
>   dispatch / result JSON schemas or `writeHandoff()`'s signature without an
>   explicit migration path in the node's plan.
> - Preserve independent review, evidence at every stage, and worktree
>   isolation. Do not add a self-modification shortcut.
> - Keep the full factory test suite green and add tests for what you change.
> - Do at least one change that a founder would *feel* the next morning, not
>   only internal cleanup.
>
> **If you run low on model credits mid-run:** finish or cleanly abandon the
> current node — never leave a half-committed branch or a task stuck `active` —
> record where you stopped in the objective report, and end. A later run
> continues from the new state.
>
> **Deliverable:** one PR per node plus the integration PR, each explaining what
> got better and how a founder can tell.

---

## Candidate backlog (context for the decomposer — not a checklist)

Pulled from the current state of the repo. Any run should pick from here or
something better it finds, not attempt all of it.

**Agent quality & speed**
- Monitor the configured non-OpenAI decomposition/intake and product routes for
  provider contention; keep their OpenAI fallbacks for recovery.
- Keep the Codex-backed `frontend-builder` route honest and first-class (prompt
  and evidence expectations for UI work: screenshots / DOM assertions); only
  promote Cursor if its probe proves a driveable ACP mode.
- Tighten `factory/prompts/*.md` from real transcripts: the biggest time sink is
  qa↔builder bounces — make QA's FAIL criteria unambiguous.

**Parallelism**
- Concurrency beyond `[[reviewer, qa, security]]`: run `product` and `architect`
  design work against a frozen spec in parallel where the contract allows;
  raise objective `maxConcurrent` and prove no worktree collisions.
- Let the objective orchestrator start a node the moment its deps are
  `gate-satisfied`, not in dependency-tier batches.

**Observability**
- Per-stage evidence and the completion report open inline in HQ with no
  scrolling; a task's timeline is one collapsible block.
- "What's autonomous vs configured" is always visible; the cost/limits panel
  (in flight) lands and shows tokens + est-$ + plan headroom.
- A per-project column view: status, stage, cost, open decisions, last delivery.

**Founder input**
- Every `decision-required` renders the agent's concrete options as buttons;
  free-text is the fallback, never the default.
- One-click "retry", "redirect" (send a new direction to a running task), and
  "approve" from the inbox; infra failures never create an inbox item.
- A short "why am I being asked this" line generated from the blocker.

**Learning**
- `factory/lib/learning/*` is recorded but not fed back — inject the distilled
  rules into `writeHandoff()` (guarded, budgeted) so repeated decisions stop
  recurring; `learning.injectIntoHandoff` is currently `false`.
- Turn a repeated `decision-required` of the same shape into a proposed rule in
  `OPERATING_RULES.md` / the decision protocol, surfaced for founder approval.
- A weekly digest: "tasks this week, founder decisions asked, which recurred,
  time-to-merge trend, cost trend."

**Multi-project**
- A guided "add a project" flow: point at a repo, it clones (or verifies),
  scaffolds `context/` from a template, writes `factory/projects.json`, checks
  GitHub coords — replacing hand-editing.
- Raise the decomposition node cap past 4 with a phase-group model (tiers of ≤4
  that run in sequence) so a large objective decomposes instead of erroring.

---

## Running it all night (needs a small orchestration layer — not built yet)

One objective produces one round (≤4 nodes → PRs → integration PR). "All night"
requires a loop that re-dispatches the directive and is aware of credit limits.
What it needs:

1. **`scripts/factory-improve-loop.mjs`** — dispatch the directive, wait for the
   objective to reach a terminal state, then dispatch the next round, until a
   wall-clock budget (e.g. `--hours 8`) or a max-rounds cap. Logs every round's
   PR list.
2. **Credit guard** — before each round and on a sustained failure, read
   provider headroom (the `plan-limits.mjs` reader being built by the cost
   objective). If a required provider is exhausted, compute its reset window
   (Codex ≈ weekly, Claude ≈ 5-hour rolling, Copilot ≈ monthly, OpenClaw seat
   cooldown from the last "auth profile temporarily unavailable" event), sleep
   until then, and resume the loop — do not burn the loop retrying into a wall.
3. **In-run pause/resume** — the objective orchestrator should, on repeated
   provider-exhaustion errors (not transient — the auto-retry sweep handles
   those), checkpoint the objective as `paused` with a `resumeAfter` timestamp
   instead of `blocked`, so the loop (or the existing auto-retry sweep) picks it
   back up when credits return.
4. **A cron** so it starts itself: e.g. every night at 01:00, run the loop with
   an 8-hour budget; it self-limits on credits.

Ask and I'll build items 1–4 as their own factory objective (or directly, since
they are host/orchestration plumbing).

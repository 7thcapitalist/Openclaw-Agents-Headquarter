# Objective decomposition + parallel task-graph orchestration

Layered **above** the 7-stage engine (`factory/lib/task-workflow.mjs`). Nothing in
the engine, the protocol, or the gates changed. Every node and the integration
step run through the unchanged `runToTerminal`, so evidence, independent review,
QA, security, signed high-risk approval, worktree isolation, and
"never push to `main`" all still apply.

```
founder objective
      │  factory/lib/objective/decompose.mjs   (one Chief-of-Staff call)
      ▼
  task graph (DAG)  ── validated: real task contracts, acyclic, roles known
      │  factory/lib/objective/orchestrator.mjs
      ▼
  ┌── node A ──┐   ┌── node B ──┐        each node = initializeTask (own
  │ own branch │   │ own branch │        factory/<id> branch + worktree)
  │ own tree   │   │ own tree   │        + full runToTerminal (7 stages,
  └─────┬──────┘   └─────┬──────┘        in-node concurrent review fan-out)
        └────── node C (depends on A) ──────┐   C starts only after A is merge-ready
                                            ▼
                              integration node
                     git merge --no-ff every build branch into
                     factory/integration-<objectiveId>
                     → reviewer / QA / security / release run for real
                       on the COMBINED tree
                                            ▼
                     publishMergeReadyTask → one PR → main   (never auto-merged)
```

## Files

| File | Role |
|---|---|
| `factory/lib/objective/graph.mjs` | pure DAG helpers — `assertAcyclic`, `readyNodes`, `descendants`, `buildNodesComplete`, `isDeadlocked` |
| `factory/lib/objective/decompose.mjs` | `decomposeObjective()` — one CoS call → validated `objective-state.json`; `buildObjectiveStateFromNodes()` for tests |
| `factory/lib/objective/orchestrator.mjs` | `runObjective()` — bounded concurrent scheduler + integration + `metrics.json`; `readObjState()` |
| `scripts/factory-objective.mjs` | CLI: `start` / `status` / `list` |
| `scripts/objective-smoke.mjs` | hermetic end-to-end (mock agents, real git + remote) |
| `dashboard/backend/lib/founderControlPlane.mjs` → `buildObjectivesView()` | read-only view for `GET /api/founder/objectives` |

## State

`dashboard/backend/data/factory/<repo>/objectives/<objectiveId>/`
- `objective-state.json` — the graph + per-node status, rewritten on every transition
- `metrics.json` — per-node duration / attempts / failed stages / rejections /
  models used (from `openclaw sessions`), plus `maxParallelNodes`
- `contracts/<nodeId>.json` — the task contract handed to `initializeTask`

Each node's own `state.json` lands under `.../factory/<repo>/tasks/<nodeId>/` — so
the existing dashboard task discovery, the founder inbox, completion reports, and
the Learning evidence collector pick nodes up with **no extra wiring**.

## Run

```bash
node scripts/factory-objective.mjs start \
  --objective "Build the onboarding system for LifeMaxing" \
  --project lifemaxing --repo ~/projects/lifemaxing --max-concurrent 3

node scripts/factory-objective.mjs start ... --dry-run     # decompose + print graph, run nothing
node scripts/factory-objective.mjs status --repo ~/projects/lifemaxing --objective-id obj-xxxxxxxx
curl -s localhost:PORT/api/founder/objectives                # machine-readable
```

## Concurrency, dependencies, safety

- **`--max-concurrent`** (default 3) bounds in-flight nodes. OpenClaw's own
  `agents.defaults.maxConcurrent` still bounds agent calls under that.
- A node is **ready** only when every `dependsOn` node reached `merge-ready`
  (its required gate). A dependent is never `initializeTask`'d earlier.
- A node that **fails** (retries spent) or raises **`decision-required`** is
  marked blocked; its transitive descendants become `blocked-by-dep`; siblings
  keep running. The node's task surfaces in the **founder inbox** exactly like a
  single task. Answer the decision card, then **re-run `factory-objective start`
  for the same objective** — the orchestrator resumes unblocked nodes.
- **Integration** aborts on a merge conflict and records a `decision-required`
  on the integration node (no partial merge left behind).
- Two nodes never share a worktree; the orchestrator never runs two dispatches
  against one tree.

## Not yet

- Node roles are limited to `backend-builder` / `frontend-builder`. Standalone
  `research` / `architect` nodes are not modelled (review/QA/security/integration
  are automatic).
- `--max-concurrent` does not yet feed back OpenClaw provider rate-limit state;
  a rate-limited provider surfaces as a node failure, not a pause.
- The decomposition graph is auto-executed once structurally valid (no founder
  approval gate on the graph itself).

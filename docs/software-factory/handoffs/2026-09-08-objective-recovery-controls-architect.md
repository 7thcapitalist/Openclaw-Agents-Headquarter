# Architect handoff — objective-level recovery controls

Task: `obj-c7b263bb-objective-recovery-controls`
Outcome: Add a founder-visible one-click recovery action that retries all safely
retryable infrastructure failures in a blocked objective and resumes
orchestration, without exposing infrastructure details as founder decisions.

Status: **PASS** — proceed to build. No founder-level decision required
(founder decisions list is "none"; this is infra-only, reversible, no schema
change, PR opened only after all normal gates).

---

## 0. TL;DR for the builder

1. Add one pure classifier `classifyObjectiveNodeBlocker(blocker)` to
   `factory/lib/hq/blocker-class.mjs`.
2. In `factory/lib/objective/orchestrator.mjs`, **tag** the synthesized
   infra-as-decision blocker with `infra: true` (line ~110) so classification is
   explicit, not prose-matched; and make `runNode()` / `runIntegration()`
   **re-entrant** — reuse an existing node worktree instead of calling
   `initializeTask()` a second time. Export one new function
   `resumeObjectiveNodes({ objectivePath, nodeIds, now })`.
3. Add `buildRecoveryPlan(objState, { now })` + wire a `recovery` block into each
   objective in `buildObjectivesView()` (`dashboard/backend/lib/founderControlPlane.mjs`);
   add `findObjectiveStatePath()` and `handleObjectiveRetry({ root, objectiveId, runObjective })`.
4. Add `POST /api/founder/objectives/:id/retry` to `dashboard/backend/server.mjs`,
   mirroring `POST /api/founder/tasks/:id/retry` + the background runner in
   `POST /api/founder/objectives`.
5. In `dashboard/backend/public/app.js`, render a distinct "infrastructure
   recovery" affordance on `objectiveCard(o)` (separate from the decision line)
   and bind `[data-retry-objective]` exactly like `[data-retry-task]`. Extract
   the pure predicate/markup into `dashboard/backend/public/lib/objectiveRecovery.mjs`
   for DOM tests.
6. Tests under `factory/test/*.test.mjs`; `npm run test:factory` green.

---

## 1. Context — what already exists (reuse, do not rebuild)

| Mechanism | Location | What it gives us |
|---|---|---|
| Blocker classifier (`decision` / `infra` / `hard`) | `factory/lib/hq/blocker-class.mjs` | The infra-vs-decision split and `INFRA_FAIL_RE` |
| Task-level manual retry | `POST /api/founder/tasks/:id/retry` (`server.mjs:447`) | The exact pattern: `resumeState()` → keep `autoRetries` → push a `manual-retry` event → `runToTerminal({ statePath })` in the background → `202 {status:"retrying"}` |
| Infra auto-retry + orphan sweep | `factory/lib/hq/auto-retry.mjs` | The two recoverable situations (infra-blocked; `active` but stale > `staleActiveMs` = 90 min) and the orphan re-arm (`delete currentDispatch`; `stages[currentStage] = {status:"pending"}`) |
| Objective discovery / view model | `buildObjectivesView()` / `shapeObjective()` (`founderControlPlane.mjs:291`) | Per-node join to the live task (stage/status/blocker/retries), `blockedOn`, `nextUp`, role→model, human `title` from the decomposition contract |
| Objective card UI | `objectiveCard()` / `objectiveNodeRow()` (`app.js:583`) | Card layout, node rows, `data-report-objective`, the "Waiting on you — Founder inbox" line |
| Orchestrator resume intent | `runObjective()` (`orchestrator.mjs:316`) | Already *intends* to resume: blocked/failed node whose task `state.json` is `active` → `pending`; `blocked-by-dep` with live deps → `pending`; objective status → `active` |
| Background objective runner | `POST /api/founder/objectives` (`server.mjs:329`) | `saveFounderJob` + detached `runObjective({ hqRoot, objectivePath, agentIds, maxAttemptsPerStage, concurrentGroups, stateRoot: defaultStateRoot(ROOT, repo) })` |

### 1.1 The core problem the classifier must solve

`runNode()` (`orchestrator.mjs:109-115`) **relabels an infrastructure failure as
`outcome: "decision-required"`** on the objective node (summary: *"The <stage>
for this task could not run (…). Retry the objective later, or adjust model
routing…"*). Consequently:

- `buildObjectivesView()` sets `node.decisionRequired = true` and
  `obj.blockedOn = <that node>` → the card shows **"Waiting on you — see the
  Founder inbox"** for what is really a transient infra hiccup.
- `classifyBlocker()` returns `"decision"` for it (it checks
  `outcome === "decision-required"` *before* looking at the text).

So we need a distinct objective-node classifier that recognises the
orchestrator's relabeled infra blocker and routes it to *infrastructure
recovery*, not to the founder.

### 1.2 The re-entrancy gap (must fix)

`runNode()` and `runIntegration()` **always** call `initializeTask()`, which
throws if the task `state.json`, the worktree, or the branch already exists.
Nothing in the test suite re-runs `runObjective()` on the same objective, and the
"just re-run after answering the decision card" comment in `orchestrator.mjs:316`
is therefore **currently broken** for any node that already reached
`initializeTask()` (i.e. every node that actually ran). Task-level retry avoids
this because `runToTerminal({ statePath })` reuses the existing state + worktree.
The recovery feature must bring the objective path to the same re-entrant
behaviour.

---

## 2. Proposed design (smallest change that satisfies the criteria)

### 2.1 `classifyObjectiveNodeBlocker(blocker)` — pure, Node builtins only

Add to `factory/lib/hq/blocker-class.mjs`:

```js
// Classify a decomposed-objective NODE blocker. Unlike classifyBlocker(), this
// understands that the objective orchestrator relabels an infrastructure failure
// as `decision-required` (see objective/orchestrator.mjs). "infra" here means
// "safe for the system to retry without the founder".
export function classifyObjectiveNodeBlocker(blocker) {
  if (!blocker) return null;
  // 1. Explicit tag written by the orchestrator on newly-synthesized blockers.
  if (blocker.infra === true) return "infra";
  // 2. Backfill for objective-state.json written before the tag existed: match
  //    the orchestrator's exact synthesized sentence (specific enough to be safe).
  if (blocker.outcome === "decision-required"
      && /could not run/i.test(blocker.summary || "")
      && /retry the objective later|adjust model routing/i.test(blocker.summary || "")) {
    return "infra";
  }
  // 3. A genuine stage decision or a merge conflict stays with the founder.
  if (blocker.outcome === "decision-required") return "decision";
  // 4. fail → infra|hard via the existing regex; anything else → hard.
  return classifyBlocker(blocker);
}
```

Merge-conflict integration blockers (`outcome:"decision-required"`, summary
*"merge conflict integrating …"*) fall through to `"decision"` — correct, a
blind retry will not resolve a conflict.

### 2.2 `orchestrator.mjs` changes

**(a) Tag the synthesized blocker.** At `orchestrator.mjs:110`:

```js
blocker = {
  ...blocker,
  outcome: "decision-required",
  infra: true,                       // NEW — machine-readable, backward-compatible
  summary: `The ${blocker.stage || "agent"} for this task could not run (${firstLine(blocker.summary)}). `
         + `Retry the objective later, or adjust model routing for that role.`,
};
```

Additive field on an in-memory object that is then persisted by `patchNode()`.
No schema file, no `writeHandoff()` change.

**(b) Make `runNode()` re-entrant.** Replace the unconditional
`initializeTask()` with:

```js
const obj = readObjState(objectivePath);
const node = obj.nodes[nodeId];
let statePath = node.statePath;
let worktree = node.worktree;

if (statePath && existsSync(statePath)) {
  // Resume an already-initialized node. The recovery action (or runObjective's
  // resume block) has already flipped state.json back to `active`.
  // Nothing to initialize — reuse the existing single worktree for this branch.
} else {
  const contractDir = join(dirname(objectivePath), "contracts");
  mkdirSync(contractDir, { recursive: true });
  const contractPath = join(contractDir, `${nodeId}.json`);
  writeFileSync(contractPath, `${JSON.stringify(node.contract, null, 2)}\n`, "utf8");
  const init = initializeTask({ hqRoot, contractPath, repo: obj.repo, branch: node.branch, stateRoot });
  statePath = init.state; worktree = init.worktree;
  patchNode(objectivePath, nodeId, { statePath, worktree, branch: init.branch });
}

const resp = await runToTerminal({ hqRoot, statePath, agentIds, maxAttemptsPerStage, concurrentGroups, execute, publish: NODE_NO_PUBLISH });
const state = readState(statePath);
```

This is the same reuse task-level retry already relies on; it preserves
"one writer per branch / worktree isolation" (still exactly one worktree per
node branch) and keeps the failed run's evidence on disk.

**(c) `runIntegration()`** — apply the same `existsSync(statePath)` guard so an
infra-blocked integration node can re-run on its existing worktree. The synthetic
`builder` stage re-runs `git merge` of already-merged branches → "Already up to
date", `r.ok` true (verify with a test; if a re-merge is noisy, gate the merge
loop on `git rev-parse --verify <branch>` ahead of base).

**(d) New export `resumeObjectiveNodes({ objectivePath, nodeIds, now })`.**
Keeps all objective-state IO inside the objective lib (module-private
`writeObjState`/`mutate` are not exported). It:

- for each `nodeId` (build node or the integration node): read its underlying
  task `state.json`; if `status === "blocked"` → `resumeState(state, at)`; if
  `status === "active"` (orphan) → `structuredClone`, `delete currentDispatch`,
  `stages[currentStage] = {status:"pending"}`, push `task-resumed`; preserve
  `autoRetries`; `writeState()`.
- in `objective-state.json`: set that node `status = "pending"`, `blocker = null`,
  `finishedAt = null`; push `{ type:"objective-node-retry", node, reason, at }`.
- recompute `blocked-by-dep` descendants exactly as `runObjective`'s resume block
  does (promote to `pending` when every dep is live).
- record `obj.recovery = { requestedAt: at, by: "founder", nodes: [...ids],
  attempts: (obj.recovery?.attempts || 0) + 1 }` and push
  `{ type:"objective-recovery-requested", by:"founder", nodes, at }`.
- per-node `try/catch` (mirror `auto-retry.mjs`): a node that cannot be resumed
  is skipped and reported, never aborts the batch.
- return `{ resumed: [{ id, role, title, reason }], skipped: [{ id, reason }] }`.

### 2.3 Control plane — `founderControlPlane.mjs`

**`buildRecoveryPlan(objState, { now = Date.now(), staleActiveMs = STALE_ACTIVE_MS })` → `{ nodes: [{ id, role, title, reason }] }`** (pure, unit-testable). A node is
*recoverable* iff **all** of:

- it is a build node or the integration node (not `blocked-by-dep` — that clears
  automatically);
- `classifyObjectiveNodeBlocker(node.blocker) === "infra"`
  **OR** it is *restart-orphaned*: `node.status === "running"` **and** its
  underlying task `state.json` is `active` with `updatedAt` older than
  `staleActiveMs` (reuse the 90-min constant already in this file);
- it is **not** a genuine `decision` / `hard` blocker;
- it is **not** a high-risk build approval: `task.risk === "high"` &&
  `blocker.stage === "builder"` && (`state.founderApprovalRequest` present and no
  valid `founderApproval`);
- its underlying task is **not** currently `active` and fresh (a live runner owns
  it) — unless it is the stale-orphan case above.

`reason` is a short founder-facing phrase derived from the existing blocker
summary / orphan detection (e.g. *"model provider was unavailable"*,
*"interrupted by a restart"*), never a raw id or stack text.

**Wire into `shapeObjective()` / `buildObjectivesView()`:** add
`obj.recovery = { count: plan.nodes.length, nodes: plan.nodes }`. Adjust
`obj.blockedOn` so it only points at a node whose
`classifyObjectiveNodeBlocker(...)` is `"decision"` (or a non-infra
`node.status === "blocked"`); and `summary.needsFounder` must not count an
objective whose only blockers are infra-recoverable.

**`findObjectiveStatePath(root, objectiveId)`** — mirror `readObjectiveReport()`:
validate `/^obj-[a-z0-9-]+$/i`, iterate `factoryRoot(root)/<project>/objectives/<id>/objective-state.json`,
`resolve(...).startsWith(allowedRoot + "/")` guard, return the first match or `null`.

**`handleObjectiveRetry({ root, hqRoot, objectiveId, runObjective, now })`** — the
route body, unit-testable with an injected `runObjective` (same seam pattern as
`resolveFounderDecision`). Steps:

1. `statePath = findObjectiveStatePath(root, objectiveId)`; `404` if null.
2. `obj = readObjState(statePath)`. Duplicate guard: if
   `obj.recovery?.inFlight` and `now - Date.parse(obj.recovery.inFlight.at) < RECOVERY_LOCK_MS`
   (15 min) **or** a `listFounderJobs(root)` entry
   `{ kind:"objective-recovery", objectiveId, status:"recovering" }` exists →
   `409 { error: "Recovery already in progress for this objective." }`.
3. `plan = buildRecoveryPlan(obj, { now })`; if `plan.nodes.length === 0` →
   `409 { error: "Nothing to recover — the remaining blockers need you." }`.
4. `resumeObjectiveNodes({ objectivePath: statePath, nodeIds: plan.nodes.map(n=>n.id), now })`.
5. Set `obj.recovery.inFlight = { at: nowISO, jobId }` (fresh read+write via a
   small exported setter, or fold into `resumeObjectiveNodes`).
6. `saveFounderJob(root, { id: jobId, kind:"objective-recovery", projectId: obj.project, objectiveId, objective: obj.objective, repo: obj.repo, nodeCount: resumed.length, status:"recovering", createdAt, updatedAt })`.
7. Launch detached:
   `runObjective({ hqRoot, objectivePath: statePath, agentIds, maxAttemptsPerStage, concurrentGroups, stateRoot: defaultStateRoot(hqRoot, obj.repo) })`
   `.then(r => saveFounderJob(status:r.status)).catch(...).finally(clear obj.recovery.inFlight)`.
8. Return `{ objectiveId, status:"recovering", nodes: resumed.map(({role,title}) => ({role,title})), skipped }`.

### 2.4 Route — `server.mjs`

Factor the detached runner from `POST /api/founder/objectives` into a local
`runObjectiveJob(job, { objectivePath })` helper and reuse it. Then:

```js
// One click: retry every safely-retryable infrastructure failure in a blocked
// objective and resume the orchestrator. Never touches decision / approval /
// hard-fail / live nodes. Mirrors POST /api/founder/tasks/:id/retry.
app.post("/api/founder/objectives/:id/retry", async (req, res) => {
  try {
    if (!/^obj-[a-z0-9-]+$/i.test(req.params.id)) return res.status(400).json({ error: "Invalid objective id." });
    const out = await handleObjectiveRetry({
      root: ROOT, hqRoot: ROOT, objectiveId: req.params.id, runObjective: runObjectiveJob,
    });
    res.status(202).json(out);
  } catch (e) {
    res.status(e.statusCode || 400).json({ error: String(e.message || e) });
  }
});
```

Behind the existing `loginGate`/`requireAuth`; same JSON body + `sameSite:"lax"`
posture as every other POST. No free-text input (unlike `/decisions/resolve`).

### 2.5 UI — `app.js` (+ `public/lib/objectiveRecovery.mjs`)

Extract two pure functions into a new **plain ESM** module
`dashboard/backend/public/lib/objectiveRecovery.mjs` (no deps, `export function`):

```js
export function isObjectiveRecoverable(o) { return (o?.recovery?.count || 0) > 0; }

export function renderObjectiveRecovery(o, { esc }) {
  if (!isObjectiveRecoverable(o)) return "";
  const n = o.recovery.count;
  const who = o.recovery.nodes.map((x) => esc(x.title || x.role)).join(", ");
  return `<div class="obj-recovery">
    <span class="obj-recovery-note">Infrastructure hiccup on ${n} step${n === 1 ? "" : "s"} (${who}) — not a decision for you.</span>
    <button class="btn secondary tiny" data-retry-objective="${esc(o.objectiveId)}">Retry recoverable work</button>
  </div>`;
}
```

Load it from `index.html` as `<script type="module">` that assigns
`window.__objectiveRecovery`, and have `app.js` call through that (smallest
change; avoids converting the whole IIFE to a module). `objectiveCard(o)`:

- render `renderObjectiveRecovery(o, { esc })` **above** the node list;
- show the existing *"Waiting on you — see the Founder inbox"* line **only** when
  `o.blockedOn` is a real decision (now already filtered server-side);
- keep every node label as `n.title` / `n.role` — never `n.id`.

Bind in `bindFounderControls()`, mirroring `[data-retry-task]`:

```js
app.querySelectorAll("[data-retry-objective]").forEach((btn) => btn.onclick = async () => {
  btn.disabled = true; btn.textContent = "Recovering…";
  try {
    const r = await apiJson(`/api/founder/objectives/${btn.dataset.retryObjective}/retry`, { method: "POST" });
    showToast(`Retrying ${r.nodes.length} step${r.nodes.length === 1 ? "" : "s"}. Follow it in “Objectives”.`);
    setTimeout(route, 800);
  } catch (e) { showToast(e.message, true); btn.disabled = false; btn.textContent = "Retry recoverable work"; }
});
```

The 15 s `today` auto-refresh + `setTimeout(route, 800)` already re-fetch
`/api/founder/objectives`, so the card status/`recovery.count` updates on its own.

---

## 3. Files / components affected

| File | Change | Risk |
|---|---|---|
| `factory/lib/hq/blocker-class.mjs` | + `classifyObjectiveNodeBlocker()` (pure) | low |
| `factory/lib/objective/orchestrator.mjs` | + `infra:true` tag; `runNode`/`runIntegration` re-entrant guard; + `resumeObjectiveNodes()` export | **medium** — engine-adjacent, touches the run loop's node path |
| `dashboard/backend/lib/founderControlPlane.mjs` | + `buildRecoveryPlan()`, `findObjectiveStatePath()`, `handleObjectiveRetry()`; `recovery` block + `blockedOn`/`needsFounder` tweak in the objectives view | medium |
| `dashboard/backend/server.mjs` | + `POST /api/founder/objectives/:id/retry`; extract `runObjectiveJob()` | low |
| `dashboard/backend/public/app.js` | `objectiveCard()` render + `[data-retry-objective]` binding | low |
| `dashboard/backend/public/lib/objectiveRecovery.mjs` | **new** pure render module | low |
| `dashboard/backend/public/index.html` | + `<script type="module">` loader line | low |
| `dashboard/backend/package.json` | + `jsdom` **devDependency** (test-only; see §6) | low |
| `factory/test/*.test.mjs` | new + extended tests | — |

Untouched by design: the 7-stage state machine, dispatch protocol, JSON adapter
surface, request/result schemas, `writeHandoff()` signature, `./run.sh`
boundary, human-merge mode.

---

## 4. Key tradeoffs

- **New `blocker-class` helper vs. overloading `classifyBlocker()`.** A separate
  function keeps the task-level classifier (used by the Founder Inbox / auto-retry)
  byte-for-byte unchanged, so no risk of a task suddenly re-classified. Cost: two
  functions that look similar — mitigated by a comment cross-linking them.
- **Explicit `infra:true` tag vs. regex-on-prose.** The tag is deterministic and
  cheap; the regex fallback covers only pre-existing state files and is scoped to
  the orchestrator's exact sentence. A genuine stage decision that merely quotes
  a provider error keeps `decision` classification.
- **Re-entrant `runNode` (reuse worktree) vs. tear-down + fresh `initializeTask`.**
  Reuse matches the proven task-retry path, preserves failed-run evidence, and is
  ~10 lines. Tear-down needs `git worktree remove --force` + branch delete + more
  path guards and is destructive. Reuse chosen.
- **`resumeObjectiveNodes()` in the objective lib vs. mutating objective-state
  from the control plane.** Keeping objective-state IO in `objective/` respects
  the existing module boundary ("orchestration above the engine") and gives the
  server a thin, injectable seam. Cost: one new exported function.
- **Handler-unit tests + jsdom vs. a full HTTP harness.** No supertest/express
  test harness exists today; adding one is a bigger surface than the feature.
  `handleObjectiveRetry({ ..., runObjective })` with an injected orchestrator
  gives equivalent coverage in the established style.
- **No feature flag.** The button only appears when `recovery.count > 0`. If a
  kill-switch is wanted, gate `buildRecoveryPlan()` on
  `factory.config.json.objectiveRecovery !== false` — cheap, recommended but
  optional.

---

## 5. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Double-drive**: recovery re-runs `runObjective` while the original orchestrator process is still alive | low (job normally already terminal when the card shows blocked) | `obj.recovery.inFlight` lock (15 min) + a live `objective-recovery` founder job check; orphan branch requires task `updatedAt` > 90 min stale |
| **Auto-retry sweep collision** on the same underlying task `state.json` | low | After `resumeObjectiveNodes`, the task is `active` and fresh → the sweep's stale-active branch skips it and its blocked-infra branch no longer matches (`status !== "blocked"`). Optionally have `retryStuckTasks` skip state paths under an objective dir with `recovery.inFlight`. |
| `runIntegration` re-run re-merges already-merged branches | medium | `git merge` of a merged branch is a no-op (`Already up to date`); add a test; if noisy, guard the merge loop with `git rev-parse --verify` / `git merge-base --is-ancestor` |
| Backfill regex misclassifies a genuine decision as infra | very low | Requires *both* "could not run" *and* "retry the objective later / adjust model routing" — the orchestrator's exact wording |
| High-risk build slips into the recovery set | low | Explicit exclusion in `buildRecoveryPlan` (`risk==="high" && stage==="builder" && no valid approval`); plus `resumeState()` itself throws for that case and the node is then reported as `skipped` |
| Founder spams the button on a genuinely broken provider | low | `inFlight` lock; `obj.recovery.attempts` surfaced on the card ("retried N×"); action is founder-initiated and visible |
| Objective stuck mid-run with `status:"active"` (orphan) never shows a "blocked" card | medium | `buildRecoveryPlan` also covers `node.status==="running"` + stale task; the button is driven by `recovery.count > 0`, not by `o.status` alone |
| `objective-state.json` concurrent write (recovery endpoint vs. a still-running node) | low | Reuse the orchestrator's read-modify-write `mutate()` (temp file + `renameSync`); never hold `obj` across an await in the endpoint |
| Path traversal via `:id` | low | `/^obj-[a-z0-9-]+$/i` + `resolve().startsWith(allowedRoot + "/")`, identical to `readObjectiveReport()` |
| Privacy — a secret in an event/reason string | low | `reason` is derived from the already-redacted runner blocker summary; no new capture, no free-text, no external call |

---

## 6. Verification plan

All new tests are `factory/test/*.test.mjs` so `npm run test:factory`
(`node --test factory/test/*.test.mjs`) covers them.

### 6.1 Unit — classifier (`hq-blocker-class.test.mjs`, extend)
- `infra:true` tagged `decision-required` → `"infra"`.
- Orchestrator's synthesized sentence, **no** tag (backfill) → `"infra"`.
- `{outcome:"decision-required", summary:"merge conflict integrating X"}` → `"decision"`.
- Genuine stage decision (`"Choose Postgres or SQLite"`) → `"decision"`.
- `{outcome:"fail", summary:"ECONNRESET"}` → `"infra"`; `{outcome:"fail", summary:"tests fail"}` → `"hard"`.
- `null` → `null`.

### 6.2 Unit — orchestrator (`objective-orchestrator.test.mjs`, extend)
- After the existing infra test, assert `node.blocker.infra === true`.
- `resumeObjectiveNodes` on a fixture graph `{A infra-blocked, B decision-required, C gate-satisfied, D running+fresh}`:
  only `A`'s task `state.json` flips to `active`; `B/C/D` untouched; return
  `resumed:[A]`. Then re-run `runObjective` with `makeExecute()` and assert the
  objective reaches `complete` (A → `gate-satisfied`, integration merges).
- **Re-entrancy**: run `runObjective` with `failOnce` infra on node A → objective
  blocked; `resumeObjectiveNodes([A])`; re-run → `runNode` reuses the worktree
  (no "Task state already exists" throw), A completes.
- **Orphan**: node A `status:"running"`, its task `state.json` `active` with an
  old `updatedAt`; `resumeObjectiveNodes([A])` re-arms `currentStage` to
  `pending` and drops `currentDispatch`.
- **Integration infra**: all build nodes `gate-satisfied`, integration node
  infra-blocked → `resumeObjectiveNodes([integration])` + re-run → `runIntegration`
  re-runs on the existing worktree, merges are no-ops, objective `complete`.

### 6.3 Unit — control plane (`founder-control-plane.test.mjs`, extend)
- `buildObjectivesView`: fixture objective with one infra node + one real
  decision node → `recovery.count === 1`, `recovery.nodes[0]` has `role` + `title`
  (not the raw id); `blockedOn` still points at the decision node;
  `summary.needsFounder` counts it once (for the decision, not the infra).
- Objective with only hard-fail / decision nodes → `recovery.count === 0`.
- `findObjectiveStatePath` rejects `../` / non-`obj-` ids, returns `null` for
  unknown, resolves a real one.

### 6.4 Unit — endpoint handler (`objective-recovery-endpoint.test.mjs`, new)
- **Mixed blockers**: `handleObjectiveRetry` with an injected
  `runObjective` spy on `{infra A, decision B}` → resumes only A, spy called
  once, response `nodes:[{role,title}]` (no id), `202`-shaped.
- **Duplicate request**: second call while `obj.recovery.inFlight` is fresh →
  throws with `statusCode 409`; spy **not** called again.
- **Nothing recoverable**: `{decision B, hard C}` → `409`, spy not called,
  no task `state.json` mutated.
- **Never auto-answers**: after the call, B's task `state.json` still
  `blocked` / `decision-required`; no `founder-decision-recorded` /
  `founder-approval-recorded` event anywhere.
- **Orchestration resumption**: injected `runObjective` receives
  `{ objectivePath, stateRoot }` and, run for real via `makeExecute()`, drives
  the objective to `complete`; a `objective-recovery` founder job transitions
  `recovering` → `complete`.

### 6.5 DOM — UI (`objective-recovery-ui.test.mjs`, new)
Import `renderObjectiveRecovery` / `isObjectiveRecoverable` from
`public/lib/objectiveRecovery.mjs`; mount the returned HTML in a `jsdom`
`JSDOM` document (`jsdom` added as a **devDependency of `dashboard/backend`** —
the "Node builtins only" rule is scoped to `factory/lib/*`; `dashboard/` and
tests already use npm):
- `recovery.count === 0` → `container.querySelector("[data-retry-objective]")` is `null`.
- `recovery.count === 2` → button present, text `"Retry recoverable work"`, note
  mentions "2 steps" and the node **titles** (assert the raw id string is absent).
- Simulate the handler: set `btn.disabled = true; btn.textContent = "Recovering…"`
  and assert both — proves the feedback contract the binding implements.

*(Fallback if the team vetoes `jsdom`: assert on the returned HTML string with
`node:assert` `match` — lower fidelity but still covers visibility + feedback.)*

### 6.6 Full suite
`npm run test:factory` green. Manually: `npm run dev`, block an objective with a
simulated infra failure, confirm the card shows the recovery affordance (not the
inbox line), click once → button disables + toast → objective returns to
`active` → node completes.

---

## 7. Migration / rollback

- **Forward-compatible reads.** `shapeObjective()` cherry-picks fields, so an
  older objective-state.json without `recovery` / `blocker.infra` is fine;
  `buildRecoveryPlan` computes fresh on every read and persists nothing itself
  (only `resumeObjectiveNodes` writes, and only on an explicit click).
- **Backward-compatible writes.** `recovery` (object) and `blocker.infra`
  (boolean) are additive; code on the previous revision ignores them. No JSON
  schema file changes; task `state.json` shape is unchanged (goes through the
  existing `resumeState` / orphan re-arm).
- **Rollback = revert the commit.** No data migration, no cleanup: the extra
  `recovery` block and `objective-*-retry` events are inert to the old code. Any
  worktree already reused by a recovered run stays valid (it is a normal factory
  worktree).
- **Kill switch (optional):** `factory.config.json` `"objectiveRecovery": false`
  → `buildRecoveryPlan` returns `[]` → button never renders, endpoint `409`s.

---

## 8. Decision Card

None. Infra-only, in-scope, reversible, no schema change, no external action
(PR opened only after review + QA + security pass). The founder boundary is
preserved by construction: `buildRecoveryPlan` excludes every `decision`,
signed-approval, hard-fail, and live node, and the action never calls
`resolveFounderDecision` / `recordFounderApproval`.

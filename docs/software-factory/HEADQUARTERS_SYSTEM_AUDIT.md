# Headquarters System Audit

Status: Audit only. No application code, dashboard, or architecture changed.
Date: 2026-09-04
Author: Claude (architecture / independent review), read-only inspection of the
actual repository, actual runtime (`openclaw`, `gh`), and actual filesystem
state — not prior summaries.

This document answers one question: **what have we actually built, what does
the system actually know, what is connected, what is disconnected, and what
should the founder be able to see?**

Every claim below was checked against code, tests, or live command output.
Where a document describes something that does not exist in code, that is
called out explicitly — this repository contains several *proposal* documents
that read like architecture-accepted specs but are not implemented.

---

## 0. How to read this audit

Three kinds of artifact exist in this repo, and confusing them is the root
cause of the founder's disorientation:

1. **Built and wired** — code exists, is unit-tested, and is called by
   something else that runs (a CLI, an HTTP route, another module).
2. **Built but orphaned** — code exists and may even be correct, but nothing
   calls it. It cannot affect what the founder sees today.
3. **Documented only** — a `docs/software-factory/*.md` file describes a
   design (often marked "Status: Architecture — for founder review" or
   "planned"). No code exists for it at all.

`COMPANY_OS_ARCHITECTURE.md` is entirely category 3 (verified: `company/`,
`factory/lib/company/`, `factory/lib/sensors/`, `factory/lib/context/` do not
exist anywhere in the repo). `HQ_INTEGRATION_LAYER.md` is category 1 for most
of its claims and category 2 for one piece added on this branch
(`hq/runtime.mjs`). This distinction is used throughout Part 1 and Part 10.

---

## PART 1 — Inventory

For each subsystem: what it does · where it lives · implemented or documented
· used by anything · inputs · outputs · tested · dashboard-reachable ·
connected to real OpenClaw runtime · connected to real GitHub.

### 1.1 Workflow engine (the task lifecycle) — **built, wired, tested**

- **What**: deterministic 7-stage state machine (`product → architect →
  builder → reviewer → qa → security → release`), one task = one isolated git
  worktree, evidence-gated stage completion, independent-reviewer enforcement,
  Ed25519-signed high-risk approval gate before a high-risk build starts.
- **Where**: `factory/lib/task-workflow.mjs` (297 lines, `STAGES`,
  `completeStage`, `routeStageFailure`, evidence/independence/approval gates),
  `factory/lib/task-initializer.mjs`, `factory/lib/handoff.mjs`,
  `factory/lib/natural-language-intake.mjs`, `factory/lib/openclaw-protocol.mjs`
  (dispatch packets), `factory/lib/openclaw-runner.mjs` (actually shells out to
  `openclaw agent --agent <id> --message-file ... --json`).
- **Implemented**: yes, fully. **Tested**: yes — the bulk of the 154 green
  tests in `factory/test/*.test.mjs` (`task-workflow.test.mjs`,
  `task-entrypoints.test.mjs`, `openclaw-integration.test.mjs`) exercise it,
  including forged-signature rejection, retry-then-block, and evidence-outside-
  worktree rejection.
- **Consumes**: a task contract (`factory/templates/task.json`), the assigned
  worktree.
- **Produces**: `state.json` per task under
  `dashboard/backend/data/factory/<repoBasename>/tasks/<taskId>/`, handoff
  files, events.
- **Used by**: `scripts/openclaw-factory.mjs` (the JSON adapter),
  `scripts/factory-task.mjs`, the dashboard's Founder Control Plane.
- **Dashboard-reachable**: yes, through `founderControlPlane.mjs` →
  `/api/founder/overview` and `/api/founder/tasks`.
- **Connected to real OpenClaw runtime**: yes — `openclaw-runner.mjs` calls the
  real `openclaw` CLI with real agent ids (`main`, `product`, `architect`,
  `backend-builder`, `frontend-builder`, `reviewer`, `qa`, `security`,
  `release`, `learning`), and those agent ids **exist right now** in this
  machine's OpenClaw install (verified with `openclaw agents list --json`).
- **Connected to real GitHub**: no direct coupling — the engine works entirely
  in local worktrees/branches; PR creation/merge is explicitly out of scope for
  V1 (`README.md` "Remaining implementation milestones", item 2).
- **Reality check**: this is the most solid part of the system. It has never
  been exercised end-to-end for a real founder task in this environment — see
  §1.14.

### 1.2 Task contract — **built, wired, tested**

- **What**: the schema every task must satisfy (outcome, acceptance criteria,
  risk, scope, prior human decisions).
- **Where**: `factory/templates/task.json`, `factory/templates/task.md`,
  validated inside `task-initializer.mjs`/`task-workflow.mjs`.
- **Implemented / tested**: yes.

### 1.3 Project Intelligence layer (`factory/lib/intel/`) — **built, wired, tested**

- **What**: turns a project's `context/` files into (a) a budgeted, secret-
  scrubbed prose Context Pack injected into every stage handoff, and (b) a
  structured JSON brief (mission, vision, roadmap, decisions, memory, risks,
  ownership, `contextFindings`) used by the dashboard and the HQ layer.
- **Where**: `registry.mjs`, `schema.mjs`, `assemble.mjs` (285 lines),
  `project-brief.mjs` (272 lines), `founder-briefing.mjs` (281 lines, company
  roll-up: health score, risks, opportunities, recommended actions),
  `classify.mjs` (133 lines, the decision-protocol evaluator), `redact.mjs`.
- **Implemented / tested**: yes — `intel-*.test.mjs` (8 files).
- **Consumes**: `factory/projects.json` (the committed registry) + each
  project's own `context/*.md` + `ownership.json`.
- **Produces**: the Context Pack text prepended to every handoff (the "one
  seam" — `writeHandoff()`), and the structured brief JSON.
- **Used by**: `writeHandoff()` (so every stage dispatch), the Founder Control
  Plane (`/api/founder/overview` → `projects[].intelligence`, `.health`), and
  `factory/lib/hq/registry.mjs`.
- **Dashboard-reachable**: yes, via `/api/founder/overview`, but only for
  registered projects (currently `openclaw-factory`, `lifemaxing` —
  `factory/projects.json`).
- **Connected to real OpenClaw runtime**: indirectly — it is what an agent
  actually reads, so yes in the sense that a real dispatch really does carry
  this text (verified in `openclaw-integration.test.mjs`: "mocked OpenClaw
  execution drives a complete task to merge-ready").
- **Connected to real GitHub**: no.

### 1.4 Decision protocol / classification — **built, wired, tested**

- **What**: `classifyDecision({text, fields, protocol}) → continue |
  decision-request | ask | block`. The machine form of "when does the founder
  get pulled in."
- **Where**: `factory/decision-protocol.json` (machine table),
  `factory/context/DECISION_PROTOCOL.md` (prose), `factory/lib/intel/classify.mjs`.
- **Implemented / tested**: yes (`intel-classify.test.mjs`).
- **Used by**: architecture only right now — nothing in the pipeline calls
  `classifyDecision` automatically today; it is a pure function any stage
  agent or tool *can* call, exposed via `scripts/project-intel.mjs classify`.
  There is no automatic sensor that raises a Decision Card before a task
  starts (see §1.9 — that is Phase 3, unbuilt).

### 1.5 Headquarters Integration Layer (`factory/lib/hq/`) — **built, mostly wired, partly tested**

The newest layer (this branch, `hq-integration-layer`), described in
`HQ_INTEGRATION_LAYER.md`. It is real composition code, not a proposal.

| Module | Status | Wired into |
| --- | --- | --- |
| `config.mjs` — reads `factory/hq.config.json` | built, tested | `company-state.mjs`, `discovery.mjs` |
| `registry.mjs` — unified project registry (merges `intel/registry.mjs` + dashboard `hq/projects/*.json`) | built, tested | `company-state.mjs`, `chief-of-staff.mjs` |
| `agents.mjs` — reads/validates `factory/agents.json`, the committed workforce roster | built, tested (but **currently mid-edit, uncommitted** — see §1.15) | `company-state.mjs`, `activity.mjs` |
| `discovery.mjs` — scans `hq.config.json` workspace roots for unregistered git repos, never writes | built, tested | CLI only (`scripts/hq.mjs discover`) — **not called by the dashboard** |
| `github.mjs` — read-only `gh` CLI adapter (repo info, commits, branches, PRs, issues) | built, tested | `company-state.mjs` (opt-in `withGithub`) |
| `activity.mjs` — joins agent registry to live factory task state → "what is agent X doing" | built, tested | `company-state.mjs`, `chief-of-staff.mjs` |
| `company-state.mjs` — top aggregator, `buildCompanyState()` | built, tested | `GET /api/hq/company`, `scripts/hq.mjs state` |
| `company-context.mjs` — prepends a "Company context" block ahead of the intel Context Pack | built, tested | **not called anywhere** (grep confirms zero importers outside its own test) |
| `chief-of-staff.mjs` — the input contract shape a future Chief of Staff agent would consume | built, tested | **not called by any running agent** — there is no Chief of Staff agent implementation; this is a data-shaping function only |
| `runtime.mjs` — reads `openclaw agents list --json`, the *actual* OpenClaw runtime roster | **built, untested, uncommitted, not imported anywhere** | nothing |

- **Entry points that actually work today**: `node scripts/hq.mjs <state|
  projects|agents|discover|github|chief-of-staff>` and `GET /api/hq/company`.
- **Dashboard-reachable**: the HTTP route exists
  (`dashboard/backend/server.mjs:209`) and works. **But the dashboard frontend
  never calls it** — `dashboard/backend/public/app.js` has zero references to
  `/api/hq/company` (verified by grep across the whole file). This is the
  single most important finding in this audit: the best, most complete "state
  of the company" object the system can produce is reachable only by `curl` or
  the CLI, not by opening the dashboard.
- **Connected to real OpenClaw runtime**: `company-state.mjs` does **not**
  import `runtime.mjs`. Agent "status" (`working`/`idle`/`blocked`) in
  `activity.mjs` is derived purely from factory task-state events, never from
  whether the OpenClaw agent process/session is actually alive right now. So
  today: no, not for liveness. `github.mjs`, however, genuinely calls the real
  `gh` CLI.
- **Connected to real GitHub**: yes, when `?github=1` is passed — see §7.

### 1.6 Founder Control Plane (`dashboard/backend/lib/founderControlPlane.mjs`) — **built, wired, tested (via integration, no dedicated unit test file for this exact module beyond `founder-control-plane.test.mjs`)**

- **What**: walks every `dashboard/backend/data/factory/**/state.json`,
  builds task views, folds in project intelligence + company briefing, exposes
  pause/resume, ask-a-question (real `openclaw agent` call), decision
  resolve/approve.
- **Dashboard-reachable**: yes — this is what actually powers the "Today"
  founder view in the UI (`apiJson("/api/founder/overview")` in `app.js:154`).
- **Reality check**: because no factory task has ever actually run in this
  environment (§1.14), `discoverFactoryTasks` currently returns an **empty
  list**. The founder view's task/decision panels are correctly wired but
  structurally empty — not because of a bug, because there is nothing to show
  yet.

### 1.7 Dashboard "HQ Store" (`dashboard/backend/data/hq/*.json` +
`dashboard/backend/lib/hqStore.mjs`) — **built, wired, but seeded with placeholder data**

- **What**: a *separate*, older, richer project/agent/task/report/sops/logs
  data model (`readHqState`, `readHqCollection`, zod-validated by
  `hqSchemas.mjs`).
- **Where the data actually is right now**:
  `dashboard/backend/data/hq/projects/personal-automation.json` and
  `startup-ops.json`, `dashboard/backend/data/hq/agents.json` (3 personas:
  `chief-of-staff`, `research-analyst`, `ops-lead`), `tasks.json` (2 seed
  tasks). This is the output of `scripts/seed-hq.sh` — **demo/scaffold
  content**, not the real company. There is no `openclaw-factory` or
  `lifemaxing` project in this store at all.
- **Dashboard-reachable**: yes, and this is the problem — it is the
  **primary** thing the dashboard shows. `app.js:132` (`loadHq()` →
  `apiJson("/api/hq")`) is the first call the "Today" screen makes, and
  `/api/hq/projects/:id/profile` (used for every project detail page) reads
  exclusively from this store.
- **Consequence**: today, opening the dashboard and clicking into "projects"
  shows *Personal Automation* and *Startup Ops* — fictional example projects —
  not LifeMaxing, not the OpenClaw factory itself, and not any of the real
  work described in §4.
- **Connected to real OpenClaw runtime / GitHub**: no — this store has no path
  to either.

### 1.8 Agent Lab (registered runnable agents) — **built, wired, tested, but nearly empty**

- **What**: the only mechanism in this repo that actually **executes** an
  agent as a standalone process: a folder
  `agents/<project>/<id>/{agent.config.json,prompt.md,run.sh,logs/,outputs/}`,
  registered into SQLite (`dashboard/backend/data/db.sqlite`), runnable
  on-demand or via `pm2` (`dashboard/backend/lib/{runAgent,pm2,
  agentLifecycle,commandCenter}.mjs`, `scripts/register-agent.sh`,
  `scripts/create-agent.sh`, `scripts/start-agent.sh`,
  `scripts/restart-agent.sh`, `scripts/stop-agent.sh`).
- **Reality**: exactly **one** such folder exists in the whole repo:
  `agents/example-project/research-analyst/`. It is explicitly a worked
  example (`npm run register:example`), not a production worker.
- **This is a second, unrelated notion of "agent"** from the workflow-engine
  roles in §1.5/§3 — a role like `backend-builder` has no folder here and is
  never "registered"; it is invoked directly through the OpenClaw CLI by
  `openclaw-runner.mjs`. `agentLifecycle.mjs` explicitly encodes this split:
  an HQ persona is `executable` only if it has both a Lab folder *and* a
  SQLite registration; otherwise it is rendered as a "conceptual persona."
  Every real factory role today is a conceptual persona by this definition.
- **Dashboard-reachable**: yes (`/api/agents/*`, `/api/runs/*`,
  `/api/command-center/home`).

### 1.9 Proactive sensing / sensors — **documented only, not built**

- **Claimed by**: `PROJECT_INTELLIGENCE_SYSTEM.md` §8 ("Phase 3"),
  `COMPANY_OS_ARCHITECTURE.md` §4 (A/B/C behavior classification), listing
  `missing-context`, `blocked-decision`, `risk`, `tech-debt`, `opportunity`
  sensors and `scripts/factory-sense.mjs`.
- **Reality**: `factory/lib/sensors/` does not exist. `scripts/factory-sense.mjs`
  does not exist. `factory/lib/company/behavior.mjs` does not exist. No risk,
  opportunity, or tech-debt "finding" is ever generated automatically by
  anything in this codebase today. The only risk/opportunity data the founder
  can see is derived deterministically inside
  `intel/founder-briefing.mjs` from static `ownership.json` content the
  founder or an agent already wrote by hand (idle priorities, unmitigated
  risks already listed in the file) — real, but reactive, not sensed.

### 1.10 Founder Decision System / Decision Store — **partially built**

- **What actually exists**: task-blocker decisions
  (`state.blocker.outcome === "decision-required"`) surfaced through
  `founderControlPlane.mjs` → `openDecisions`; strategic decisions a project
  carries in its own `ownership.json.openDecisions`, folded in by
  `founder-briefing.mjs`. Resolution: `POST /api/founder/decisions/resolve`
  (writes into task `state.json`, resumes the task) and
  `/decisions/approve` (the Ed25519 signed high-risk path,
  `factory-sign-approval.mjs`).
- **What is only documented**: the unified `_company/decisions/<id>.json`
  Decision Card store with SLA/auto-expire lifecycle, `kind` taxonomy,
  `ballInYourCourt` signal, `scripts/company-decide.mjs`,
  `scripts/company-status.mjs` — all of `COMPANY_OS_ARCHITECTURE.md` §5. None
  of these files exist.
- **Net**: the founder can answer a decision that a *running* task actually
  hit. There is no mechanism today that raises a decision *before* a task
  starts, and no unified cross-project "what needs me" list beyond what
  `founder-briefing.mjs` already computes from static files.

### 1.11 Risk / opportunity / technical-debt detection — **static, not sensed**

Computed deterministically inside `intel/founder-briefing.mjs` and
`intel/project-brief.mjs` from whatever a human or agent already wrote into
`ownership.json` — `risks[]`, idle `currentPriorities`, metrics at target. No
code scans a diff, a PR, test coverage, TODO density, or repeated review
findings to *generate* a risk or debt item. Real, but entirely dependent on
someone manually maintaining `ownership.json`, which for both registered
projects today is close to template-fresh (see §4).

### 1.12 Learning / R&D system (`factory/lib/learning/`) — **built, wired, tested, never triggered on real data**

See Part 6 for the full audit. Summary: the analysis pipeline
(`analyze.mjs` 331 lines, `evidence.mjs`, `queue.mjs`, `knowledge.mjs`,
`publish.mjs`, `research.mjs`, `synthesize.mjs`, `handoff-inject.mjs`) is real,
tested, and safety-guarded (redaction, proposal-only writes, opt-in handoff
injection). It has been run twice in this environment
(`dashboard/backend/data/factory/_learning/runs/2026-09-04T*.json`) but found
**zero terminal tasks to analyze** because no factory task has ever completed.
`factory/knowledge/LESSONS_LEARNED.md`, `ENGINEERING_IMPROVEMENTS.md`, and
`PROCESS_IMPROVEMENTS.md` are all empty templates — no entry has ever been
promoted.

### 1.13 GitHub integration — see Part 7 in full.

### 1.14 Persistence / where things actually live

| State | Where | Committed? |
| --- | --- | --- |
| Task workflow state | `dashboard/backend/data/factory/<repoBasename>/tasks/<id>/state.json` | no (gitignored), and **currently empty** — no task has run in this environment |
| Learning runtime state | `dashboard/backend/data/factory/_learning/` | no; 2 runs exist, 0 findings |
| HQ Store (seed data) | `dashboard/backend/data/hq/*.json` | no; contains only demo content |
| Company/project registries | `factory/projects.json`, `factory/agents.json` | **yes**, committed |
| Project context | `context/*.md` (this repo, populated); LifeMaxing has no `context/` at all yet | mixed |
| Agent Lab SQLite | `dashboard/backend/data/db.sqlite` | no |
| Founder control-plane runtime | `dashboard/backend/data/factory/control-plane.json` | no, and **does not currently exist on disk** — no project has ever been paused/resumed or asked a question through the dashboard in this environment |

### 1.15 Work in progress on this branch (uncommitted, right now)

`git status` shows: `factory/agents.json` and `factory/lib/hq/agents.mjs`
modified, `factory/lib/hq/runtime.mjs` new and untracked. Reading the diff:
someone (an agent, mid-task) is in the middle of converting the agent registry
from "one entry per model" (`claude-main`, `codex-builder`, `cursor-builder`)
to "one entry per organizational role" (`chief-of-staff`, `product`,
`architect`, `backend-builder`, `frontend-builder`, `reviewer`, `qa`,
`security`, `release-manager`, `research`, `learning-agent`) with a `harness`
field naming the model that powers it — exactly the correction Part 3 of this
audit was asked to make. `runtime.mjs` (reading the live OpenClaw roster) is
the connective piece that would let this new roster be checked against
reality. **Neither change is finished**: `runtime.mjs` is not imported by
`company-state.mjs`/`activity.mjs`, has no test file, and is not run by
`npm run test:factory`. This is good direction, mid-flight, not yet load-
bearing.

---

## PART 2 — The real flow vs. the documented flow

```
Founder
  ↓ REAL: writes context/*.md, ownership.json by hand; starts a task via
    dashboard "Today" (POST /api/founder/tasks) or the CLI
    (scripts/openclaw-factory.mjs / factory-task.mjs)
  ↓
Headquarters
  ↓ REAL for read: GET /api/hq/company (CLI/curl only, not in the UI)
  ↓ REAL for write: dashboard "Today" screen → founderControlPlane.mjs
  ↓ PLANNED, NOT BUILT: a Chief of Staff *agent* that actually runs
    (chief-of-staff.mjs only shapes the input a future agent would get;
    there is no prompt, no dispatch, no loop)
  ↓
Chief of Staff / task intake
  ↓ REAL: natural-language-intake.mjs turns free text into a task contract
  ↓
Project intelligence
  ↓ REAL: intel/assemble.mjs injects factory+project context into the handoff
    — but only for the 2 registered projects, and LifeMaxing's context/ does
    not exist yet, so LifeMaxing tasks get factory context + a "not
    registered/no context" degrade, not real project knowledge
  ↓
Task contract
  ↓ REAL, tested
  ↓
Agent / harness
  ↓ REAL: openclaw-runner.mjs really calls `openclaw agent --agent <id>`,
    and those agent ids really exist in this machine's OpenClaw install
  ↓
Workflow engine
  ↓ REAL, tested, has never carried a real task to completion in this
    environment (§1.14) — proven only by unit tests + `factory:smoke`
  ↓
Evidence / QA / review
  ↓ REAL as a gate (independence + evidence-must-exist-in-worktree are
    enforced and tested); no task has produced real evidence yet
  ↓
GitHub / delivery
  ↓ PARTIALLY REAL: `gh` is authenticated to the founder's real account and
    can read; nothing in this pipeline creates or updates a PR — that is an
    explicitly deferred milestone (README.md)
  ↓
Learning
  ↓ REAL pipeline, tested, has run twice, found nothing (no terminal tasks
    exist to learn from)
  ↓
Knowledge
  ↓ REAL storage (factory/knowledge/*.md), currently empty
  ↓
Improved future agents
  ↓ PLANNED: `learning.injectIntoHandoff` exists and is wired
    (handoff-inject.mjs, tested) but defaults to `false` in
    factory.config.json and there is nothing yet to inject
```

**Bottom line**: every arrow in this chain has real, tested code behind it.
The chain has simply never been run end to end for a real founder task inside
this environment — except once, informally: LifeMaxing (§4) has real commits
on a real branch in a real worktree, but that work happened **outside** this
tracked pipeline (no `state.json` exists for it anywhere on disk). That is the
single clearest piece of evidence that the system's map of reality and actual
reality have already diverged once.

---

## PART 3 — Agent reality (roles, not models)

Claude, Codex, Cursor, and OpenClaw are **harnesses** — the model/tool that
executes a role. The organizational roles below are what actually exists in
`factory/agents.json` (uncommitted version, described in §1.15 — this is the
version currently on disk and is more accurate than what's in `main`).

| Role | Harness (model/tool) | Capabilities / responsibility | Project assignment | Current state | Reports to | Inputs | Outputs | Defined in | Executes today? | Visible to founder? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Chief of Staff | OpenClaw (`main`) | Turn goals into bounded work, classify risk, route, summarize, escalate | none fixed | idle | founder | founder goal (free text) | task contract | `factory/prompts/chief-of-staff.md` + `factory/agents.json` | **Partially** — `natural-language-intake.mjs` does the mechanical part; there is no running "Chief of Staff agent" loop, only architecture (`hq/chief-of-staff.mjs`) that shapes its future input | No — no activity feed exists for it |
| Product | OpenClaw (`product`) | Normalize outcome + acceptance criteria | per-task | idle | Chief of Staff | task contract draft | normalized outcome | `factory/prompts/product.md` | **Yes** — real OpenClaw agent id `product` exists on this machine (verified) and is dispatched by the pipeline | Only via task-state events, once a task runs |
| Architect | Claude | Technical design, challenge non-trivial architecture, read-mostly | per-task | idle | Chief of Staff | product-normalized outcome | design decision, interfaces, rollback | `factory/prompts/architect.md` | Yes (agent id `architect` verified live) | Same as above |
| Backend/general Builder | Codex | Primary implementation, tests, branch, PR | per-task | idle | Chief of Staff | architect design | code + PR | `factory/prompts/builder.md` | Yes (agent id `backend-builder` verified live) | Same as above |
| Frontend/UI Builder | Cursor | UI implementation, visual iteration; also founder's own IDE | per-task | idle | Chief of Staff | design + acceptance criteria | UI code + PR | `factory/prompts/builder.md` (shared) | Yes (agent id `frontend-builder` verified live) | Same as above |
| Reviewer | "multiple" (always a different model from the builder) | Independent correctness/security/product review | per-task | idle | Chief of Staff | PR diff | review findings | `factory/prompts/reviewer.md` | Yes (agent id `reviewer` verified live) | Same as above |
| QA | "multiple" (different harness from builder) | Verify acceptance criteria, attempt failure cases | per-task | idle | Chief of Staff | build + acceptance criteria | evidence | `factory/prompts/qa.md` | Yes (agent id `qa` verified live) | Same as above |
| Security | Claude | Secret exposure, permissions, injection, privacy gate | per-task | idle | Chief of Staff | full diff | pass/fail + findings | `factory/prompts/security.md` | Yes (agent id `security` verified live) | Same as above |
| Release Manager | deterministic gates + OpenClaw | Merge-readiness check, surface blockers, never merges | per-task | idle | Chief of Staff | all prior stage evidence | merge-ready / blocked | `factory/prompts/release.md` | Yes (agent id `release` verified live) | Same as above |
| Research Agent | Claude | Turn an open question into a sourced brief | none | idle | founder | a question | `ResearchNote` (source-cited) | referenced in `factory/agents.json`; implementation is `factory/lib/learning/research.mjs` (`runResearch`) | Yes — tested, callable via `npm run factory:learn -- research`; **not** an OpenClaw runtime agent id (`runtimeAgentId: null`) | No dashboard surface for research notes at all |
| Learning / R&D Agent | OpenClaw (`learning`) | Analyze failures/successes, research, distill company knowledge, propose prompt/gate changes | company-wide, not project-assigned | idle | founder | terminal task state | findings, digest, knowledge PRs | `factory/prompts/learning-agent.md`, `factory/lib/learning/*` | Yes (agent id `learning` verified live in OpenClaw; the analysis pipeline itself needs no model call and has run) | Findings JSON + digest.md exist on disk but are **not read by any dashboard route** — `chief-of-staff.mjs::readLearningFindings` reads them, but nothing calls `chief-of-staff.mjs` from the server |

**What the dashboard would need to show, per worker, to answer "what is this
worker doing?"**: current project + current task id/objective, current stage,
status (working / waiting-on-harness / blocked / idle), the last handoff it
received (so the founder can audit exactly what context it had), the last
result it returned, time since last activity, and — critically, and currently
absent everywhere — whether the underlying OpenClaw session is actually alive
right now (this is exactly what `hq/runtime.mjs` was written to provide and is
not yet wired in).

**Correcting a common misconception this audit was asked to check for**: the
system does *not* currently confuse Claude/Codex/Cursor with organizational
roles in its data model — `factory/agents.json` (the in-progress version) gets
this right. The confusion exists in `factory/factory.config.json`'s
`openclawIntegration.agentIds`, which is fine (it is explicitly a harness-id
mapping), and in the *committed* (pre-this-branch) version of `agents.json`,
which the diff in §1.15 is actively fixing.

---

## PART 4 — Project reality

The system knows about exactly **two** registered projects
(`factory/projects.json`, the only committed source of truth for "what
projects exist"):

### `openclaw-factory` (this repository)

- **Actual repository**: this repo (`repo: "."`).
- **GitHub repository**: `7thcapitalist/Openclaw-Agents-Headquarter` — real,
  verified reachable via `gh repo view`.
- **Context location**: `context/` at repo root — **populated**, real prose
  (`MISSION.md`, `VISION.md`, `ROADMAP.md`, `DECISIONS.md`, `MEMORY.md`,
  `TECH_CONTEXT.md`, `USERS.md`, `COMPETITIVE_CONTEXT.md`, `ownership.json`).
- **Mission/Vision/Roadmap/Decisions/Memory**: all present and substantive
  (`context/MISSION.md`: "Building the intelligence layer that makes every
  project in the factory carry a durable understanding of itself…").
  `docs/software-factory/DECISIONS.md` has 6 accepted, dated decisions
  (SFD-2026-001 through 006).
  `factory/agents.json`, `factory.config.json`.
- **Users**: this is the factory itself — no external users; `context/USERS.md`
  frames the founder as the only user.
- **Ownership**: founder.
- **Responsible workers**: listed in `factory/projects.json.responsibleAgents`
  — currently still names the *old* agent ids (`claude-main`, `codex-builder`,
  `learning-agent`), which is now stale relative to the §1.15 roster rewrite.
- **Current tasks / current workers**: none active (§1.14).
- **Current risks/opportunities**: whatever is hand-written in
  `context/ownership.json` — not independently sensed.
- **Health / GitHub state**: computable via `founder-briefing.mjs` and, with
  `?github=1`, real commit/PR/issue data — but not shown anywhere in the UI by
  default.

### `lifemaxing`

- **Actual repository**: `~/projects/lifemaxing` — real, but **almost
  empty at its main branch** (only a `.git` directory; `git log` on `main`
  shows a single init commit, `24162c5 chore: initialize Lifemaxing
  repository`). All real work is on a separate branch/worktree —
  `~/projects/worktrees/lifemaxing-d0-foundation`, branch `task/d0-foundation`,
  3 further commits (`feat: establish private D0 foundation`, `fix: make
  verification independent of pnpm shim`, `fix: harden D0 foundation
  contracts`) — a genuine Next.js app with `migrations/`, `tests/`, `docs/`,
  `.github/`, its own `run.sh`. This is real, substantial engineering output.
- **GitHub repository**: **none** — `git remote -v` is empty. Not pushed
  anywhere. `factory/projects.json` also has no `github` block for this
  project.
- **Context location**: `factory/projects.json` declares `contextDir:
  "context"`, but **no `context/` directory exists in the LifeMaxing repo at
  all** (checked directly). So today a LifeMaxing task gets factory context
  only, degrading gracefully (per `assemble.mjs`'s design) rather than
  erroring — but the founder gets none of Mission/Vision/Roadmap/Decisions for
  this project through the intelligence layer.
- **Mission**: only what's in `factory/projects.json.mission` ("AI-native
  productivity tools that help users improve their lives.") — one line, no
  detail.
- **Ownership / responsible workers**: `founder`; `["claude-main",
  "codex-builder"]` — stale ids, same issue as above.
- **Current tasks/workers**: the `task/d0-foundation` work is **not tracked by
  the factory workflow engine at all** — no `state.json` exists for it
  anywhere (checked across the whole filesystem). Whoever/whatever did this
  work did it directly against the worktree, bypassing
  `task-initializer.mjs`/`task-workflow.mjs` entirely. This means: no evidence
  gate was enforced, no independent reviewer was required, no QA record
  exists, and the founder has no record inside this system of what happened,
  why, or whether it's safe.
- **Health/GitHub state**: not computable — no GitHub repo, no context, no
  tracked task state.

### Why LifeMaxing (the founder's actual real work) is effectively missing from the dashboard

1. It has no `github` entry in `factory/projects.json`, so GitHub awareness
   can never populate for it even with `?github=1`.
2. It has no `context/` directory, so it shows as a near-empty intelligence
   brief.
3. Its most substantial work (the D0 foundation branch) was done outside the
   tracked workflow engine, so it produces zero events, zero evidence, and
   zero task rows anywhere the dashboard reads from.
4. The dashboard's default landing view (`/api/hq`) doesn't read
   `factory/projects.json` at all — it reads the seed `hq/projects/*.json`
   store, which has never heard of LifeMaxing.

### Other real repositories

`hq.config.json` discovery is configured to scan `~/projects` (depth 2). Only
`lifemaxing` exists under it (plus a `worktrees/` directory that is not a git
repo itself and would be skipped). `hq/discovery.mjs` would find nothing new
to propose today. No other real project repository exists on this machine
under the configured discovery root.

### `examples/hq/*` and `agents/example-project/*`

Sanitized, static, intentionally-fake reference fixtures shipped with the repo
(same shape as `dashboard/backend/data/hq/*` but explicitly example data —
`examples/hq/projects/personal-automation.json` etc.). Not a project registry;
not live; exist to document the schema.

---

## PART 5 — Intelligence layer

**Can an agent currently receive Global Founder context + Company/HQ context +
Project context + Task context + relevant learned knowledge?**

**Partially — three of five, reliably; the other two exist as code paths that
are either off by default or effectively empty right now.**

Real code path, in order, for any dispatched stage (`writeHandoff()` in
`factory/lib/handoff.mjs`):

1. `assembleContextPack()` (`factory/lib/intel/assemble.mjs`) — **factory
   context** (operating mode, prohibited actions, gates, decision protocol)
   always included. **Project context** (mission, roadmap, decisions, memory,
   tech constraints, users, risks) included when the task's project key
   resolves in `factory/projects.json` and has a `context/` directory —
   verified true for `openclaw-factory`, verified **false** for `lifemaxing`.
2. `buildKnowledgeBlock()` (`factory/lib/learning/handoff-inject.mjs`) — company
   knowledge (accepted lessons). **Off by default**
   (`factory.config.json.learning.injectIntoHandoff: false`, or env
   `FACTORY_LEARNING_IN_HANDOFF`) and, even if turned on, there is nothing to
   inject yet (§6).
3. Task context — outcome, acceptance criteria, constraints, prior handoffs —
   always included; engine-owned, not part of the intelligence layer.
4. **Company/HQ context** — the "Company context" block described in
   `hq/company-context.mjs` (company mission + live company state) is real
   code, unit-tested, and **not called by `writeHandoff()` or anything else**.
   Verified by grep: zero non-test importers. So today, no dispatched agent
   ever actually receives it.
5. **Global Founder context** — there is no distinct "founder-authored global
   context" artifact separate from the factory's own `context/` files (no
   `founder/*.md` file is read by the assembler at all — `founder/*.md` exists
   on disk but is not wired into any context path; it appears to be read only
   by a human).

**If no**: the missing connections are (4) `hq/company-context.mjs` never
called from `writeHandoff()`, and (5) no code path reads `founder/*.md` into
any pack.

Other Part 5 items:

- **Context precedence**: no `precedence.mjs`/ladder exists in code
  (`COMPANY_OS_ARCHITECTURE.md` §2.4 is a proposal). Today, precedence is
  whatever order `assemble.mjs` concatenates sections in — implicit, not
  adjudicated.
- **Context isolation / project isolation**: real and enforced —
  `intel/redact.mjs`'s `assertInsideDir` guard, and the registry resolves
  exactly one project's `contextDir` per task; tested
  (`intel-redact.test.mjs`).
- **Secret redaction**: real — filename refusal (`.env*`, `*.pem`, `id_rsa*`,
  `credentials*`, `secrets*`) and value scrubbing (AWS keys, `sk-…` tokens,
  `gh[pousr]_…`, bearer tokens, PEM blocks, `postgres://user:pass@`), tested.
- **Decision classification**: real, tested (§1.4), but not automatically
  invoked mid-pipeline — a stage agent has to actually apply the protocol
  itself (it is instructed to via its prompt, not enforced by code).
- **Risk classification**: real for task-level risk (`low/medium/high` in the
  task contract, enforced by the engine's approval gates); not real for
  ongoing risk sensing (§1.11).
- **Founder escalation**: real for `decision-required` blockers reached mid-
  task; not real as a proactive "you should decide this before we start"
  signal (that's the unbuilt sensor layer).
- **Opportunity / technical-debt / blocked-work detection**: static,
  hand-authored-file-dependent, not sensed (§1.11).

---

## PART 6 — Learning system

- **What it observes**: terminal task `state.json` files —
  `dispatches` with `outcome: "fail"`, `failure-routed` events, blockers,
  stage evidence, stage summaries (`factory/lib/learning/analyze.mjs`).
- **What it learns**: recurring failure categories, retry burn, decision
  friction, clean-first-pass successes, agent-improvement candidates.
- **Where findings are stored**: `dashboard/backend/data/factory/_learning/`
  — `findings.json` (the reconciled queue, deduped by fingerprint),
  `runs/<timestamp>.json` (raw run log), `digest.md` (human-readable),
  `proposals/` (draft knowledge entries), `research/` (sourced notes).
- **How findings are evaluated**: deterministic classification in
  `analyze.mjs`, no model call, no network — pure function over `state.json`.
- **How research works**: `factory-learn.mjs research --topic <x>` drives a
  bounded OpenClaw pass, output validated by `parseResearchNote` (requires a
  real source URL, redacted, tested) — real and callable, but not scheduled
  anywhere.
- **How lessons become recommendations**: `synthesize` drafts knowledge-file
  entries + the founder digest from the findings queue (dry-run by default).
- **How recommendations become changes**: `promote` opens a `learning/*`
  branch + PR (`--publish`) for a knowledge entry, or scaffolds a low-risk
  factory task contract when a prompt/routing/gate change is warranted. Both
  require an explicit human-triggered command.
- **How project lessons become company knowledge**: `factory/knowledge/*.md`
  are the company-wide files; nothing has ever been promoted into them
  (verified: all three are empty templates, "Do not delete an entry" with zero
  entries beneath the marker).
- **What requires founder approval**: everything that writes anywhere outside
  `_learning/` — every knowledge-file change and every prompt/gate change goes
  through a normal PR + independent review + human merge, same as any other
  factory change. This is a real, enforced boundary (redaction guard runs on
  every fragment; SFD-2026-006 codifies "read-only and proposal-driven").
- **Does learning affect future agent behavior**: only if (a) a founder merges
  a knowledge PR or prompt-edit PR, **and** (b)
  `learning.injectIntoHandoff` is turned on. Both are currently false/absent.
- **Is the Learning Agent executable today**: yes as a pipeline
  (`factory-learn.mjs analyze|list|synthesize|promote|dismiss|research|prune`
  all run and are tested), and yes as an OpenClaw runtime agent id (`learning`
  exists live). It has **already run twice** in this environment
  (`_learning/runs/2026-09-04T03-00-15-904Z.json`,
  `...T03-21-31-807Z.json`), correctly finding **zero** terminal tasks (none
  exist).
- **Automatic or manual**: manual only. "No daemon" is explicit in
  `COMPANY_LEARNING_SYSTEM.md` — the founder is expected to add cron entries;
  none exist in this environment (no crontab, no systemd timer, no `openclaw
  cron` entry was found for `factory:learn` or `factory-sense`).

**Direct answer to the founder's question: is the company actually capable of
learning today, or have we mostly built the infrastructure for future
learning?**

**Infrastructure for future learning.** The pipeline is real, safe, and well
tested, but it has nothing to learn from yet (zero completed tasks) and
nothing runs it on a schedule. The LifeMaxing D0 work — the one substantial
piece of real engineering that has happened — is invisible to it, because it
bypassed the tracked workflow engine entirely (§4). Until real tasks flow
through the tracked pipeline, this system cannot learn anything, no matter how
well-built the learning code is.

---

## PART 7 — GitHub

- **Authentication method**: the `gh` CLI's own stored auth (`gh auth
  status` confirms: logged in as **7thcapitalist**, token scopes `gist,
  read:org, repo, workflow`). Not a token stored in this repo or in HQ state —
  it rides on the operator's own `gh` session, injected via `execFile("gh",
  …)` in `factory/lib/hq/github.mjs`.
- **Repository discovery**: not automatic from GitHub's side — a project must
  declare `github: {owner, repo}` in `factory/projects.json`. Only
  `openclaw-factory` does; `lifemaxing` does not (and has no remote to
  declare).
- **Commit/PR/issue visibility**: real and working —
  `readRepoAwareness({owner, repo})` calls `gh repo view`, lists commits,
  branches, open PRs, open issues, verified reachable
  (`gh repo view 7thcapitalist/Openclaw-Agents-Headquarter` succeeds live).
- **Read-only**: yes, strictly — every call in `github.mjs` is a read (`repo
  view`, `pr list`, `issue list`, etc.); nothing creates, comments on, or
  merges anything. This matches the explicitly deferred milestone in
  `README.md` ("GitHub PR creation/update … " is future work).
- **Connected to project state**: yes, through `company-state.mjs`'s
  `external[]`, keyed by project.
- **Connected to dashboard state**: technically yes (`/api/hq/company?github=1`
  works), but **not reachable from the UI** — same gap as §1.5. The dashboard
  frontend never requests GitHub data.
- **Querying the founder's real account/repos**: yes, confirmed live —
  this is not a mock or a stub; it is real, authenticated, and scoped to the
  actual GitHub account.

---

## PART 8 — Dashboard gap analysis

**Legend**: Exists in code = the capability is implemented somewhere.
Exists at runtime = real (non-seed, non-empty) data currently backs it in
this environment. Visible in dashboard = reachable by opening the web UI
today, no curl/CLI required.

| Information | Exists in code? | Exists at runtime? | Visible in dashboard? | Missing connection |
| --- | --- | --- | --- | --- |
| Real projects (openclaw-factory, lifemaxing) | Yes (`factory/projects.json`) | Yes | **No** — UI reads seed `hq/projects/*.json` instead | `app.js` never calls `/api/hq/company`; `/api/hq/projects*` reads `hqStore.mjs`, not `factory/projects.json` |
| Real workers/roles (product, architect, builders, reviewer, qa, security, release, learning) | Yes (`factory/agents.json`, live OpenClaw ids) | Yes (verified live) | **No** — UI shows 3 seed personas (`chief-of-staff`, `research-analyst`, `ops-lead`) instead | Same as above; `hq/runtime.mjs` also not wired |
| Worker assignments | Yes (`activity.mjs`) | Empty (no tasks have run) | No | `/api/hq/company` not called by UI; also nothing to show yet |
| Current tasks / current stage | Yes (`founderControlPlane.mjs`) | Empty (no real task run) | **Yes** (`/api/founder/overview` is wired to the UI) | none — this one is genuinely connected, just empty |
| Worker status (working/blocked/idle) | Yes (`activity.mjs`) | Empty | No | same as row 2 |
| Blockers | Yes (task `blocker` field) | Empty | Yes, when present | none, correctly wired |
| Founder decisions | Yes (`openDecisions`) | Empty | Yes | none, correctly wired |
| Risks | Yes (`founder-briefing.mjs`) | Sparse (template `ownership.json`) | Yes, via `/api/founder/overview` | none for wiring; data itself is thin |
| Opportunities | Yes (`founder-briefing.mjs`) | Sparse | Yes | same |
| Project health | Yes (deterministic score) | Yes, computable | Yes | none |
| Project context (mission/vision/roadmap/decisions) | Yes | Yes for `openclaw-factory`; **missing** for `lifemaxing` | Yes, via `/api/founder/overview` | LifeMaxing has no `context/` dir |
| Company context (company-wide mission + state) | Yes (`hq/company-context.mjs`) | N/A | **No** | never called by `writeHandoff()` or any dashboard route |
| GitHub (commits/PRs/issues) | Yes (`hq/github.mjs`) | Yes, real, live | **No** | only reachable via `/api/hq/company?github=1`; UI never requests it |
| Learning findings/digest | Yes | Empty (0 findings) | **No** | `chief-of-staff.mjs::readLearningFindings` exists but nothing calls it from the server |
| Research notes | Yes | None generated yet | No | no dashboard route reads `_learning/research/` at all |
| Technical debt | Documented only | N/A | No | sensor layer unbuilt |
| Process/engineering improvements (knowledge files) | Yes (storage) | Empty | No | no route reads `factory/knowledge/*.md`; would be empty anyway |
| Evidence (per stage) | Yes (`state.stages[].evidence`) | Empty | Partially — decision-card evidence is parsed for blocked tasks only | no general evidence viewer |
| QA results | Yes (stage evidence) | Empty | No dedicated view | none built |
| Releases / merge-readiness | Yes (engine terminal state) | Empty | Implicit in task status only | no releases view |
| Activity history | Yes (`state.events`, `founderControlPlane` activity feed) | Empty | Yes | none, correctly wired, just empty |
| Agent Lab runnable agents | Yes | 1 example agent | Yes | working as designed, but this is a demo, not the real workforce |
| Real OpenClaw runtime liveness | Yes (`hq/runtime.mjs`, orphaned) | Yes if wired | No | not imported anywhere |

**Reading this table plainly**: almost every capability the founder listed
already has real code behind it. The dashboard's problem is not "we haven't
built X" for most rows — it's that **the UI reads the wrong data source** (the
seed `hq` store instead of the real `factory/projects.json` +
`factory/agents.json` + `hq/company-state.mjs`), and a second set of rows
(company context, GitHub, learning findings, research) is fully built and
API-reachable but simply **never requested by the frontend**.

---

## PART 9 — Founder experience: the ideal information architecture (design only, not implemented)

Answering the founder's 14 questions requires exactly the objects the system
can already produce — the gap is composition and surfacing, not new sensing,
for questions 1–11 and 14. Questions 12–13 need new capability.

1. **What is happening right now?** → `buildCompanyState().summary` +
   `activity` — already computed by `company-state.mjs`; just needs to be the
   dashboard's landing call instead of `/api/hq`.
2. **Who is working on what?** → `activity.agents[]` (real roster ×
   real task state) — needs `runtime.mjs` wired in for true liveness, not just
   task-derived status.
3. **What projects exist?** → `registry.mjs`'s unified project list, not
   `hqStore.mjs`'s seed list.
4. **Which projects are healthy?** → `founder-briefing.mjs` health score — already computed, needs a project list view that shows it prominently.
5. **What is blocked?** → `state.decisions` / `activity.agents[].blocked` — already computed.
6. **What decisions require me?** → `company.openDecisions` — already computed; needs to become the literal first thing rendered, not buried.
7. **What are my workers worried about?** → `company.risks` — real but thin until `ownership.json` is actually kept current per project; this is a content problem more than a code problem.
8. **What opportunities have they found?** → `company.opportunities` — same caveat.
9. **What is the company learning?** → `readLearningFindings()` — built, orphaned; needs a route + a panel.
10. **What has changed recently?** → `founderControlPlane`'s activity feed — already computed.
11. **What is happening in GitHub?** → `external[]` — built, orphaned; needs the UI to actually call `?github=1` and needs `lifemaxing` to get a `github` block once it's pushed.
12. **What should I personally do next?** → `company.recommendedActions` exists as a ranked list already (`founder-briefing.mjs`); genuinely under-surfaced, this is the closest thing to an actual "do this next" the system has and it is not shown anywhere in the UI today.
13. **What are agents doing autonomously?** → **this is the one real gap.**
    Nothing today runs autonomously on a schedule (no cron is configured for
    learning, sensing, or discovery). Until something is actually scheduled,
    the honest answer to this question is "nothing, yet" — the dashboard
    should say that plainly rather than imply background activity that isn't
    happening.
14. **Where is the system blind?** → this audit itself is the closest thing
    to an answer that exists; the system does not currently compute its own
    blind spots. A cheap, honest version of this (missing `context/` dirs,
    projects with no GitHub link, agents whose OpenClaw id doesn't resolve,
    zero recent activity) is entirely derivable from data the system already
    has (`contextFindings`, `runtime.mjs` reachability, `discovery.mjs`
    proposals) — none of it is composed into one place today.

**Information architecture, not UI**: one "company state" object
(`buildCompanyState()` is already 90% of this) should be the *single* thing
the dashboard's home view renders, with the seed `hqStore` retired or clearly
relabeled as a sandbox/demo mode, GitHub and learning folded in by default
(not opt-in query params the UI never sets), and a self-reported "blind spots"
section computed from warnings the system already collects (`warnings[]` is
threaded through nearly every module in `factory/lib/hq/*` already — it is
just never rendered).

---

## PART 10 — What is actually working? (brutally honest)

| Subsystem | Rating | Why |
| --- | --- | --- |
| Workflow engine (7-stage state machine, gates, worktree isolation) | 🟢 GREEN | Fully built, fully tested, real OpenClaw dispatch wired in. Only caveat: never exercised on a real task in this environment. |
| Task contract / natural-language intake | 🟢 GREEN | Built, tested, used by the founder-facing "start work" flow. |
| Project Intelligence layer (context assembly, briefs, redaction) | 🟢 GREEN for `openclaw-factory`; 🟡 YELLOW company-wide (only 1 of 2 projects has real context) |
| Decision classification (`classify.mjs`) | 🟡 YELLOW | Correct and tested, but nothing calls it automatically — it's a tool an agent must choose to use. |
| HQ Integration Layer aggregation (`company-state.mjs` and friends) | 🟡 YELLOW | Genuinely built and correct, reachable by API/CLI — but invisible to the founder because the dashboard UI never calls it. |
| `hq/runtime.mjs` (real OpenClaw liveness) | 🔴 RED | Written, correct-looking, zero tests, zero callers. Not load-bearing yet. |
| `hq/company-context.mjs` | 🔴 RED | Built, tested in isolation, never invoked by anything that actually dispatches an agent. |
| Chief of Staff | 🔴 RED | No running agent. `chief-of-staff.mjs` only shapes a future input contract. |
| Founder Control Plane (dashboard "Today" screen) | 🟢 GREEN as code, 🟡 YELLOW in practice | Correctly wired end to end, but structurally empty because no factory task has run. |
| Dashboard "HQ Store" (projects/agents/tasks the UI actually shows first) | 🔴 RED as a source of truth | Fully working code, but the data behind it is 100% seed/demo content unrelated to the real company. |
| Agent Lab (runnable agent folders) | 🟡 YELLOW | Works, but exactly one example agent exists; no real worker uses this mechanism today. |
| Real project registry (`factory/projects.json`) | 🟡 YELLOW | Correct for `openclaw-factory`; `lifemaxing` entry is stale/thin (no GitHub, no context, wrong repo path style). |
| Real workforce registry (`factory/agents.json`) | 🟡 YELLOW | Being actively corrected right now (uncommitted); the committed version conflates roles and models. |
| GitHub integration | 🟢 GREEN as code and auth, 🔴 RED as a founder-visible feature | Real, authenticated, working, entirely absent from the UI. |
| Decision Store / SLA / auto-expire (`COMPANY_OS_ARCHITECTURE.md` §5) | 🔴 RED | Documented only. Zero code. |
| Sensors (missing-context, risk, opportunity, tech-debt, blocked-decision) | 🔴 RED | Documented only. Zero code. |
| Company Learning Agent as a "permanent role" with `company/` tier, behavior protocol, A/B/C classifier | 🔴 RED | Documented only (`COMPANY_OS_ARCHITECTURE.md`). The *actually built* Learning system (`factory/lib/learning/*`) is a different, real, more modest thing — see next row. |
| Learning pipeline (`factory/lib/learning/*`, `factory-learn.mjs`) | 🟢 GREEN as code, 🔴 RED as a working feature | Built, tested, safety-guarded, has run twice — found nothing because nothing has ever completed. Knowledge base is empty. No schedule exists. |
| LifeMaxing (the founder's actual product) | 🟡 YELLOW as engineering, 🔴 RED as tracked factory work | Real, substantial Next.js app exists with real commits. Entirely untracked by every system this audit covers — no state, no evidence, no review record, no GitHub remote. |
| Automation / scheduling (cron, daemons) | 🔴 RED | None configured anywhere. Every "learning," "sensing," or "discovery" capability is manual-trigger-only today. |

---

## PART 11 — Recommended next build (smallest set of steps)

Ordered by the founder's stated priorities. Nothing here proposes a second
workflow engine, a second registry, or a new agent — every step below is
"finish wiring something that already exists" or "point an existing UI call at
the right data."

1. **Make `GET /api/hq/company` the dashboard's home-view data source**,
   replacing (or merging alongside, clearly labeled) the seed `hqStore.mjs`
   data. This single change fixes the largest gap in this audit: real
   projects, real workforce, real health, real decisions become visible with
   no new backend code.
2. **Wire `hq/runtime.mjs` into `activity.mjs`/`company-state.mjs`** so
   worker status reflects whether the OpenClaw session is actually alive, not
   only task-derived status. Add the test file it's currently missing.
3. **Fix `factory/projects.json` for LifeMaxing**: add a `github` block once
   it has a remote, and scaffold its `context/` directory (the templates
   already exist at `factory/templates/project-context/`) so it stops
   degrading to "no context."
4. **Make the dashboard request GitHub-enriched company state by default**
   (drop the opt-in query param, or default it on) — the auth and adapter
   already work; this is a one-line UI change plus accepting the latency.
5. **Surface `readLearningFindings()`** (already written in
   `chief-of-staff.mjs`) behind a small dashboard route/panel — makes the
   Learning system's (currently empty, honestly-reported) state visible
   instead of silently absent.
6. **Reconcile `factory/agents.json`**: finish and commit the in-progress
   role-based rewrite (§1.15), and fix the stale `responsibleAgents` arrays in
   `factory/projects.json` to reference the new ids.
7. **Route at least one real task through the tracked pipeline** (even a
   small one) so the Founder Control Plane, evidence gates, and Learning
   system have something real to show and learn from — this is the only way
   to validate everything above with real data instead of an empty-but-
   correct state.
8. **Only after 1–7**: consider Phase 3 sensors / the Decision Store / the
   Company Learning Agent's `company/` tier from `COMPANY_OS_ARCHITECTURE.md`
   — genuinely new capability, and premature while the system can't yet show
   the founder what it already knows.

Explicitly **not** recommended: rebuilding the workflow engine (it's the
strongest part of the system), building a second project or agent registry
(the two that exist need reconciling, not multiplying), or building the
sensor/Decision-Store layer before the visibility gaps above are closed —
sensors that feed into a dashboard nobody looks at compound the exact problem
the founder is describing.

---

## Founder summary

**What I actually built**: a genuinely solid, well-tested deterministic
workflow engine; a real project-intelligence/context-injection system with
working secret redaction; a real, authenticated, read-only GitHub adapter; a
real (if never-yet-exercised) Learning pipeline with safety guarantees; and, on
this branch, a new Integration Layer (`factory/lib/hq/`) that correctly
composes all of the above into one "state of the company" object. 154 tests
pass, covering almost everything described here as GREEN or YELLOW.

**What is genuinely working**: the engine, the intelligence layer for
`openclaw-factory`, the redaction/isolation guarantees, GitHub read access
(real account, real data), and the Founder Control Plane's task/decision
plumbing — all correctly wired, all currently mostly empty because the system
has not yet been used for a real end-to-end task.

**What is disconnected**: the dashboard you actually open shows demo data
(`Personal Automation`, `Startup Ops`) instead of your real company
(`openclaw-factory`, `LifeMaxing`) and your real workforce, because it reads
an old seed data store instead of the new Integration Layer. GitHub awareness,
company context injection, and learning findings are fully built and API-
reachable but never called by the UI. LifeMaxing's real, substantial D0-
foundation work exists entirely outside every tracking system this audit
covers.

**What I cannot currently see**: what your agents are actually doing right
now (no live liveness check is wired in), what GitHub actually shows for any
project (built, not surfaced), whether the company has learned anything
(built, empty, not surfaced), and any independent risk/opportunity/debt
signal the system found on its own (nothing senses anything yet — every risk
or opportunity you'd see today is something a human already typed into a
file).

**What the dashboard should become**: one place that renders
`buildCompanyState()` (already 90% of the right object) as the home view, with
GitHub and learning folded in by default and a plain, honest "here's what I
don't know" section — rather than four different, disconnected data sources
competing to be "the" view of the company.

**The 3 highest-priority next steps**:

1. Point the dashboard's home view at `GET /api/hq/company` instead of the
   seed `hqStore` — the single highest-leverage change available, requiring
   zero new backend code.
2. Fix LifeMaxing's registration (`github` block, `context/` scaffold) and run
   one real task through the tracked pipeline, so every system this audit
   describes has real data to show and learn from instead of empty-but-
   correct state.
3. Wire the three orphaned modules that already exist and already work —
   `hq/runtime.mjs`, `hq/company-context.mjs`, `chief-of-staff.mjs`'s
   `readLearningFindings()` — into the things that actually run, so "built" and
   "true today" stop being different claims.

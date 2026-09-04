# Headquarters Integration Layer

The Integration Layer connects the systems OpenClaw Headquarters already has
(factory workflow engine, intelligence layer, Founder Control Plane, learning
agent) into **one read-only view of the company**: projects, agents, and the
external world (GitHub).

It adds no second workflow engine, no new UI, and no new sensing system. It is
composition on top of what exists.

---

## 1. Architecture map — what already existed

### Project intelligence (`factory/lib/intel/`)

| Module | Responsibility |
| --- | --- |
| `registry.mjs` | Read/resolve `factory/projects.json` — the committed project registry (`key`, `repo`, `contextDir`, `status`). Resolves `repo` (`.`, `~/x`, `/abs`, `rel`) to an absolute path. |
| `schema.mjs` | Hand-rolled `validateRegistry` / `validateOwnership`. The `*.schema.json` files are the reference contract; these are the runtime check. |
| `assemble.mjs` | Turn a project's context files into a budgeted, secret-scrubbed **prose Context Pack** for stage handoffs (`factory context + project context`). |
| `project-brief.mjs` | Turn the **same** context files into a structured JSON brief (mission, vision, roadmap, decisions, memory, risks, ownership, `contextFindings`). |
| `founder-briefing.mjs` | Pure company roll-up: per-project health score, open decisions, risks, opportunities, ranked recommended actions. |
| `classify.mjs` | Classify a judgement call against the decision protocol (`continue` / `decision-request` / `ask`). |
| `redact.mjs`, `common/redact.mjs` | Secret-filename refusal, value scrubbing, `assertInsideDir` path-traversal guard. |

### Factory workflow engine (`factory/lib/`) — untouched

`task-workflow.mjs`, `task-initializer.mjs`, `openclaw-protocol.mjs`,
`openclaw-runner.mjs`, `handoff.mjs`, `natural-language-intake.mjs`. The
deterministic 7-stage state machine. **The Integration Layer only reads its
state; it never writes it.**

### Learning agent (`factory/lib/learning/`) — untouched

Findings, evidence, knowledge files, publish flow. The Integration Layer reads
the digest + findings for the Chief of Staff interface.

### Founder Control Plane (`dashboard/backend/lib/founderControlPlane.mjs`)

`discoverFactoryTasks(root)` walks `dashboard/backend/data/factory/**/state.json`
into task views. `buildFounderOverview` folds HQ projects + project intelligence
+ company briefing together and the server exposes it at
`GET /api/founder/overview`.

### Dashboard HQ store (`dashboard/backend/lib/hqStore.mjs`)

Reads the **runtime** HQ data (`dashboard/backend/data/hq/`, git-ignored): rich
per-project JSON, agent personas, tasks, reports, logs. `hqSchemas.mjs` has the
zod schemas.

### The gap

- Two project models that did not know about each other: the committed
  `factory/projects.json` (minimal, intelligence layer) and the runtime
  `dashboard/backend/data/hq/projects/*.json` (rich, dashboard).
- `factory/projects.json` knew only `openclaw-factory`, even though a real
  LifeMaxing factory task was already running from `~/projects/lifemaxing`.
- No committed registry of **agents** (Claude, Codex, OpenClaw, Learning Agent).
- No notion of **agent activity** ("what are my workers doing?").
- No **GitHub** awareness.
- No single "company state" object a founder view or a future Chief of Staff
  could consume.

---

## 2. What the Integration Layer adds (`factory/lib/hq/`)

Dependency-free (Node builtins only). Every function degrades — a missing file,
an unregistered project, an offline `gh` becomes a warning, never a throw.

| Module | Responsibility |
| --- | --- |
| `config.mjs` | Read `factory/hq.config.json` (workspace roots for discovery, GitHub defaults). Sane defaults if absent. |
| `registry.mjs` | The **unified project registry** on top of `intel/registry.mjs`: merges each `factory/projects.json` entry with its structured brief and (when present) the runtime dashboard project row, keyed by project `key`. |
| `agents.mjs` | Read/validate `factory/agents.json` — the committed **agent registry** (`id`, `name`, `kind`, `role`, `capabilities`, `currentProject`, `status`). |
| `discovery.mjs` | Scan configured workspace roots for Git repositories, diff against the registry, and **propose** new projects. Never writes. |
| `github.mjs` | Read-only GitHub adapter over the `gh` CLI (injectable `exec` for tests). Repo info, latest commits, branches, open PRs, open issues. Offline → `{ available: false }`. |
| `activity.mjs` | Derive **agent activity** from structured sources (agent registry + factory task state events): current project, current task, last activity, blockers, waiting state. |
| `company-state.mjs` | The top aggregator — `buildCompanyState()` → `{ founder, projects, agents, external, decisions, risks, summary }`. |
| `company-context.mjs` | Extend the intelligence layer: prepend a **Company context** section (company mission + current company state) to the existing Context Pack for an agent working on a project. |
| `chief-of-staff.mjs` | The consumption interface a future Chief of Staff agent reads: company state + project status + agent activity + open decisions + learning findings + GitHub activity. Architecture only — no agent logic. |

### Entry points

- **CLI:** `node scripts/hq.mjs <state|projects|agents|discover|github|chief-of-staff>`
  (JSON in/out, same envelope style as `scripts/project-intel.mjs`), also
  `npm run factory:hq -- <action>`.
- **HTTP:** `GET /api/hq/company` — read-only, additive. `buildCompanyState`
  over the live factory task states + dashboard projects.

### Data files (committed)

- `factory/projects.json` — evolved: optional `name`, `mission`, `owner`,
  `github {owner, repo}`, `responsibleAgents[]`. Now registers `lifemaxing`.
- `factory/agents.json` — new agent registry.
- `factory/hq.config.json` — new discovery / GitHub config.
- `factory/schemas/agents.schema.json`, `factory/schemas/hq-config.schema.json`
  — new reference contracts; `projects.schema.json` updated.

---

## 3. How the pieces connect

```
Founder
  │
  ▼
Headquarters Operating System
  │  scripts/hq.mjs  ·  GET /api/hq/company
  ▼
factory/lib/hq/company-state.mjs   ── buildCompanyState()
  ├── projects  ← hq/registry.mjs ← intel/registry.mjs (factory/projects.json)
  │                              ← intel/project-brief.mjs (context/ files)
  │                              ← dashboard/data/hq/projects/*.json (when present)
  ├── agents    ← hq/agents.mjs (factory/agents.json)
  │             + hq/activity.mjs ← factory task state events (read-only)
  ├── external  ← hq/github.mjs (gh CLI, read-only)
  ├── decisions ← intel/founder-briefing.mjs + factory task blockers
  └── risks     ← intel/project-brief.mjs (ownership.json)

hq/discovery.mjs  → proposes unregistered Git repos (founder approves)
hq/chief-of-staff.mjs → same inputs, shaped for a future Chief of Staff agent
hq/company-context.mjs → adds a "Company context" block to intel/assemble.mjs output
```

Nothing above writes factory state, project code, or the workflow engine.

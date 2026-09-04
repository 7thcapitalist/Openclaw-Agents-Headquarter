# Proposal: Intelligence Layer for the OpenClaw Agents Headquarter

Status: Draft for founder review
Date: 2026-09-03
Scope: intelligence layer only. No UI. No new workflow engine.

## 1. Goal

Today the factory *executes* tasks. It does not *understand* the companies it
works for. An agent picking up a `builder` handoff knows the task outcome, the
acceptance criteria, and its role prompt — nothing about the product vision, the
users, the architecture it must respect, past decisions, or what the founder
cares about this quarter. It also cannot notice that something is wrong,
missing, or worth the founder's attention unless a task explicitly hits a
`decision-required` wall.

This proposal adds the layer that makes agents behave like employees who know
their company:

1. **Persistent project context** — canonical files every project carries.
2. **Project ownership** — structured mission, metrics, priorities, risks,
   open decisions, responsible agents.
3. **Context assembly** — every agent invocation receives
   `factory context + project context + task context`, deterministically.
4. **Proactive sensing** — agents detect missing info, blocked decisions,
   risks, opportunities, and technical debt, and raise questions without being
   asked.
5. **Founder interaction model** — a machine-readable decision protocol that
   answers *ask now / continue / create a decision request* for any judgement
   call.
6. **Memory architecture** — an explicit contract for what is global, what is
   per-project, what is per-agent, and what must never persist.

## 2. What already exists (do not rebuild)

| Capability | Where | Keep as-is |
| --- | --- | --- |
| Deterministic 7-stage task lifecycle (product → architect → builder → reviewer → qa → security → release), isolated git worktree per task, evidence + independence enforcement | `factory/lib/task-workflow.mjs`, `factory/lib/task-initializer.mjs` | Yes |
| Stage handoff generation (task outcome, acceptance criteria, constraints, completed/returned handoffs, role prompt) | `factory/lib/handoff.mjs` | Extend, do not replace |
| OpenClaw dispatch protocol + JSON adapter (`start`/`init`/`next`/`run`/`ingest`/`resume`/`approve`) | `factory/lib/openclaw-protocol.mjs`, `factory/lib/openclaw-runner.mjs`, `scripts/openclaw-factory.mjs` | Yes |
| Natural-language intake → task contract (Chief of Staff) | `factory/lib/natural-language-intake.mjs` | Extend |
| Risk gate + Ed25519 signed founder approval for high-risk builds | `factory/lib/task-workflow.mjs` | Yes |
| Decision Card template | `factory/templates/decision-card.md` | Reuse verbatim |
| Accepted-decision log (factory project) | `docs/software-factory/DECISIONS.md` | Adopt pattern per project |
| Escalate / do-not-escalate lists, risk-level definitions | `docs/software-factory/OPERATING_RULES.md` | Promote to machine form |
| Founder control plane (reactive): discovers all task `state.json` files, surfaces `decision-required` blockers as decisions, project pause/resume, ask-a-question passthrough, questions log | `dashboard/backend/lib/founderControlPlane.mjs`, `control-plane.json` | Keep; this proposal feeds it |
| HQ project schema with rich fields (mission, keyMetrics, currentBlockers, approvalRules, …) | `dashboard/backend/lib/hqSchemas.mjs` | Align with `ownership.json` |

The existing founder control plane is **reactive** — it can only show a decision
once a running task has already blocked on it. The gap this proposal closes is
**proactive** understanding and escalation, plus the durable context that makes
every stage smarter.

## 3. Design principles

- **The workflow engine is untouched.** The intelligence layer produces inputs
  (context packs, classifications) and consumes outputs (task state, events).
  It never adds a pipeline stage or a second state machine.
- **One integration seam.** All context enrichment enters through
  `writeHandoff()` in `factory/lib/handoff.mjs`. If an agent is dispatched, it
  gets the pack.
- **Deterministic first.** Context assembly, decision classification, and the
  first wave of sensors are pure functions over files and task state — no model
  call, fully unit-testable. Model-backed sensing is an optional later layer and
  is confined to *raising questions*, never acting.
- **Repo is the source of truth for durable context** (extends SFD-2026-001 and
  SFD-2026-004). Per-project context files live in **that project's own repo**.
  HQ holds only a registry, runtime queues, and distilled digests.
- **No secrets, ever, in a context pack.** The assembler has a redaction guard
  (§8) that refuses to inline `.env`, key material, or files outside the
  declared context directory.
- **Adapters, not daemons.** New capabilities ship as JSON-in/JSON-out scripts
  in `scripts/` matching `openclaw-factory.mjs` style, invoked by OpenClaw cron
  or the founder. No always-on process is added.

## 4. Multi-project architecture

### 4.1 Project registry

New file `factory/projects.json` (committed; schema in
`factory/schemas/projects.schema.json`):

```json
{
  "version": 1,
  "projects": [
    { "key": "openclaw-factory", "name": "OpenClaw Factory",
      "repo": ".", "contextDir": "docs/software-factory", "status": "active" },
    { "key": "lifemaxing", "name": "LifeMaxing",
      "repo": "/home/joao-vitor/projects/lifemaxing", "contextDir": "context", "status": "active" },
    { "key": "campuscart", "name": "CampusCart",
      "repo": "/home/joao-vitor/projects/campuscart", "contextDir": "context", "status": "active" }
  ]
}
```

- A task contract's existing `project` field is the key into this registry.
- `repo` + `contextDir` resolve to where the seven context files live.
- The factory itself is a project; its `contextDir` is the existing
  `docs/software-factory/`, so it gets the same treatment without a migration.
- **Isolation**: context is resolved strictly from the task's own project entry.
  A LifeMaxing task can never receive CampusCart context.
- **Shared capabilities**: every project reuses the same `factory/lib` engine,
  the same role prompts, the same sensors, the same decision protocol. Only
  *context* is partitioned; *capability code* is global.

### 4.2 Runtime state per project (HQ, gitignored)

Under the existing `dashboard/backend/data/factory/<project-key>/`:

```
decisions/        open decision requests (Decision Card JSON + rendered .md)
questions/        proactive questions raised by sensors
memory/           project working memory not yet promoted to the repo
sensor-runs/      timestamped sensor output for audit
tasks/            (existing) per-task workflow state.json
```

The existing single `control-plane.json` (`{projects, questions}`) is kept for
pause/resume and the ask-a-question log; the `questions/` directory is the
structured, deduplicated sensor queue that the control plane reads from.

## 5. Project context system

### 5.1 Canonical files

Scaffolded into each project's `contextDir` from
`factory/templates/project-context/`:

| File | Owns | Written by | Read by |
| --- | --- | --- | --- |
| `PROJECT.md` | One-screen orientation: what this is, current status, current phase, how work flows | founder + agents via PR | every stage |
| `VISION.md` | Why the product exists, the target user, the 1–2 year bet, non-goals | founder | architect, product, reviewer |
| `ROADMAP.md` | Ordered milestones, the current milestone, what is explicitly deferred | founder + Chief of Staff | product, architect, Chief of Staff |
| `DECISIONS.md` | Accepted, durable decisions (SFD-style stable IDs, rationale, consequences, supersession) | Chief of Staff on founder acceptance | architect, builder, reviewer, security |
| `MEMORY.md` | Durable non-obvious facts learned while building (gotchas, external constraints, "we tried X, it failed because Y") | any agent via PR | every stage |
| `TECH_CONTEXT.md` | Stack, services, environments, architectural constraints, "do not do" list, observability | architect + builder via PR | architect, builder, qa, security |
| `USERS.md` | Who the users are, their primary jobs-to-be-done, sensitivities (e.g. health data), support/consent constraints | founder + product | product, architect, security, qa |

Rules (mirrors the `factory.config.json` ↔ `PROJECT_CONTEXT.md` sync rule):

- These are prose. The machine-authoritative mirror is `ownership.json` (§6).
  If the two disagree, agents stop and surface it rather than guessing.
- Agents may **propose** edits only through the task's PR. They never edit
  another project's context, and never edit context outside their worktree.
- A file that is missing, older than a staleness threshold, or below a minimum
  substance bar is a finding for the `missing-context` sensor (§7).

### 5.2 Context assembly (the one seam)

New module `factory/lib/context/assemble.mjs`, called by `writeHandoff()`. It
prepends a **Context Pack** to every stage handoff:

```
## Factory context (global)
- Operating mode: human-merge. Prohibited autonomous actions: <from factory.config.json>
- Decision protocol summary: continue reversible work; strategic/irreversible/
  privacy/spend/public/scope → Decision Request; blocking clarification only as
  last resort. Full protocol: factory/context/DECISION_PROTOCOL.md
- Independence + evidence gates: <one line each>

## Project context: LifeMaxing  (key: lifemaxing)
- Mission: <ownership.json.mission>
- Success metrics: <name: current → target (asOf)> ...
- Current priorities: <p1 title>, <p2 title> ...
- Active risks: <r1 title [high]>, ...
- Open decisions blocking work: DEC-2026-014 "Health data storage location"
- Responsible agents: architect=claude, builder=codex, product owner=founder
- Vision (digest): <first paragraph of VISION.md>
- Current milestone: <ROADMAP.md current milestone heading + 1 line>
- Tech constraints: <TECH_CONTEXT.md "constraints" section, trimmed>
- Users: <USERS.md primary user + primary sensitivity>
- Recent durable facts: <last N bullets of MEMORY.md>
- Last accepted decisions: <last N headings of DECISIONS.md>
- Full context files are in your worktree at: <contextDir>/

## Task context
<existing handoff body: outcome, acceptance criteria, constraints,
 completed handoffs, returned findings, role instructions>
```

Properties:

- **Deterministic and pure.** Input: registry entry + resolved file contents +
  task state. Output: a string. No network, no model.
- **Budgeted.** Each section has a character cap; long files contribute a
  digest (heading + first paragraph / named section), never their full body.
  The full files are in the worktree checkout for the agent to open on demand.
- **Degrades gracefully.** Missing file → a single line
  `- VISION.md: not present (raise with founder)` and a finding, not an error.
- **Redaction-guarded** (§8).

Because the target project's repo *is* the worktree, agents can `Read
context/TECH_CONTEXT.md` directly for depth; the pack is the always-present
summary + pointer.

### 5.3 Context tooling

New adapter `scripts/factory-context.mjs` (JSON in/out):

- `scaffold --project <key>` — write the seven templates + `ownership.json`
  into the project's `contextDir` (no overwrite).
- `show --project <key> [--task <id>]` — print the assembled Context Pack
  (what an agent would actually see).
- `lint --project <key>` — report missing / stale / thin files and
  `ownership.json` ↔ `PROJECT.md` drift. Emits `missing-context` findings.

## 6. Project ownership

New file `<contextDir>/ownership.json` per project (schema in
`factory/schemas/ownership.schema.json`). This is the structured, enforceable
mirror of `PROJECT.md`, and the single source for the "ownership" concept the
brief asks for:

```json
{
  "version": 1,
  "mission": "Help users measurably improve health habits with minimal friction.",
  "successMetrics": [
    { "id": "m1", "name": "D30 retention", "target": "35%", "current": "22%", "asOf": "2026-08-20" },
    { "id": "m2", "name": "Weekly active habit logs / user", "target": "5", "current": "3.1", "asOf": "2026-08-20" }
  ],
  "currentPriorities": [
    { "id": "p1", "title": "Wearable integrations", "rationale": "Top churn reason is manual logging." },
    { "id": "p2", "title": "Onboarding consent redesign", "rationale": "Legal review pending for health data." }
  ],
  "risks": [
    { "id": "r1", "title": "Health data privacy posture undecided", "severity": "high",
      "likelihood": "high", "mitigation": "Pending DEC-2026-014", "owner": "founder" },
    { "id": "r2", "title": "No load testing on sync service", "severity": "medium",
      "likelihood": "medium", "mitigation": "Add k6 suite in milestone 4", "owner": "architect" }
  ],
  "openDecisions": ["DEC-2026-014"],
  "responsibleAgents": {
    "productOwner": "founder",
    "architect": "claude",
    "builder": "codex",
    "reviewer": "claude",
    "security": "claude"
  }
}
```

- `openDecisions` holds IDs into the project's decision queue (§8). The
  assembler expands them to `id + title` in the pack.
- `successMetrics.current` / `asOf` are updated by agents via PR when a task
  produces a measurement, or by the founder. Stale metrics (`asOf` older than a
  threshold) are an `opportunity`/`missing-context` finding.
- `risks` with no `mitigation` or no `owner` are a `risk` sensor finding.
- The HQ `projectSchema` fields (`keyMetrics`, `currentBlockers`,
  `approvalRules`, `relatedAgents`) are populated from `ownership.json` so the
  existing dashboard reads one consistent model.

## 7. Proactive agents (sensing)

### 7.1 Concept

A **Sensor** is a read-only analysis pass. It is **not** a workflow stage — it
runs outside the engine, cannot write to a repo, and cannot start a task. It
emits **Findings**. A Finding that needs the founder becomes a **Question**;
a Question that is a strategic/irreversible choice is promoted to a **Decision
Request** (§8).

```
sensor run ──► Finding[] ──► dedupe (stable fingerprint) ──► Question queue
                                                   │
                          founder-decision-required ──► Decision Request
```

### 7.2 Sensor set (deterministic first)

| Sensor | Detects | Deterministic signals (v1) | Model-assisted (later) |
| --- | --- | --- | --- |
| `missing-context` | Missing information | absent/stale/thin context files; `ownership.json` missing metrics or targets; acceptance criteria on recent tasks flagged ambiguous by product stage | reads context, names the specific gap |
| `blocked-decision` | Blocked decisions | task `state.json` with `decision-required` blocker; `openDecisions` entries with no founder response past SLA; roadmap item marked `blocked:` | drafts the Decision Card options |
| `risk` | Risks | `ownership.json` risks with no mitigation/owner; ≥N stage failures on one task; repeated `security` FAIL of same class; dependency with known advisory | narrates emerging risk from event history |
| `tech-debt` | Technical debt | TODO/FIXME density delta; test files absent for changed modules; reviewer findings of the same category recurring across PRs; architecture drift vs `TECH_CONTEXT.md` "do not do" list | proposes a debt-paydown task contract |
| `opportunity` | Opportunities | roadmap item whose named blocker just cleared; same manual step run ≥N times; metric within X% of target and stalling | suggests the next highest-leverage task |

Each is `factory/lib/sensors/<name>.mjs` exporting
`run({ project, registry, factoryStateRoot, now }) → Finding[]`.

### 7.3 Finding / Question shape

```json
{
  "id": "Q-lifemaxing-0007",
  "project": "lifemaxing",
  "sensor": "blocked-decision",
  "kind": "founder-decision-required",
  "fingerprint": "blocked-decision:lifemaxing:fitbit:storage-location",
  "title": "Fitbit integration blocked: health-data storage location undecided",
  "body": "The LifeMaxing Fitbit integration cannot proceed until we decide whether health data is stored locally on-device or synced to our backend. This changes the privacy posture, the sync architecture, and onboarding consent copy.",
  "blocks": ["issue-lifemaxing-42"],
  "evidence": ["tasks/issue-lifemaxing-42/state.json", "context/ROADMAP.md#wearables"],
  "raisedAt": "2026-09-03T20:15:00Z",
  "status": "open",
  "decisionRequest": "DEC-2026-014",
  "recommendation": "Local-only for v1: smallest privacy surface, no new data processor, defer backend sync to milestone 5."
}
```

- `fingerprint` makes re-runs idempotent: a finding already open is not
  re-raised; if the underlying signal clears, the sensor closes it with
  `status: "resolved"`.
- This is exactly the brief's example: the system now *knows*
  `kind: "founder-decision-required"` and which task it `blocks`.

### 7.4 Runner + scheduling

New adapter `scripts/factory-sense.mjs`:

- `run --project <key>` or `run --all` — execute sensors, reconcile the
  question queue, write `sensor-runs/<timestamp>.json`.
- `list --project <key> [--kind ...]` — current open questions.
- `dismiss --id <Q-id> --reason <text>` — founder/Chief of Staff closes a
  question without action (recorded).

Scheduling: the founder wires `run --all` into OpenClaw cron (e.g. daily) or a
system timer. No new daemon. The Chief of Staff may also call `run --project`
opportunistically at task intake and completion.

### 7.5 Model-assisted sensing (optional, later)

`factory/prompts/sensor.md` defines a read-only analyst persona invoked through
the same OpenClaw agent path as the Chief of Staff intake. Hard constraints:
it may only return Findings JSON; it has no write access, no worktree, and
cannot initialise or resume a task. Its output is merged into the same queue
and is subject to the same dedupe and founder review.

## 8. Founder interaction model — decision protocol

### 8.1 Three outcomes

Every judgement call an agent or sensor faces resolves to exactly one:

| Outcome | When | Action |
| --- | --- | --- |
| **Continue autonomously** | Reversible, in declared scope, no policy trigger hit (variable names, refactors, test structure, small dependencies, minor UX already implied by the task) | Decide, record the choice in the handoff / `MEMORY.md`, keep working. |
| **Create a Decision Request** | A trigger is hit: product direction, target user, scope/milestone priority, privacy / data retention / security posture, meaningful or recurring spend, public/external communication, destructive production op, hard-to-reverse migration, legal/compliance, a UX tradeoff that changes the product promise | Emit a Decision Card (existing template), add to the project decision queue, **block only the affected sub-task**, continue everything else. Founder answers asynchronously. |
| **Ask now (blocking question)** | Rare. The task cannot make *any* safe progress and one short factual clarification unblocks it | Post a blocking question, time-boxed. If unanswered within the box, fall back to the documented default and downgrade to a Decision Request. |

Default bias: **continue**. "Ask now" is the exception, not the reflex — the
product is attention compression.

### 8.2 Machine form

`factory/context/DECISION_PROTOCOL.md` (prose, canonical) + `factory/decision-protocol.json` (machine):

```json
{
  "version": 1,
  "defaultOutcome": "continue",
  "triggers": [
    { "id": "privacy", "match": { "anyKeyword": ["personal data", "health data", "PII", "retention", "consent", "encryption at rest"] },
      "outcome": "decision-request", "reason": "Privacy / data-retention posture is a founder call." },
    { "id": "spend", "match": { "anyKeyword": ["paid plan", "subscription", "per-seat", "add a vendor", "usage billing"] },
      "outcome": "decision-request", "reason": "Recurring spend requires founder approval." },
    { "id": "public", "match": { "anyKeyword": ["publish", "press", "public announcement", "changelog to users", "app store"] },
      "outcome": "decision-request", "reason": "External communication is founder-owned." },
    { "id": "scope", "match": { "field": "changesMilestonePriority", "equals": true },
      "outcome": "decision-request", "reason": "Re-prioritising the roadmap is a founder call." },
    { "id": "irreversible", "match": { "anyKeyword": ["drop table", "delete production", "data migration", "rename public API"] },
      "outcome": "decision-request", "reason": "Hard-to-reverse change." }
  ],
  "riskBinding": { "high": "decision-request-before-build" },
  "sla": { "decisionRequestReminderHours": 24, "blockingQuestionTimeoutHours": 4 }
}
```

`factory/lib/decisions/classify.mjs` evaluates a task contract or a proposed
change description against this table → `continue | decision-request | ask`.
The Chief of Staff calls it at intake; stages call it before acting on a
strategic ambiguity; sensors call it to decide whether a finding is a plain
question or a Decision Request. The existing `risk: "high"` →
signed-approval-before-build gate is unchanged and referenced by
`riskBinding`.

### 8.3 Decision lifecycle

```
open ──► answered (A | B | discuss) ──► accepted ──► recorded in <project>/DECISIONS.md
  │                                          │
  └──► expired (SLA, fell back to default)   └──► rejected
```

- `factory/lib/decisions/queue.mjs`: `open`, `answer`, `accept`, `reject`,
  `expire`; JSON store under `data/factory/<project>/decisions/`.
- On **accept**, the Chief of Staff appends an SFD-style entry to that
  project's `DECISIONS.md` (via the task PR) and removes the ID from
  `ownership.json.openDecisions`. History is never rewritten; a superseding
  decision links back.
- **High-risk** decisions still require the Ed25519 signed approval assertion.
  The queue *references* that flow; it does not replace or weaken it.
- `scripts/factory-decisions.mjs`: `list`, `open`, `answer`, `accept`,
  `sync-ownership`. The existing `/api/founder/decisions/resolve` endpoint and
  `founderControlPlane.resolveFounderDecision` are kept and become one writer
  into this queue.

## 9. Memory architecture

| Tier | Lives in | Contents | Persists? | Writer |
| --- | --- | --- | --- | --- |
| **Global / factory memory** | HQ repo: `factory/context/`, `factory/factory.config.json`, `factory/decision-protocol.json`, `docs/software-factory/DECISIONS.md` | How the factory operates, cross-project accepted decisions, role definitions, decision protocol, prohibited actions | Yes — versioned, reviewed, sanitised | Founder + PR |
| **Project memory** | The project's **own repo**: `<contextDir>/` seven files + `ownership.json` | Vision, roadmap, accepted decisions, durable facts, tech context, users, mission / metrics / risks | Yes — versioned in that project's repo | Agents propose via task PR; founder accepts |
| **Project runtime state** | HQ, gitignored: `dashboard/backend/data/factory/<key>/` | Open decision requests, proactive questions, sensor runs, per-task workflow `state.json`, pause flags | Semi — lives until resolved, then the durable conclusion is promoted up into the repo; not itself a source of truth | Sensors, workflow engine, control plane |
| **Agent memory** | Private OpenClaw workspace (`~/.openclaw`), per agent / per session | Persona, tone, session continuity, scratch reasoning, per-agent working notes | Local only — never in any repo or HQ state (SFD-2026-004) | The agent runtime |
| **Never persists** | nowhere | Secrets, tokens, OAuth material, credentials; raw personal / health data or PII pulled for a task; full user PII tables; un-sanitised customer data; model chain-of-thought / raw transcripts | Never — must not enter a repo, HQ runtime state, or a context pack | — |

### 9.1 Promotion path

Runtime question or decision → founder accepts → Chief of Staff distils the
**non-sensitive conclusion** into `<project>/DECISIONS.md` or `MEMORY.md`
through the task PR. Nothing sensitive is promoted. Raw material stays in
runtime state and ages out.

### 9.2 Redaction guard (enforced by the assembler and every adapter)

`factory/lib/context/redact.mjs`, applied to anything about to enter a context
pack, a question body, or a digest:

- **Refuse** to read a file whose resolved path is outside the project's
  declared `contextDir` (blocks `../../.env` and sibling-repo traversal).
- **Refuse** filenames matching `.env*`, `*.pem`, `*.key`, `id_rsa*`,
  `credentials*`, `secrets*`.
- **Scrub** value patterns: high-entropy tokens, `AKIA…`, `sk-…`, `Bearer …`,
  `-----BEGIN … PRIVATE KEY-----`, `postgres://user:pass@…`.
- On any hit: drop the fragment, insert `[redacted: <reason>]`, and emit a
  `risk` finding so the founder learns a secret was where it should not be.

## 10. Integration map

```
                 factory/projects.json ──┐
                                         ▼
Chief of Staff intake ──► classify.mjs ──► (continue | decision-request | ask)
        │                                         │
        ▼                                         ▼
openclaw-factory.mjs  start/init/run     decisions/queue.mjs ──► <project>/DECISIONS.md
        │                                         ▲
        ▼                                         │
task-workflow.mjs (UNCHANGED state machine)       │
        │                                         │
        ▼                                         │
handoff.mjs ──calls──► context/assemble.mjs ──► reads <contextDir>/* + ownership.json + factory/context/*
        │                        │
        ▼                        └──► redact.mjs
agent runs in worktree (has full context files on disk)
        │
        ▼
events + state.json  ◄──reads──  sensors/*.mjs ──► questions/queue.mjs ──► founderControlPlane overview
                                     ▲                                             │
                     scripts/factory-sense.mjs (cron)                   existing /api/founder/*
```

Every arrow into the engine is an **input**; every arrow out is a **read**. The
engine gains no new state and no new stage.

## 11. New / changed files

**New (committed):**

```
factory/projects.json
factory/decision-protocol.json
factory/context/FACTORY.md
factory/context/DECISION_PROTOCOL.md
factory/schemas/projects.schema.json
factory/schemas/ownership.schema.json
factory/schemas/finding.schema.json
factory/templates/project-context/{PROJECT,VISION,ROADMAP,DECISIONS,MEMORY,TECH_CONTEXT,USERS}.md
factory/templates/project-context/ownership.json
factory/lib/context/{registry,assemble,redact}.mjs
factory/lib/decisions/{queue,classify}.mjs
factory/lib/questions/queue.mjs
factory/lib/sensors/{missing-context,blocked-decision,risk,tech-debt,opportunity}.mjs
factory/prompts/sensor.md
scripts/factory-context.mjs
scripts/factory-sense.mjs
scripts/factory-decisions.mjs
factory/test/context-assemble.test.mjs
factory/test/decision-classify.test.mjs
factory/test/sensors.test.mjs
```

**Changed (small, additive):**

```
factory/lib/handoff.mjs         call assemble.mjs, prepend the Context Pack
factory/lib/natural-language-intake.mjs   run classify.mjs at intake
scripts/openclaw-factory.mjs    on decision-request: register card, continue unaffected stages
dashboard/backend/lib/founderControlPlane.mjs   read questions/ and decisions/ queues alongside control-plane.json
dashboard/backend/lib/hqSchemas.mjs   populate project fields from ownership.json
docs/software-factory/{README,PROJECT_CONTEXT,OPERATING_RULES}.md   link the protocol + context system
AGENTS.md                        add "read your project context" to the reading order
```

## 12. Phased delivery

Each phase is independently shippable and testable.

- **Phase 1 — Context system.** Registry + schemas, seven templates +
  `ownership.json`, `registry.mjs` / `assemble.mjs` / `redact.mjs`, wire into
  `handoff.mjs`, `scripts/factory-context.mjs`, unit tests. Scaffold the
  factory's own project from existing `docs/software-factory/`. *Outcome: every
  stage handoff now carries factory + project context.*
- **Phase 2 — Decision protocol + queue.** `DECISION_PROTOCOL.md` +
  `decision-protocol.json`, `classify.mjs`, `decisions/queue.mjs`,
  `DECISIONS.md` appender, `scripts/factory-decisions.mjs`, Chief of Staff +
  `openclaw-factory.mjs` wiring, fold in the existing
  `resolveFounderDecision`. *Outcome: strategic ambiguity produces a Decision
  Card and blocks only the affected sub-task.*
- **Phase 3 — Sensors.** `questions/queue.mjs` with fingerprint dedupe, the
  five deterministic sensors, `scripts/factory-sense.mjs`, founder-overview
  read path. Founder adds the cron entry. *Outcome: the Fitbit-style example
  is raised before a task even starts.*
- **Phase 4 — Digest + model-assisted sensing.** `scripts/factory-digest.mjs`
  (one JSON/markdown per project: building / in review / blocked / shipped /
  decisions needing founder / new questions / stale context) and the optional
  `sensor.md` analyst pass. *Outcome: one artefact answers "what needs me?" —
  still no UI; the existing dashboard can consume the same JSON later.*

## 13. Open decisions for the founder

These are genuine strategic choices this proposal cannot make alone.

1. **Where do per-project context files live?**
   Recommendation: in each project's **own repo** under `context/` (travels
   with the code, matches SFD-2026-001/004, GitHub stays source of truth).
   Alternative: centralised under HQ `data/factory/<key>/context/` (easier to
   edit in one place, but decouples context from the code it describes and
   risks it going stale or leaking between environments).

2. **Do the LifeMaxing and CampusCart repos exist locally yet, and at what
   paths?** The registry needs real `repo` paths. Only doc references to
   "LifeMax" exist in this repo today; no project repo is checked out.

3. **Sensor autonomy ceiling.** Recommendation: sensors are read-only and may
   only raise questions. Alternative: allow a sensor to also open a *draft*
   GitHub issue (labelled `needs-founder`, never `status:ready`) so a finding
   lands where tasks are triaged.

4. **Blocking-question timeout fallback.** When a rare "ask now" question times
   out (default 4h), should the agent (a) fall back to the documented default
   and continue, downgrading to a Decision Request — *recommended* — or (b)
   hard-stop the whole task until the founder replies?

5. **Decision-request SLA behaviour.** After the 24h reminder with no founder
   answer, does the affected sub-task stay parked indefinitely, or auto-expire
   to the recommended option after a second threshold (e.g. 72h) with a loud
   entry in the digest?

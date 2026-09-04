# Company Operating System (COS)

Status: Architecture — for founder review
Date: 2026-09-03
Builds on:
- `docs/software-factory/INTELLIGENCE_LAYER_PROPOSAL.md`
- `docs/software-factory/INTELLIGENCE_LAYER_IMPLEMENTATION_PLAN.md` (Phase 1 — Project Context Layer)
- `dashboard/backend/lib/founderControlPlane.mjs` (Founder Control Plane, already partially built)
- `factory/lib/*` (workflow engine — unchanged)

Constraints honoured throughout: **no UI**, **no second workflow engine**, no new
npm dependency in `factory/lib`, `./run.sh` boundary intact, human-merge intact,
repo-vs-private-state split intact (SFD-2026-004).

---

## 0. What the Company OS is

Three layers already exist or are planned:

| Layer | Owns | State |
| --- | --- | --- |
| **Workflow Engine** (`factory/lib/task-workflow.mjs`, `openclaw-protocol.mjs`, …) | executing one bounded task: 7 stages, isolated worktree, evidence + independence gates | built |
| **Intelligence Layer** (`factory/lib/context/*`, `factory/projects.json`, `context/`) | giving each task the right context; sensing gaps/risks | Phase 1 planned |
| **Founder Control Plane** (`founderControlPlane.mjs`, `/api/founder/*`, `control-plane.json`) | surfacing tasks, blockers, decisions to the founder; pause/resume; ask-a-question | partially built |

The **Company OS** is the connective layer between them. It is not a runtime. It
is a set of **conventions, schemas, JSON adapters, and one permanent agent role**
that make the three layers behave like one company:

```
                       ┌─────────────────────────── FOUNDER ───────────────────────────┐
                       │  writes: VISION · ROADMAP · USERS · strategic DECISIONS        │
                       │  answers: Decision Cards ("ball in your court")                │
                       └───────────────┬───────────────────────────▲──────────────────┘
                                       │ strategy                   │ decisions
                                       ▼                            │
   company/ (shared) ──┐      context/ (per project) ──┐            │
   COMPANY.md          │      PROJECT.md VISION.md …    │   ┌────────┴─────────┐
   ENGINEERING_STDS.md │      ownership.json            │   │ Unified Decision │
   LESSONS.md          │                                │   │ Store (§5)       │
   BEHAVIOR_PROTOCOL   │                                │   └────────▲─────────┘
   DECISION_PROTOCOL   │                                │            │ cards / questions
        │              │            │                   │            │
        └──────┬───────┴────────────┴───────────────────┘            │
               ▼ Context Injection (§2)                              │
     ┌───────────────────────────┐                                   │
     │  Workflow Engine (tasks)  │ ── events / evidence / failures ──►│
     └───────────────────────────┘                                   │
               │ terminal state (merge-ready | blocked)              │
               ▼                                                     │
     ┌───────────────────────────┐   observations / proposals        │
     │  Company Learning Agent   │ ──────────────────────────────────►┘
     │  (§3) — makes agents better│   lessons → LESSONS.md / MEMORY.md (via PR)
     └───────────────────────────┘   prompt & standard edits (draft branches)
```

The spine is a **closed loop**: founder strategy → context files → context
injection → execution → outcomes/events → Learning Agent + sensors → proposals &
Decision Cards → founder decides → context files updated → repeat.

The founder never touches a task. The founder touches: **vision, priorities,
decisions, strategy** — all of which live in files and in the Decision Store.

---

## 1. Project Registry & the `context/` files

### 1.1 Registry (extends the Phase 1 `factory/projects.json`)

```json
{
  "version": 2,
  "company": { "configPath": "company/company.json" },
  "projects": [
    {
      "key": "openclaw-factory",
      "name": "OpenClaw Agents Headquarter",
      "repo": ".",
      "contextDir": "context",
      "stateKey": "Openclaw-Agents-Headquarter",
      "decisionLog": "docs/software-factory/DECISIONS.md",
      "isolation": "standard",
      "learningOptIn": true,
      "status": "active"
    },
    {
      "key": "lifemaxing",
      "name": "LifeMaxing",
      "repo": "/home/joao-vitor/projects/lifemaxing",
      "contextDir": "context",
      "stateKey": "lifemaxing",
      "decisionLog": "context/DECISIONS.md",
      "isolation": "confidential",
      "learningOptIn": true,
      "status": "active"
    },
    {
      "key": "campuscart",
      "name": "CampusCart",
      "repo": "/home/joao-vitor/projects/campuscart",
      "contextDir": "context",
      "stateKey": "campuscart",
      "decisionLog": "context/DECISIONS.md",
      "isolation": "standard",
      "learningOptIn": true,
      "status": "active"
    }
  ]
}
```

New fields vs Phase 1:

| Field | Meaning |
| --- | --- |
| `company.configPath` | where the shared company tier config lives |
| `stateKey` | the directory name under `dashboard/backend/data/factory/` that this project's task state uses (today = `basename(repo)`). Explicit here so the Intelligence Layer, Learning Agent, and Decision Store all agree on one key. Resolves the Phase 1 migration concern. |
| `decisionLog` | repo-relative path to this project's accepted-decision log |
| `isolation` | `standard` \| `confidential` — see §6 |
| `learningOptIn` | whether the Learning Agent may read this project's task state and cite (sanitised) lessons company-wide |

### 1.2 The seven files + `ownership.json` — governance

Layout (per project repo):

```
context/
├── PROJECT.md        one-screen orientation: what this is, status, how work flows
├── VISION.md         why it exists, target user, the 1–2 year bet, non-goals
├── ROADMAP.md        ordered milestones, the CURRENT milestone, what is deferred
├── DECISIONS.md      accepted durable decisions (SFD-style stable IDs)
├── MEMORY.md         durable non-obvious facts learned while building
├── TECH_CONTEXT.md   stack, services, environments, hard constraints, "do not" list
├── USERS.md          who the users are, jobs-to-be-done, sensitivities (e.g. health data)
└── ownership.json    structured mirror: mission, metrics, priorities, risks, openDecisions, responsibleAgents
```

| File | Creates it | Updates it | Changes when | Agents consume it via |
| --- | --- | --- | --- | --- |
| `PROJECT.md` | founder (scaffold: `factory-context.mjs scaffold`) | founder for framing; agents propose factual corrections in the task PR | project kickoff; phase change; workflow change | **pinned** digest in every pack (status + current phase) |
| `VISION.md` | **founder only** | **founder only** | rare — a real strategic pivot | **digest** (first paragraph) for `architect`, `product`, `reviewer` |
| `ROADMAP.md` | founder | founder sets milestones; Chief of Staff may append a discovered dependency under review | milestone completed; re-prioritisation (a founder decision) | **pinned** (current milestone) + **digest** (next / deferred) for `product`, `architect`, Chief of Staff |
| `DECISIONS.md` | founder (or Chief of Staff scaffolds structure) | Chief of Staff appends an entry **only after the founder accepts a Decision Card**; never edited by a builder | a Decision Card is accepted; a decision is superseded | **digest** (last 5 headings) for all stages; full file readable in worktree |
| `MEMORY.md` | any agent (first durable fact) | any agent **proposes** a bullet in the task PR; Learning Agent proposes bullets; founder/reviewer merges | a task discovers a gotcha, an external constraint, a "we tried X, it failed because Y" | **digest** (last ~6 bullets) for every stage |
| `TECH_CONTEXT.md` | `architect` on first non-trivial task (proposal) | `architect` + `builder` propose in the task PR; Learning Agent proposes standard alignment | new service/dependency; an architectural constraint is set; environment change | **pinned** (constraints / "do not" section) for `architect`, `builder`, `qa`, `security` |
| `USERS.md` | **founder** (+ `product` may draft) | founder owns; `product` proposes JTBD refinements | new user segment; a sensitivity/consent constraint is identified | **pinned** (primary user + primary sensitivity) for `product`, `architect`, `security`, `qa` |
| `ownership.json` | founder (scaffold) | founder edits mission/priorities/`responsibleAgents`; agents propose `successMetrics.current`/`asOf` when a task measures them; Chief of Staff maintains `openDecisions` | metric measured; priority reordered (founder); risk raised/mitigated; decision opened/closed | **pinned** structured block in every pack (§2) |

**Write protocol — non-negotiable:**

- Agents **never** commit directly to `context/`. They either
  (a) include a `## Context change proposal` block in the task PR body, which the
  founder merges with the PR, or
  (b) route a change through the Learning Agent's proposal queue (§3).
- The **prose file and `ownership.json` must agree.** `ownership.json` is the
  machine-authoritative mirror. On mismatch the assembler emits a
  `context-drift` finding → founder question (outcome B, §4). Neither is silently
  preferred by an agent.
- A `confidential` project's `context/` never leaves its own repo and is never
  cited in another project's pack (§6).

### 1.3 Freshness SLAs (checked by `factory-context.mjs lint`, surfaced in the founder snapshot)

| File | Stale after | On stale |
| --- | --- | --- |
| `ROADMAP.md` current milestone | 30 days without an edit while tasks are running | founder question: "Is milestone X still current?" |
| `ownership.json` `successMetrics[].asOf` | 45 days | `opportunity` finding: re-measure |
| `DECISIONS.md` | n/a (event-driven) | — |
| others | 90 days with active tasks | low-priority note in the weekly digest |

---

## 2. Context Injection System

Extends the Phase 1 `factory/lib/context/assemble.mjs`. The pack is prepended by
`writeHandoff()` (the single seam — unchanged from Phase 1).

### 2.1 Structure & format

Three tiers, fixed order, each delimited and provenance-stamped:

```
==================== GLOBAL COMPANY CONTEXT ====================
source: company/ @ <git-sha>  ·  assembled: <iso>

[PINNED]
- Operating mode: human-merge. Prohibited autonomous actions: <list>
- Engineering standards (always apply): <up to 6 one-line rules from ENGINEERING_STANDARDS.md>
- Decision protocol: continue reversible work; strategic/irreversible/privacy/
  spend/public/scope → Decision Card; blocking only as last resort.
  Behaviour rules: company/BEHAVIOR_PROTOCOL.md

[DIGEST]  (budget-trimmed, lowest priority to keep)
- Cross-project lessons relevant to <workType>: <up to 4 bullets from LESSONS.md>

==================== PROJECT CONTEXT: <name> (<key>) ====================
source: <repo>/<contextDir> @ <git-sha>  ·  isolation: <standard|confidential>

[PINNED]
- Mission: <ownership.mission>
- Current milestone: <ROADMAP current heading + 1 line>
- Active founder decisions affecting this work: <DEC ids + one-line each>
- Hard tech constraints: <TECH_CONTEXT "do not" section, trimmed>
- Active high risks: <ownership.risks where severity=high — title + mitigation>
- Primary user & sensitivity: <USERS primary + primary sensitivity>
- Responsible agents: <role=agent …>
- Open decisions blocking work: <ownership.openDecisions ids + title>

[DIGEST]
- Vision: <VISION.md first paragraph>
- Recent durable facts: <MEMORY.md last ~6 bullets>
- Last accepted decisions: <DECISIONS.md last 5 headings>
- Success metrics: <name: current → target (asOf) …>
- Full context files are in your worktree at: <contextDir>/

==================== TASK CONTEXT ====================
<existing handoff body: outcome, acceptance criteria, constraints,
 human decisions already made, founder decisions, completed handoffs,
 returned findings, role instructions, execution boundary, result contract>
```

- Markdown, deterministic (pass a fixed `now` in tests).
- Every tier carries a `source:` line so an agent can open the real file and so
  a reviewer can audit what the agent saw.
- `[PINNED]` vs `[DIGEST]` is a machine tag the assembler uses for trimming.

### 2.2 Priority (what wins when the budget is tight)

Trim order — **remove from the bottom up**:

1. Global `[DIGEST]` lessons (drop entirely if needed)
2. Project `[DIGEST]` — vision paragraph, then metrics, then memory bullets, then decision headings
3. never trim any `[PINNED]` content
4. never trim `TASK CONTEXT`

If `[PINNED]` content alone exceeds its cap, that is a **configuration error**,
not something the assembler silently truncates: it emits a
`pinned-overflow:<tier>` finding to the founder snapshot and includes the pinned
content in full anyway. Pinned content must be kept short by the people who
write those files.

### 2.3 Token limits

Approximate (chars ≈ tokens × 4). Tune during implementation with a real
tokenizer count logged by `factory-context.mjs show --count`.

| Tier / part | Target | Hard cap |
| --- | --- | --- |
| Global PINNED | 300 tok | 400 |
| Global DIGEST | 200 tok | 250 |
| Project PINNED | 550 tok | 750 |
| Project DIGEST | 500 tok | 700 |
| **COS injected total** | **~1,550 tok** | **2,100 tok** |
| Task context | engine-owned, not capped by COS | — |

Rationale: the pack is *orientation*, not the working set. The full files are in
the worktree; an agent that needs depth reads them.

### 2.4 Conflict resolution

Precedence ladder (1 wins). An agent may **never** satisfy a lower rule by
breaking a higher one.

| # | Source | Example |
| --- | --- | --- |
| 1 | Explicit founder decision — signed high-risk approval, or an accepted Decision Card / `task.humanDecisions` — most recent by `decidedAt` | "Store health data locally only (DEC-2026-014)" |
| 2 | Project accepted decision in `context/DECISIONS.md` (by SFD date) | "This project uses SQLite, not Postgres (SFD-LM-2026-003)" |
| 3 | Company engineering standard / decision protocol (`company/`) | "All new HTTP endpoints require an integration test" |
| 4 | Project `ownership.json` / `PROJECT.md` narrative framing | stated mission, current priority ordering |
| 5 | Task contract `constraints[]` (generic, non-decision) | "preserve existing public interfaces" |
| 6 | Agent's own reasonable default | naming, file layout |

Resolution rules:

- **Detectable contradiction between two levels** → the higher level applies; the
  agent records the resolution in its summary.
- **The task cannot proceed without violating a higher level** → outcome **C**
  (stop and wait, §4): emit a Decision Card citing both sources verbatim.
- **Tie inside a level** (e.g. two founder decisions the same day that conflict,
  or `ownership.json` vs `PROJECT.md`) → outcome **C**, Decision Card
  `kind: "resolve-contradiction"`.
- **Silent drift** (`ownership.json` disagrees with a prose file but the task can
  still proceed) → outcome **B** (founder question), work continues on the
  higher-precedence reading.

`factory/lib/context/precedence.mjs` exposes
`classifyConflict({ statements }) -> { winner, level, action: "apply" | "founder-question" | "stop" }`
so stages and sensors evaluate this the same way.

---

## 3. Company Learning Agent

A **permanent, company-level role** whose only job is to make every other agent
better. It is **not** a founder agent and **not** a pipeline stage — it runs
beside the engine and produces only proposals.

- Prompt: `factory/prompts/company-learning-agent.md`
- OpenClaw agent id: `learning` (add to `factory.config.json`
  `openclawIntegration.agentIds`, one line)
- Driver: `scripts/company-learn.mjs` (JSON adapter), invoked by OpenClaw cron
  and by a post-task hook (adapter call — no engine change)

### 3.1 Inputs

| Input | Source | Used for |
| --- | --- | --- |
| Terminal task state | `dashboard/backend/data/factory/<stateKey>/tasks/*/state.json` — `dispatches` with `outcome:"fail"`, `events` of type `failure-routed`, `blocker` | failed-task analysis, retry patterns, which stage keeps routing back |
| Review / QA / security evidence + summaries | stage `evidence[]` paths + `stages[].summary` in state | recurring finding categories, misleading verification |
| Decision Store history | `_company/decisions/*` | which ambiguities keep recurring; where the protocol is unclear |
| Sensor findings | `<stateKey>/sensor-runs/*` (from the sensors phase) | corroborating signals |
| Cross-project `MEMORY.md` / `DECISIONS.md` | project repos where `learningOptIn` | generalisable lessons |
| External research | web, allowlisted domains, per-run budget | "is there a known better practice for X" |

### 3.2 Outputs (all are proposals; nothing is applied directly)

| Output | Destination | Gate |
| --- | --- | --- |
| Learning observation (raw) | `_company/learning/observations.jsonl` (append-only) | none — internal log |
| `improvement-proposal` card | `_company/learning/proposals/<id>.json` | founder or Chief of Staff triage |
| Lesson bullet for `company/LESSONS.md` | PR on `factory/learning/lessons-<date>` branch | founder merge; **redaction pass first** (§6) |
| Lesson bullet for a project `context/MEMORY.md` | `## Context change proposal` on the relevant task PR, or its own PR | founder / reviewer merge |
| Prompt edit (`factory/prompts/<role>.md`) or standard edit (`company/ENGINEERING_STANDARDS.md`) | PR on `factory/learning/*` branch | founder merge; must include before/after + the evidence tasks |
| Founder question | Decision Store, `kind: "strategic-pattern"` | founder answer |
| Weekly Learning Digest | `_company/learning/digests/<iso>.json` + `.md` | none — read by founder snapshot; no UI |

### 3.3 Schedule

| Pass | Trigger | Budget | Does | Web |
| --- | --- | --- | --- | --- |
| **post-task** | task reaches `merge-ready` or `blocked` | ≤ 2 min, no model spend beyond a short extraction | append 1 observation (failure shape, retries, routed-back stage, finding categories) | no |
| **daily** | cron (e.g. 06:00) | bounded | cluster observations over a trailing window; emit `improvement-proposal` cards for clusters above threshold (same finding category ≥ 3 in 14 days; a stage failing ≥ 2 distinct tasks; a recurring blocker theme) | no |
| **weekly** | cron | larger | take top open proposals; do bounded research; draft concrete prompt/standard edits on `factory/learning/*`; write the Digest; raise founder questions for strategic patterns | yes (allowlist + budget) |

### 3.4 Permissions

| Capability | Allowed | Denied |
| --- | --- | --- |
| Read any project repo (where `learningOptIn`) | ✅ read-only | ✏️ writing to a project repo outside a `factory/learning/*` branch |
| Read all factory task state + Decision Store + sensor runs | ✅ | mutating task `state.json` |
| Write `_company/learning/**` | ✅ (its own queue + observations + digests) | writing any other `_company/**` path |
| Open PRs on `factory/learning/*` branches | ✅ | pushing to `main`, merging, deleting branches |
| Open GitHub issues labelled `learning` / `needs-founder` | ✅ | closing others' issues |
| Web research | ✅ within `company.json.learning.researchAllowlist` + `maxResearchCallsPerRun` | arbitrary fetch; posting anywhere external |
| Edit `context/` files directly | ❌ | — |
| Dispatch / resume / approve tasks, edit `factory.config.json`, touch production, spend money | ❌ | — |

Everything it produces is founder- or reviewer-gated. It cannot change how the
company behaves on its own; it can only *propose*.

---

## 4. Proactive Company Behaviour — A / B / C

Any judgement call an agent or sensor faces resolves to exactly one outcome.
Machine table: `company/behavior-protocol.json`; prose: `company/BEHAVIOR_PROTOCOL.md`.
Evaluator: `factory/lib/company/behavior.mjs` →
`classify({ task, change, conflict }) -> { outcome: "A"|"B"|"C", reason, triggerId }`.

### 4.1 The three outcomes

| Outcome | Meaning | Effect on the task | Founder involvement |
| --- | --- | --- | --- |
| **A — Continue autonomously** | Reversible, in scope, no precedence conflict, no policy trigger | proceed; document the choice in the stage summary; propose a `MEMORY.md` bullet if the choice is novel | none |
| **B — Founder question (async, non-blocking)** | A strategic/irreversible/privacy/spend/public/scope/UX-promise trigger, **or** a detected risk / opportunity / tech-debt item needing a strategic call, **or** silent context drift | block **only** the affected sub-task; continue everything else; emit a Decision Card to the Store | answers when convenient; SLA reminder |
| **C — Stop and wait (blocking)** | The task cannot make *any* safe progress without an answer, **or** proceeding needs a higher-precedence rule broken (§2.4), **or** a prohibited autonomous action is otherwise unavoidable | park the task; time-boxed | must answer; on timeout → fall back to documented default and downgrade to B — **except** prohibited-action cases, which stay stopped |

Default bias is **A**. "C" is rare by design — the product is founder attention
compression.

### 4.2 Detection categories → default routing

| Category | Detector (sensor / signal) | Default | Escalates to |
| --- | --- | --- | --- |
| **Missing information** | `missing-context` sensor; `context-drift`; ambiguous acceptance criteria flagged by `product` | B if it changes scope/interpretation; else A with a documented assumption + `MEMORY.md` proposal | C if the task is fully blocked on it |
| **Risk** | `risk` sensor; ≥N stage failures; repeated `security` FAIL; `ownership.risks` with no owner/mitigation | B (Decision Card, `kind:"risk"`) | C if the risk is imminent data-loss / irreversible |
| **Opportunity** | `opportunity` sensor; a roadmap blocker just cleared; repeated manual toil; a metric stalling near target | B (`kind:"opportunity"`), low SLA | never C |
| **Technical debt** | `tech-debt` sensor; TODO density delta; missing tests for changed modules; recurring reviewer finding category | A (proceed) + Learning Agent `improvement-proposal`; B only if debt blocks the acceptance criteria | C never |
| **Strategic question** | Chief of Staff at intake; `behavior.mjs` trigger; Learning Agent weekly pattern | B (`kind:"strategic"`) | C if execution genuinely cannot start |

`company/behavior-protocol.json` holds the trigger list (keyword / field
predicates) → outcome, mirroring the decision protocol from the Intelligence
Layer proposal §8.2 and re-used verbatim so there is one table, not two.

---

## 5. Founder Decision System

### 5.1 Decision Card — canonical format

Exactly the founder's format, rendered in `.md`, plus a machine header:

```
# Decision Card <id>

Question:          <one sentence — the choice>
Context:           <2–4 sentences — what is happening, what is blocked>
Why it matters:    <the stakes — privacy / spend / scope / irreversibility / user promise>
Options:
  A) <option>  — benefit: <…>  · cost/risk: <…>
  B) <option>  — benefit: <…>  · cost/risk: <…>
Recommendation:    <A or B> — <shortest useful reason>
Impact:            <what changes once decided; what stays paused until then>

---
Reply: `A`, `B`, `custom: <text>`, or `discuss`.
```

Machine sidecar (`_company/decisions/<id>.json`, schema §7):

```json
{
  "version": 1,
  "id": "DEC-2026-014",
  "project": "lifemaxing",
  "kind": "strategic",                 // strategic | risk | opportunity | clarification
                                       // | resolve-contradiction | strategic-pattern | approve-high-risk-build
  "raisedBy": { "type": "sensor", "id": "blocked-decision" },  // sensor | agent | learning | chief-of-staff | founder
  "blocks": ["issue-lifemaxing-42"],
  "precedenceLevel": 1,
  "risk": "high",
  "question": "Store LifeMaxing health data locally on-device or synced to our backend?",
  "options": [
    { "key": "A", "title": "Local only", "benefit": "…", "cost": "…" },
    { "key": "B", "title": "Backend sync", "benefit": "…", "cost": "…" }
  ],
  "recommendation": { "option": "A", "reason": "Smallest privacy surface for v1." },
  "impact": "Wearable sync architecture + onboarding consent copy depend on this.",
  "createdAt": "2026-09-03T20:15:00Z",
  "sla": { "reminderHours": 24, "expireHours": 168, "onExpire": "apply-recommendation" },
  "status": "open",                    // open | answered | accepted | expired | withdrawn
  "answer": null,
  "decisionRef": null                  // -> "<project decisionLog>#SFD-LM-2026-00X" once accepted
}
```

### 5.2 Lifecycle

```
open ──(reminder at sla.reminderHours)──► open
open ──founder replies──► answered(A|B|custom|discuss)
answered ──Chief of Staff records──► accepted
   └─► append SFD entry to <project>.decisionLog  (via the task PR)
   └─► clear id from ownership.openDecisions
   └─► resume the blocked sub-task(s) with the new decision pinned in context
open ──(sla.expireHours, onExpire=apply-recommendation)──► expired
   └─► recommendation applied as the working decision
   └─► loud entry in the founder snapshot + weekly digest
   └─► still recorded in decisionLog, marked "expired-default, revisit"
```

- `kind: "approve-high-risk-build"` does **not** use this auto-expire path — it
  requires the existing Ed25519 signed approval flow
  (`factory/lib/task-workflow.mjs`), unchanged. The card just tracks that it is
  pending.
- `founderControlPlane.resolveFounderDecision()` is kept and becomes a **thin
  writer** into this store (`answered` → `accepted`). `control-plane.json`
  `questions[]` are migrated to `kind: "clarification"` cards.

### 5.3 "The ball is now in your court"

A single consolidated signal, computed by `factory/lib/company/decisions.mjs`
and exposed by `scripts/company-status.mjs` (JSON only — no UI):

```json
{
  "ballInYourCourt": {
    "count": 3,
    "oldestHours": 51,
    "highestImpact": "DEC-2026-014",
    "byProject": { "lifemaxing": 2, "campuscart": 1 },
    "slaBreached": 1
  },
  "decisions": [ /* open cards, newest first */ ],
  "projects":  [ /* from founderControlPlane.buildFounderOverview */ ],
  "learningDigest": "_company/learning/digests/2026-09-01.md"
}
```

The founder's existing `/api/founder/overview` endpoint can later call the
richer builder; COS does not require any endpoint or UI change to function —
`node scripts/company-status.mjs` prints the same JSON.

---

## 6. Multi-project architecture

### 6.1 Shared vs isolated

| Tier | Lives in | Contents | Shared across projects? |
| --- | --- | --- | --- |
| **Company (shared)** | HQ repo `company/` + `factory/lib/*` + `factory/prompts/*` + `factory/schemas/*` | mission, engineering standards, **sanitised** cross-project lessons, decision protocol, behaviour protocol, glossary, the Learning Agent, all capability code, all sensors | **yes** — one copy |
| **Project (isolated)** | project repo `context/` + `dashboard/backend/data/factory/<stateKey>/` | the 7 files + `ownership.json`, the project's decision cards, questions, sensor state, task state | **no** |

Projects **share**: company intelligence, generalised lessons, engineering
standards, the workflow engine, role prompts, the decision & behaviour
protocols.

Projects **do not share**: private `context/`, user data, confidential
decisions, task state, metrics, decision cards.

### 6.2 Isolation enforcement

- The context assembler resolves context **only** from the task's own registry
  entry (Phase 1 guarantee). No path outside `resolveRepoPath(entry)/contextDir`
  is ever read (`redact.assertInsideDir`).
- `isolation: "confidential"` adds:
  - the pack's Global DIGEST omits `LESSONS.md` bullets unless the lesson id is
    in `company.json.confidentialLessonWhitelist`;
  - Decision Cards for this project never name another project (the Learning
    Agent and Chief of Staff must phrase patterns generically);
  - `learningOptIn` may be `true` (Learning Agent may read task state) while the
    project stays `confidential` (nothing project-identifying is promoted) — the
    two flags are independent.

### 6.3 Lesson promotion (project → company)

```
project task fails repeatedly with pattern P
        ▼
Learning Agent post-task/daily pass records an observation
        ▼
daily pass clusters → improvement-proposal card
        ▼
weekly pass drafts a LESSONS.md bullet
        ▼
redact.scrubText + a manual generalisation step: strip project name,
   user specifics, confidential decision details — keep only the pattern
   and the mitigation
        ▼
PR on factory/learning/lessons-<date>  ──►  founder merges  ──►  now in every project's Global DIGEST
```

Nothing project-confidential crosses the boundary; only the generalised
engineering pattern does, and only with founder sign-off.

---

## 7. Files & schemas

### 7.1 New / changed files

```
company/
  company.json                       NEW  shared company config (see §7.2)
  COMPANY.md                         NEW  what the company is / how it operates (pinned source)
  ENGINEERING_STANDARDS.md           NEW  cross-project standards (pinned source; keep the top rules terse)
  LESSONS.md                         NEW  accepted, sanitised cross-project lessons (digest source)
  DECISION_PROTOCOL.md               NEW  prose escalation contract (canonical; from Intelligence Layer Phase 1)
  BEHAVIOR_PROTOCOL.md               NEW  prose A/B/C
  behavior-protocol.json             NEW  machine A/B/C trigger table
  GLOSSARY.md                        NEW  shared terms

factory/
  projects.json                      CHANGE  registry v2 (§1.1): company block + isolation, stateKey, decisionLog, learningOptIn
  factory.config.json                CHANGE  add openclawIntegration.agentIds.learning  (one line)
  prompts/
    company-learning-agent.md        NEW  permanent role prompt
  schemas/
    company.schema.json              NEW
    projects.schema.json             CHANGE  v2 fields
    behavior-protocol.schema.json    NEW
    decision-card.schema.json        NEW
    founder-question.schema.json     NEW  (clarification-kind card; may be folded into decision-card)
    improvement-proposal.schema.json NEW
    learning-observation.schema.json NEW
  lib/
    context/
      assemble.mjs                   CHANGE  3-tier pack, [PINNED]/[DIGEST] tagging, provenance lines, token counting
      precedence.mjs                 NEW  conflict-resolution evaluator (§2.4)
    company/
      registry.mjs                   NEW  company + project resolution (wraps context/registry.mjs)
      events.mjs                     NEW  append-only reader/writer for observations & activity
      decisions.mjs                  NEW  unified Decision Store (cards + clarifications + ball-in-your-court)
      behavior.mjs                   NEW  A/B/C classifier over behavior-protocol.json
      learning.mjs                   NEW  Learning Agent analysis passes (pure funcs + adapter glue)

scripts/
  company-status.mjs                 NEW  JSON snapshot: ball-in-your-court + projects + digest pointer
  company-decide.mjs                 NEW  open | answer | accept | expire | withdraw a Decision Card
  company-learn.mjs                  NEW  run  post-task | daily | weekly  learning pass

dashboard/backend/data/factory/       (all gitignored — runtime)
  _company/
    decisions/<id>.json               unified decision store
    learning/
      observations.jsonl
      proposals/<id>.json
      digests/<iso>.{json,md}
  <stateKey>/
    decisions/  questions/  sensor-runs/   per-project, isolated

docs/software-factory/
  COMPANY_OS_ARCHITECTURE.md          THIS document
```

Unchanged (must stay unchanged): `factory/lib/task-workflow.mjs`,
`openclaw-protocol.mjs`, `openclaw-runner.mjs`, `task-initializer.mjs`,
`natural-language-intake.mjs`, `scripts/openclaw-factory.mjs`,
`scripts/factory-task.mjs`, `factory/prompts/{product,architect,builder,reviewer,qa,security,release}.md`,
`factory/schemas/{openclaw-request,agent-result,founder-approval}.schema.json`,
the `./run.sh` boundary, and everything under `dashboard/backend/` except the
gitignored `data/` tree.

### 7.2 `company/company.json`

```json
{
  "version": 1,
  "name": "OpenClaw",
  "mission": "Run AI-native startups where the founder sets direction and agents execute.",
  "pinnedSources": {
    "prohibitedActions": "factory/factory.config.json#prohibitedAutonomousActions",
    "engineeringStandards": "company/ENGINEERING_STANDARDS.md",
    "decisionProtocol": "company/DECISION_PROTOCOL.md",
    "behaviorProtocol": "company/behavior-protocol.json"
  },
  "contextBudget": {
    "globalPinnedTokens": 400, "globalDigestTokens": 250,
    "projectPinnedTokens": 750, "projectDigestTokens": 700
  },
  "learning": {
    "agentId": "learning",
    "postTask": true,
    "dailyCron": "0 6 * * *",
    "weeklyCron": "0 7 * * 1",
    "researchAllowlist": ["developer.mozilla.org", "owasp.org", "nodejs.org", "web.dev"],
    "maxResearchCallsPerRun": 8,
    "proposalBranchPrefix": "factory/learning/"
  },
  "confidentialLessonWhitelist": []
}
```

### 7.3 Schema summaries

- **`company.schema.json`** — the §7.2 shape; `version` const 1; `learning`
  object required; `contextBudget` all positive integers.
- **`projects.schema.json` v2** — Phase 1 fields plus `stateKey` (string, req),
  `decisionLog` (repo-relative string, req), `isolation`
  (`enum[standard,confidential]`, default `standard`), `learningOptIn` (bool,
  default `true`); top-level `company.configPath` (string, req); `version` const 2.
- **`decision-card.schema.json`** — the §5.1 sidecar; `kind` enum;
  `raisedBy.type` enum; `options[]` each `{key,title,benefit,cost}`;
  `recommendation{option,reason}`; `sla{reminderHours,expireHours,onExpire}`
  with `onExpire` enum `[apply-recommendation, stay-blocked]`; `status` enum;
  `decisionRef` string|null.
- **`founder-question.schema.json`** — a `decision-card` with
  `kind:"clarification"`, `options` optional, `sla.onExpire:"stay-blocked"`.
  (Can be merged into `decision-card.schema.json` with `options` optional.)
- **`improvement-proposal.schema.json`** —
  `{ version, id, scope: "prompt"|"standard"|"process"|"lesson", target (path),
     problem, evidenceTasks[] (state paths), proposedChange, expectedEffect,
     confidence: low|medium|high, status: open|drafted|pr-open|accepted|rejected,
     prBranch?, createdAt }`.
- **`learning-observation.schema.json`** (one JSONL line) —
  `{ version, at, project, taskId, terminalState: "merge-ready"|"blocked",
     failedStages[], retries: {stage:count}, routedBackFrom?, blockerKind?,
     findingCategories[], notes }`.
- **`behavior-protocol.schema.json`** —
  `{ version, defaultOutcome: "A", triggers: [ { id, match: {anyKeyword?[], field?, equals?}, outcome: "A"|"B"|"C", kind, reason } ], sla: {reminderHours, blockingTimeoutHours} }`.

---

## 8. Implementation roadmap

Phase 1 (Intelligence Layer — Project Context Layer) is a **prerequisite** and is
already specified in `INTELLIGENCE_LAYER_IMPLEMENTATION_PLAN.md`. The phases below
layer on top. Each is independently shippable, engine-untouched, adapters + libs +
schemas + tests only.

### Phase C1 — Company tier & 3-tier context  *(depends: Phase 1)*
- Create `company/` (all files) and `company/company.json`.
- Extend `assemble.mjs` to the 3-tier `[PINNED]/[DIGEST]` format with provenance
  lines and token counting; add `factory/lib/company/registry.mjs`.
- `projects.json` → v2 (`stateKey`, `isolation`, `decisionLog`, `learningOptIn`,
  `company` block); `projects.schema.json` v2; `company.schema.json`.
- `factory-context.mjs show --count` prints per-tier token counts.
- Tests: 3-tier assembly, budget trimming order, `pinned-overflow` finding,
  provenance lines present, unregistered/`confidential` degrade paths.
- Regression: `npm run test:factory` green; `factory:smoke` reaches merge-ready.

### Phase C2 — Conflict resolution  *(depends: C1)*
- `factory/lib/context/precedence.mjs` + the ladder in §2.4.
- Assembler tags each pinned statement with its precedence level; adds a
  `## Precedence` note when two sources disagree.
- `company/BEHAVIOR_PROTOCOL.md` + `behavior-protocol.json` +
  `factory/lib/company/behavior.mjs` (`classify → A|B|C`).
- Tests: contradiction → `apply`; unresolvable → `stop`; drift → `founder-question`.

### Phase C3 — Unified Decision System  *(depends: C2; integrates Founder Control Plane)*
- `factory/lib/company/decisions.mjs` — the store, lifecycle, `ballInYourCourt`.
- `decision-card.schema.json`, `founder-question.schema.json`.
- `scripts/company-decide.mjs` (`open|answer|accept|expire|withdraw`),
  `scripts/company-status.mjs` (snapshot).
- Migrate `control-plane.json.questions` → `kind:"clarification"` cards;
  re-point `founderControlPlane.resolveFounderDecision` through the store
  (keep the endpoint contract identical).
- Chief of Staff prompt: on `accept`, append the SFD entry to the project
  `decisionLog` and clear `ownership.openDecisions`.
- Tests: full lifecycle incl. `expired → apply-recommendation`; high-risk card
  never auto-expires; snapshot JSON shape.

### Phase C4 — Company Learning Agent  *(depends: C3)*
- `factory/prompts/company-learning-agent.md`; `factory.config.json` agent id
  `learning`.
- `factory/lib/company/learning.mjs` (pure analysis) + `factory/lib/company/events.mjs`.
- `scripts/company-learn.mjs` with `--pass post-task|daily|weekly`.
- Schemas: `improvement-proposal`, `learning-observation`.
- Post-task hook: `openclaw-runner`/adapter calls `company-learn --pass post-task`
  on terminal state (a shell-out from the adapter layer, **not** an engine edit).
- Permissions enforced by the adapter (branch prefix, read-only repo access,
  research allowlist + budget).
- Tests: observation extraction from a fixture `state.json`; daily clustering
  threshold; weekly produces a digest + at least one proposal from seeded
  observations; redaction runs before any `LESSONS.md` proposal.

### Phase C5 — Proactive sensors feeding A/B/C  *(depends: C2, C3; = Intelligence Layer proposal Phase 3)*
- `factory/lib/sensors/{missing-context,blocked-decision,risk,tech-debt,opportunity}.mjs`
  + `factory/lib/questions/queue.mjs` (fingerprint dedupe).
- Each sensor finding runs through `behavior.classify` → A (log) / B (Decision
  Card) / C (block) and lands in the project's isolated `questions/` +, for B/C,
  the Decision Store.
- `scripts/factory-sense.mjs` (`run --all|--project`, `list`, `dismiss`); founder
  adds the cron entry.
- Tests: the Fitbit-style example — `blocked-decision` raises a
  `kind:"strategic"` card that `blocks` the task before it starts.

### Phase C6 — Cross-project promotion & confidential hardening  *(depends: C4)*
- Lesson-promotion flow (§6.3) end to end, including the manual generalisation
  gate and `confidentialLessonWhitelist`.
- `confidential` isolation rules in the assembler (omit `LESSONS.md`, generic
  Decision Card phrasing) with tests.
- Weekly digest surfaces stale-context SLAs (§1.3) and expired-default decisions.

---

## 9. What the founder does after this ships

1. Writes / edits `VISION.md`, `ROADMAP.md`, `USERS.md`, `ownership.json`
   priorities per project. (Minutes, occasionally.)
2. Reads `scripts/company-status.mjs` output — or its eventual place in the
   existing founder view — and answers Decision Cards: `A`, `B`,
   `custom: …`, or `discuss`.
3. Merges Learning Agent PRs (prompt / standard / lesson edits) after a glance.
4. Never opens a task, never watches a stage, never routes a review.

Everything else — decomposition, implementation, review, QA, security, evidence,
context upkeep proposals, risk and debt detection, lesson capture — is the
agents' job, and the Company OS is the contract that makes them do it
consistently across LifeMaxing, CampusCart, and every startup after them.

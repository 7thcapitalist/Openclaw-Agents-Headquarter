# Project Intelligence System

Status: Architecture accepted for phased build. Phase 1 implemented in this change.
Date: 2026-09-03
Scope: the intelligence layer only. No UI. No change to the workflow engine.

Consolidates and supersedes the two working drafts
`INTELLIGENCE_LAYER_PROPOSAL.md` (deep infrastructure detail) and
`INTELLIGENCE_LAYER_IMPLEMENTATION_PLAN.md` (Phase 1 module spec). Those remain
in the repo as the detailed reference for the assembler internals, the redaction
guard, and the test matrix; this document is the canonical description of the
system and its charter.

---

## 1. The idea

The factory today *executes* tasks. It does not *understand* the companies it
builds. A builder picking up a handoff sees the task outcome, the acceptance
criteria, and its role prompt — nothing about why the product exists, who the
users are, what architecture it must respect, what was already decided, or what
the founder cares about this quarter. And nothing in the system notices that
something is missing, ambiguous, risky, or worth the founder's attention until a
running task hits a wall and returns `decision-required`.

The Project Intelligence System adds the missing layer: **every project gets an
intelligent employee that is responsible for understanding and improving it.**

This is not a founder agent and not a new pipeline stage. It is a per-project
role — the **Project Intelligence** — with a fixed charter:

> Know why this project exists, what it is trying to do, what has been decided,
> what is unresolved, what is risky, and what matters now. Make sure every agent
> that touches the project carries that knowledge. Improve that knowledge after
> every meaningful event. Bring the founder exactly the decisions that are
> theirs to make, and nothing else.

Concretely: LifeMaxing has a LifeMaxing Project Intelligence. CampusCart has a
CampusCart Project Intelligence. A future startup gets one the moment it is
registered. They share the same capability code; they never share memory.

---

## 2. What must not change

| Invariant | Why |
| --- | --- |
| The 7-stage state machine (`factory/lib/task-workflow.mjs`) — `STAGES`, `completeStage`, `routeStageFailure`, evidence / independence / founder-approval gates | The engine is proven; the intelligence layer is inputs and reads, never a second state machine |
| The dispatch protocol (`openclaw-protocol.mjs`), the JSON adapter surface (`openclaw-factory.mjs`), the request/result schemas | Stable machine contract |
| `writeHandoff()` signature `{ hqRoot, statePath, state, resultPath?, dispatchId? }` | The one seam; extended in place, not reshaped |
| Role prompts `factory/prompts/*.md` | Behavior is defined there; the pack adds knowledge, not instructions |
| `./run.sh` execution boundary, worktree isolation, human-merge (SFD-2026-003/004/005) | Operator control |
| `factory/lib/*` depends on Node builtins only; no new npm dependency | Keeps the engine auditable and portable |
| Repo is the durable source of truth; private OpenClaw state stays local | SFD-2026-004 |

If a change seems to require touching any of these, stop and re-scope.

---

## 3. Design principles

- **One seam.** All context enrichment enters through `writeHandoff()`. If an
  agent is dispatched, it gets the pack. There is no second injection point.
- **Deterministic first.** Context assembly and decision classification are pure
  functions over files + task state. No model call, fully unit-testable.
  Model-backed sensing is a later, optional layer, and it may only *raise
  questions* — never act.
- **Adapters, not daemons.** New capability ships as one JSON-in / JSON-out
  script (`scripts/project-intel.mjs`) in the style of `openclaw-factory.mjs`.
  No always-on process.
- **Isolation is structural.** Context is resolved strictly from the task's own
  project entry in a committed registry. A LifeMaxing task cannot receive
  CampusCart context because the code never looks anywhere else.
- **No secret ever enters a pack.** A redaction guard refuses files outside the
  declared context directory and scrubs key material from every fragment.
- **Bias to continue.** The product is attention compression. "Ask the founder"
  is the rare exception, not the reflex.

---

## 4. Canonical project context files

Scaffolded into each project's context directory from
`factory/templates/project-context/`. Nine prose files plus one machine mirror.

| File | Answers | Primary maintainer | Read by |
| --- | --- | --- | --- |
| `PROJECT.md` | What is this, current status, current phase, how work flows | founder + agents via PR | every stage |
| `VISION.md` | Why the product exists, the 1–2 year bet, non-goals | founder | architect, product, reviewer |
| `MISSION.md` | The concrete thing the team is trying to do now, and the success metrics for it | founder + Project Intelligence | every stage |
| `ROADMAP.md` | Ordered milestones, the current one, what is explicitly deferred | founder + Project Intelligence | product, architect |
| `DECISIONS.md` | Accepted durable decisions (SFD-style stable IDs, rationale, consequences, supersession) | Project Intelligence on founder acceptance | architect, builder, reviewer, security |
| `MEMORY.md` | Durable non-obvious facts learned while building ("we tried X, it failed because Y") | any agent via PR | every stage |
| `TECH_CONTEXT.md` | Stack, environments, architectural constraints, an explicit "do not do" list, observability | architect + builder via PR | architect, builder, qa, security |
| `USERS.md` | Who the users are, their jobs-to-be-done, sensitivities (e.g. health data), consent/support constraints | founder + product | product, architect, security, qa |
| `COMPETITIVE_CONTEXT.md` | The alternatives users have today, this project's wedge, what it deliberately will not compete on | founder + Project Intelligence | product, architect, reviewer |
| `ownership.json` | Machine mirror: mission, success metrics, current priorities, risks, open decisions, responsible agents | Project Intelligence; founder accepts | the assembler, the dashboard |

Rules:

- The prose files are for humans and agents to read in depth. `ownership.json`
  is the machine-authoritative mirror. If prose and `ownership.json` disagree,
  agents **stop and surface it** rather than guessing (same rule as
  `factory.config.json` ↔ `PROJECT_CONTEXT.md`).
- Agents may **propose** edits only through the task's own PR. They never edit
  another project's context and never edit context outside their worktree.
- A file that is missing, stale beyond a threshold, or below a substance bar is
  a finding for the `missing-context` sensor (Phase 3) and shows up in
  `project-intel lint` today.

### Where the files live

In **each project's own repo**, under a `contextDir` named in the registry
(default `context/`). The context travels with the code it describes, versions
with it, and is reviewed with it. HQ holds only the registry, runtime queues,
and distilled digests. The factory is itself a project: its `contextDir` is a
new top-level `context/` in this repo, scaffolded and hand-filled from the
existing `docs/software-factory/*` documents, which stay canonical for detail.

---

## 5. Multi-project architecture

### 5.1 Registry

`factory/projects.json` (committed; schema `factory/schemas/projects.schema.json`):

```json
{
  "version": 1,
  "projects": [
    { "key": "openclaw-factory", "name": "OpenClaw Agents Headquarter",
      "repo": ".", "contextDir": "context", "status": "active" }
  ]
}
```

- A task contract's existing `project` field is the key into this registry.
- `repo` + `contextDir` resolve to where the ten files live, inside the task's
  **worktree** (the agent already has them on disk).
- Adding LifeMaxing / CampusCart is a one-line entry each once their local repo
  paths are confirmed. Until then they run as unregistered projects: they get
  factory context + task context + a "not registered" note, never another
  project's context.

### 5.2 Runtime state per project (HQ, gitignored)

Under the existing `dashboard/backend/data/factory/<key>/`, added by later
phases: `decisions/` (open decision requests), `questions/` (deduplicated
proactive questions), `sensor-runs/` (audit), alongside the existing `tasks/`
workflow state. The existing `control-plane.json` keeps owning pause/resume and
the ask-a-question log.

### 5.3 Isolation guarantee

| Shared (capability) | Isolated (per project) |
| --- | --- |
| `factory/lib/*` engine, sensors, classifier | Vision, mission, roadmap |
| Role prompts | Accepted decisions, open decisions |
| Decision protocol, redaction guard | Durable memory, tech context, users, competitive context |
| The `project-intel` adapter | Success metrics, priorities, risks, responsible agents |
| OpenClaw tools and agents | Runtime question / decision queues |

The assembler takes exactly one project key (from `state.task.project`),
resolves exactly one registry entry, and reads exactly one `contextDir` under
exactly one worktree. There is no code path that merges two projects.

---

## 6. Context assembly — the one seam

`factory/lib/intel/assemble.mjs` → `assembleContextPack({ hqRoot, state, now })`
→ `{ text, sections, warnings }`. Called by `writeHandoff()`, which prepends the
returned text between the handoff header and `## Outcome`. Every agent
invocation — initial handoff, every stage dispatch, resume, approve, founder
decision resume — now carries:

```
## Factory context (global)
- Operating mode: human-merge. Prohibited autonomous actions: <factory.config.json>
- Required gates: <factory.config.json>
- Decision protocol: continue reversible in-scope work; strategic / irreversible /
  privacy / spend / public / scope changes -> Decision Request; blocking
  clarification only as a last resort. Full protocol: factory/context/DECISION_PROTOCOL.md

## Project context: <name>  (key: <key>)
- Mission: <ownership.json.mission>
- Success metrics: <name: current -> target (asOf)> ...
- Current priorities: <p1>, <p2> ...
- Active risks: <r1 [high]>, ...
- Open decisions blocking work: <ID "title"> ...
- Responsible agents: architect=claude, builder=codex, product owner=founder
- Vision: <VISION.md first paragraph>
- Current milestone: <ROADMAP.md current section>
- Tech constraints: <TECH_CONTEXT.md constraints / do-not-do section>
- Users: <USERS.md primary user + primary sensitivity>
- Competitive wedge: <COMPETITIVE_CONTEXT.md positioning>
- Recent durable facts: <last N MEMORY.md bullets>
- Last accepted decisions: <last N DECISIONS.md headings>
- Full context files are in your worktree at: <contextDir>/
```

Properties: **deterministic and pure** (fixed `now` + fixed files → byte-identical
output); **budgeted** (each section has a character cap; long files contribute a
digest, never their whole body); **degrades gracefully** (missing file → one
warning line, never an error); **redaction-guarded**. The only thing that can
make it throw is a structurally broken `factory/projects.json` — and
`writeHandoff()` catches even that and falls back to a one-line note, so a
misconfiguration never blocks a dispatch.

---

## 7. Founder interaction model — the decision machine

Every judgement call an agent, the Chief of Staff, or a sensor faces resolves to
exactly one of four outcomes. `factory/decision-protocol.json` is the machine
form; `factory/context/DECISION_PROTOCOL.md` is the canonical prose;
`factory/lib/intel/classify.mjs` `classifyDecision({ text, fields, protocol })`
is the pure evaluator.

| Outcome | When | Effect |
| --- | --- | --- |
| **continue** | Reversible, in declared scope, no trigger hit (names, refactors, test structure, small deps, minor UX already implied by the task) | Decide, record the choice in the handoff / `MEMORY.md`, keep working. This is the default. |
| **decision-request** | A trigger is hit: product direction or target user; scope / milestone priority; privacy, data-retention, or security posture; meaningful or recurring spend; public / external communication; destructive production op; hard-to-reverse migration; legal / compliance; a UX tradeoff that changes the product promise. Also: any `risk: "high"` task. | Emit a Decision Card (`factory/templates/decision-card.md`), add it to the project decision queue, **block only the affected sub-task**, keep everything else moving. Founder answers asynchronously. |
| **ask** | Rare. The task cannot make *any* safe progress and one short factual clarification unblocks it. | Post a time-boxed blocking question. If it times out, fall back to the documented default and downgrade to a decision-request. |
| **block** | A gate the engine already owns fails (missing evidence, failed independent review, unresolved strategic decision, high-risk build without signed approval). | The existing state machine handles this unchanged; the intelligence layer only makes the reason legible. |

The founder is brought in only for **decision-request** and the existing
high-risk signed-approval gate. Everything else the system resolves and records
itself. This is the whole point: the founder sees strategic choices, important
tradeoffs, threshold-exceeding risks, and genuine ambiguity — never variable
names, never routine failures.

The `risk: "high"` → signed-approval-before-build gate in `task-workflow.mjs` is
unchanged and referenced by the protocol's `riskBinding`; the classifier does
not replace or weaken it.

---

## 8. Proactive sensing (Phase 3)

A **Sensor** is a read-only analysis pass — not a workflow stage. It runs
outside the engine, cannot write to a repo, cannot start a task. It emits
**Findings**. A Finding that needs the founder becomes a **Question**; a
Question that is a strategic or irreversible choice is promoted through
`classifyDecision` to a **Decision Request**.

Deterministic v1 sensor set, each `factory/lib/sensors/<name>.mjs` exporting
`run({ project, registry, factoryStateRoot, now }) -> Finding[]`:

| Sensor | Detects | Deterministic signals |
| --- | --- | --- |
| `missing-context` | Missing information | absent / stale / thin context files; `ownership.json` missing metrics or targets |
| `blocked-decision` | Blocked decisions | task `state.json` with a `decision-required` blocker; `openDecisions` past SLA; roadmap items marked `blocked:` |
| `risk` | Risks | `ownership.json` risks with no mitigation or owner; repeated stage failures on one task; recurring security FAIL of the same class |
| `tech-debt` | Technical debt | TODO/FIXME delta; missing tests for changed modules; the same reviewer finding recurring across PRs; drift from the `TECH_CONTEXT.md` "do not do" list |
| `opportunity` | Opportunities | a roadmap item whose named blocker just cleared; the same manual step run N times; a metric stalling just short of target |

Findings carry a stable `fingerprint` so re-runs are idempotent: an open finding
is not re-raised, and a cleared signal closes it. The
`kind: "founder-decision-required"` findings are exactly the brief's Fitbit
example — raised *before* a task starts, not after it blocks.

Runner: `scripts/factory-sense.mjs` (`run --all` / `run --project` / `list` /
`dismiss`), wired into OpenClaw cron by the founder. No new daemon.

---

## 9. Memory architecture

| Tier | Lives in | Contents | Persists? | Writer |
| --- | --- | --- | --- | --- |
| **Factory memory** | HQ repo: `factory/context/`, `factory.config.json`, `factory/decision-protocol.json`, `docs/software-factory/DECISIONS.md` | How the factory operates, cross-project decisions, role definitions, the decision protocol | Yes — versioned, reviewed | Founder + PR |
| **Project memory** | The project's **own repo**: `<contextDir>/` ten files | Vision, mission, roadmap, accepted decisions, durable facts, tech context, users, competitive context, metrics / priorities / risks | Yes — versioned in that repo | Agents propose via task PR; founder accepts |
| **Project runtime state** | HQ, gitignored: `dashboard/backend/data/factory/<key>/` | Open decision requests, proactive questions, sensor runs, per-task workflow `state.json` | Semi — lives until resolved, then the non-sensitive conclusion is promoted into the repo | Sensors, engine, control plane |
| **Agent memory** | Private OpenClaw workspace (`~/.openclaw`), per agent | Persona, tone, session continuity, scratch reasoning | Local only — never in a repo or HQ state (SFD-2026-004) | The agent runtime |
| **Never persists** | nowhere | Secrets, tokens, OAuth material; raw personal / health data or PII; un-sanitised customer data; model chain-of-thought | Never — must not enter a repo, HQ state, or a pack | — |

Promotion path: a runtime question or decision → founder accepts → the Project
Intelligence distils the **non-sensitive conclusion** into `<project>/DECISIONS.md`
or `MEMORY.md` through the task PR. Nothing sensitive is promoted; raw material
ages out of runtime state.

Redaction guard (`factory/lib/intel/redact.mjs`), applied to every fragment
before it enters a pack, a question body, or a digest:

- **Refuse** any file whose resolved path is outside the project's declared
  `contextDir` (blocks `../../.env` and sibling-repo traversal).
- **Refuse** filenames matching `.env*`, `*.pem`, `*.key`, `id_rsa*`,
  `credentials*`, `secrets*`.
- **Scrub** value patterns: `AKIA…`, `sk-…`, `gh[pousr]_…`, `Bearer …`, PEM
  private-key blocks, `postgres://user:pass@…`.
- On any hit: drop the fragment, insert `[redacted: <reason>]`, and emit a
  `risk` warning so the founder learns a secret was where it should not be.

---

## 10. Phased delivery

Each phase is independently shippable and testable. No phase touches the engine.

- **Phase 1 — Project context layer + decision classifier (this change).**
  Registry + schemas; the ten templates; `intel/registry.mjs`,
  `intel/redact.mjs`, `intel/schema.mjs`, `intel/assemble.mjs`,
  `intel/classify.mjs`; `factory/decision-protocol.json`,
  `factory/context/FACTORY.md`, `factory/context/DECISION_PROTOCOL.md`; the
  `writeHandoff()` wire-in; `scripts/project-intel.mjs`
  (`list` / `scaffold` / `show` / `lint` / `classify`); the factory's own
  `context/` scaffolded and filled; unit tests.
  *Outcome: every stage handoff carries factory + project context, and any
  agent or tool can classify a judgement call against the machine protocol.*

- **Phase 2 — Decision queue.** `intel/decisions/queue.mjs`
  (`open` / `answer` / `accept` / `reject` / `expire`), a `DECISIONS.md`
  appender, `scripts/project-intel.mjs decisions`, and folding the existing
  `founderControlPlane.resolveFounderDecision` in as one writer.
  *Outcome: a strategic ambiguity produces a Decision Card and blocks only the
  affected sub-task.*

- **Phase 3 — Sensors.** `intel/questions/queue.mjs` with fingerprint dedupe,
  the five deterministic sensors, `scripts/factory-sense.mjs`, and the
  founder-overview read path.
  *Outcome: the Fitbit-style question is raised before a task even starts.*

- **Phase 4 — Digest + model-assisted sensing.** One JSON/markdown artefact per
  project (building / in review / blocked / shipped / decisions needing the
  founder / new questions / stale context) and the optional read-only
  `factory/prompts/sensor.md` analyst pass.
  *Outcome: one artefact answers "what needs me?" — still no UI; the dashboard
  can consume the same JSON later.*

---

## 11. Open decisions for the founder

1. **Per-project context in each project's own repo** (recommended, and what
   Phase 1 implements for the factory) **vs.** centralised under HQ.
2. **Local repo paths for LifeMaxing and CampusCart** — needed before either is
   added to the registry. Only doc references exist today.
3. **Sensor autonomy ceiling** (Phase 3): read-only, may only raise questions
   (recommended) vs. may also open a draft `needs-founder` GitHub issue.
4. **Blocking-question timeout fallback** (Phase 2): fall back to the documented
   default and downgrade to a decision-request (recommended) vs. hard-stop the
   task.
5. **Decision-request SLA** (Phase 2): park the affected sub-task indefinitely
   vs. auto-expire to the recommended option after a second threshold with a
   loud digest entry.

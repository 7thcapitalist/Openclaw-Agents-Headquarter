# Proposal: Company Learning System + Learning / R&D Agent

Status: Accepted (SFD-2026-006) and implemented. Phases 1–4 landed on branch
`factory-learning-system`; operational guide in
[`COMPANY_LEARNING_SYSTEM.md`](COMPANY_LEARNING_SYSTEM.md).
Date: 2026-09-03
Scope: an organizational learning layer only. No UI. The workflow engine
(`factory/lib/task-workflow.mjs` state machine, stages, gates) is not modified.

## Founder decisions on §13 (resolved)

1. Knowledge-file write path → **own `learning/*` branch + PR per run**. Publishing
   is opt-in (`--publish` / `{"publish":true}`); the default run is a dry run that
   writes candidate files to `_learning/proposals/` and the digest.
2. The guarded, flag-gated block in `factory/lib/handoff.mjs` → **allowed, off by
   default** (`FACTORY_LEARNING_IN_HANDOFF=1` or `factory.config.json` →
   `learning.injectIntoHandoff`).
3. Shared primitives → shipped under `factory/lib/common/` (`redact.mjs`,
   `fingerprint.mjs`). `factory/lib/intel/redact.mjs` already existed when this
   landed; consolidating the two is left as a follow-up (both are small and the
   `common/` version is a superset with transcript stripping).
4. External-research autonomy ceiling → **confirmed**: read-only, source-cited
   notes only; no auto-created issues, tasks, branches, or PRs.
5. Retention → run logs 90 days (`prune --days`), findings index kept
   indefinitely, raw excerpts dropped on `dismiss`.

## 1. Goal

Today the factory *executes* tasks and then forgets them. Every task produces
rich evidence — failed dispatches, review rejections, QA verdicts, security
findings, decision friction, retry burn, and also clean first-pass successes —
and none of it changes how the next task is run. Role prompts, routing, and
evaluation criteria are tuned by hand, once, and drift.

This proposal adds the missing function of a company: an employee whose whole
job is to make every other employee and every project better over time.

Concretely it introduces:

1. **A new organizational role — the Learning / R&D Agent.** Not assigned to any
   project. Works for OpenClaw HQ itself.
2. **Failure analysis** over completed-task evidence → `LESSONS_LEARNED.md`,
   `ENGINEERING_IMPROVEMENTS.md`, `PROCESS_IMPROVEMENTS.md`.
3. **Success analysis** — patterns, architectures, workflows, and decisions that
   demonstrably worked.
4. **External-knowledge research** — technologies, engineering practice, AI
   developments, startup and product lessons, competitors — brought back as
   sourced, promotable notes.
5. **Agent-improvement recommendations** — better prompts, role definitions,
   workflows, tools, and evaluation criteria, as *proposals* a founder promotes,
   never as silent edits.
6. **Organizational memory** with an explicit global / project / agent split and
   hard never-persist rules.
7. **Feedback loops** — task completes → Learning Agent reviews evidence → finds
   improvements → updates company knowledge → future agents receive better
   instructions.

## 2. What already exists (do not rebuild)

| Capability | Where | Relationship to this proposal |
| --- | --- | --- |
| Deterministic 7-stage lifecycle, isolated worktree per task, evidence + independence + founder-approval gates | `factory/lib/task-workflow.mjs` | **Untouched.** The Learning Agent is a read-only observer of the state it produces. |
| Per-task durable state: `stages`, `events`, `dispatches` (attempt / outcome / summary / error), `blocker`, `founderDecisions`, `assignments`, `task.risk` / `task.workType` | `dashboard/backend/data/factory/<repo>/tasks/<id>/state.json` | **Primary evidence source.** Already written; nothing new to instrument. |
| Per-dispatch handoff + machine result files | `handoff-<stage>.md`, `results/<dispatchId>.json` | Secondary evidence. |
| Stage evidence files (review notes, QA verdicts, security findings, Decision Cards) inside each worktree | referenced by `state.stages[stage].evidence[].path` | Parsed with bounded, redacted extractors. |
| Factory task discovery by walking `state.json` files | `dashboard/backend/lib/founderControlPlane.mjs` `walkStateFiles()` | Reuse the same walk pattern. |
| Decision Card template + Decision Log (SFD IDs) | `factory/templates/decision-card.md`, `docs/software-factory/DECISIONS.md` | Reused verbatim for any strategic recommendation. |
| Escalate / do-not-escalate lists, risk levels, definition of done | `docs/software-factory/OPERATING_RULES.md` | The Learning Agent proposes edits to these; it does not enforce them. |
| **Intelligence Layer proposal** (context assembly, decision protocol, sensors, digest, memory tiers) | `docs/software-factory/INTELLIGENCE_LAYER_PROPOSAL.md` (draft, not built) | **Complementary — see §3.** Shares the memory-tier model and the finding/fingerprint/redaction primitives. |

## 3. Relationship to the Intelligence Layer proposal

They are two halves of one loop and must not duplicate each other.

| | Intelligence Layer | Company Learning System (this doc) |
| --- | --- | --- |
| Direction | **Feed-forward.** What an agent needs to know *before* it starts a task. | **Feedback.** What the company learns *after* tasks finish. |
| Trigger | Every stage handoff. | Terminal task state + schedule + founder request. |
| Timescale | Per dispatch. | Per task, then weekly synthesis, then quarterly review. |
| Output | A Context Pack prepended to the handoff. | Distilled knowledge entries + improvement proposals + a founder digest. |
| Sensors | `missing-context`, `blocked-decision`, `risk`, `tech-debt`, `opportunity` — detect *current* gaps in a *live* project. | Post-mortem analysis — extract *durable* lessons from *completed* work across *all* projects. |

Shared primitives are built **once** and consumed by both (see §10, open
question 3): a secret/transcript redaction guard, a stable finding fingerprint,
and the global/project/agent/never memory-tier contract from Intelligence Layer
§9. If the Intelligence Layer lands first, this system imports its
`factory/lib/context/redact.mjs` and fingerprint helper; if this lands first,
those move to `factory/lib/common/` and the Intelligence Layer imports them.

## 4. Design principles

- **The workflow engine is untouched.** No new stage, no new state-machine
  transition, no change to `task-workflow.mjs`, `openclaw-protocol.mjs`, or the
  dispatch/result schemas. The Learning Agent consumes engine outputs and
  produces documents.
- **Read-only over projects.** The Learning Agent never runs in a task worktree,
  never edits a project repo, never initialises / resumes / completes a task.
- **Deterministic first.** Evidence collection, signal extraction, fingerprint
  dedupe, and the findings queue are pure functions over files and task state —
  no model, no network, fully unit-tested. Model-assisted synthesis and external
  research are a strictly later, optional layer confined to *drafting*
  recommendations.
- **Proposals, not silent edits.** The Learning Agent may write freely to HQ
  runtime learning state. Any change to a committed file — a knowledge file, a
  role prompt, `factory.config.json`, `OPERATING_RULES.md` — is a *proposal* the
  founder promotes (by hand or as a normal low-risk factory task with
  independent review). It cannot self-apply.
- **No secrets, no private data, no chain-of-thought — ever.** Every string that
  could enter a knowledge file, a finding body, a digest, or a research note
  passes the redaction guard (§9). Raw agent transcripts and reasoning traces
  are never read into an output.
- **Adapters, not daemons.** One JSON-in/JSON-out script (`scripts/factory-learn.mjs`)
  in the style of `scripts/openclaw-factory.mjs`, invoked by OpenClaw cron or the
  founder. No always-on process.

## 5. The Learning / R&D Agent role

A company-level role, defined in `factory/prompts/learning-agent.md`. It is **not**
in `factory.config.json.pipeline` and has no entry in the state machine's
`roles`. It is a responsibility with one runner (the adapter) and, in Phase 4,
one optional OpenClaw analyst persona.

Mental model: an in-house MBA + engineering manager + R&D department. It reads
what happened, reads the outside world, and writes back what the company should
do differently — the way an employee returns from a conference with notes.

Hard constraints (enforced by the adapter and stated in the prompt):

- May only emit **Findings** (JSON) and **proposed knowledge entries / research
  notes** (markdown). No write access to any project repo or worktree.
- Cannot start, resume, complete, or route a factory task.
- Never quotes a raw transcript, a secret, or private user data. Cites evidence
  by **path + line range + a redacted excerpt**, never by pasting the artifact.
- Recommendations that are strategic (product direction, spend, privacy posture,
  public communication) are emitted as a Decision Card, not applied.

### Responsibility → mechanism map

| Brief responsibility | Mechanism in this system |
| --- | --- |
| Analyze failures (failed builds, rejected reviews, QA problems, security findings, repeated mistakes) | `analyze.mjs` failure classifiers over `dispatches` / stage outcomes / `failure-routed` events / parsed verdict lines → failure Findings → `LESSONS_LEARNED.md` + `ENGINEERING_IMPROVEMENTS.md` + `PROCESS_IMPROVEMENTS.md` |
| Analyze successes (patterns, architectures, workflows, decisions) | `analyze.mjs` success classifiers: first-pass stages, low dispatch count, short cycle time, repeated passing shapes → success Findings |
| Research external knowledge | Phase 4 `research` action: bounded OpenClaw analyst pass with mandatory source citation → `ResearchNote` → promotable into the engineering/process files |
| Improve other agents | Findings of kind `agent-improvement` targeting a role → proposed diff/notes for `factory/prompts/<role>.md`, routing, or `requiredGates`; promoted as a low-risk factory task |
| Create organizational memory | §8 tiers: `factory/knowledge/` (global), project `context/`/`docs` (project), `factory/knowledge/agents/<role>.md` (agent); never-persist list |
| Design feedback loops | §7 — post-task, weekly synthesis, founder promotion, injection back into handoffs |

## 6. Evidence and deterministic signal extraction (the core)

New directory `factory/lib/learning/` (Node builtins only, mirrors
`factory/lib/*` style, zero npm dependencies):

| Module | Export surface | Purpose |
| --- | --- | --- |
| `evidence.mjs` | `collectTaskRecords({ factoryStateRoot, project?, since? }) → TaskRecord[]` | Walk `tasks/*/state.json` (reuse `walkStateFiles` pattern). Normalize each into a `TaskRecord`: `{ id, project, repo, risk, workType, assignments, terminalStatus, createdAt, endedAt, cycleMs, stageOutcomes[], dispatches[], decisionEvents[], retryByStage{}, blocker }`. Pure over fs. Only **terminal** tasks (`merge-ready`, `blocked` past an age threshold, or explicitly abandoned). |
| `analyze.mjs` | `analyzeTasks(records, { now }) → { failures: Finding[], successes: Finding[], patterns: Pattern[] }` | Pure. Deterministic classifiers (see below). |
| `fingerprint.mjs` | `fingerprint(parts[]) → string` | Stable short hash for dedupe. Shared with the Intelligence Layer. |
| `redact.mjs` | `scrubText(s)`, `isSecretFilename(n)`, `assertInsideDir(base, p)`, `stripReasoningBlocks(s)` | Secret filename + value patterns, path-escape guard, and removal of anything shaped like a raw reasoning trace / transcript block. Conservative. |
| `queue.mjs` | `reconcile(existing, incoming, now)`, `open/promote/dismiss/resolve` | Findings queue with fingerprint dedupe and lifecycle. JSON store under `data/factory/_learning/`. |
| `knowledge.mjs` (Phase 2) | `appendEntry(file, entry)`, `readEntries(file)`, `renderDigest(state)` | Read/append the three knowledge files against a strict entry schema; render the founder digest. |

Deterministic classifiers (v1, no model):

- **Failed builds** — `dispatches` with `outcome:"fail"` / `status:"failed"` at
  `builder`, grouped and fingerprinted by stage + workType + normalized error
  class.
- **Rejected reviews / QA / security** — `reviewer`/`qa`/`security` stage
  failures and `failure-routed` events back to `builder`; verdict lines
  (`CHANGES REQUIRED`, `QA FAIL`, `FAIL`) extracted from the stage evidence
  markdown with a bounded regex, then redacted.
- **Repeated mistakes** — same fingerprint across ≥ N tasks becomes a `Pattern`
  with a count and the list of task IDs.
- **Retry burn** — tasks that hit `maxAttemptsPerStage` on any stage.
- **Decision friction** — `decision-required` blockers; time-to-resolution from
  the `events` timeline; decisions that recur in shape across projects.
- **Successes** — stages that passed on attempt 1; tasks with total dispatch
  count ≤ stage count; cycle time in the fastest quartile; the
  `workType`/`assignments`/architecture shape those tasks share.

Output shape (`factory/schemas/learning-finding.schema.json`):

```json
{
  "id": "L-0007",
  "kind": "failure | success | pattern | agent-improvement | research",
  "scope": "global | project | agent",
  "project": "lifemaxing | null",
  "targetRole": "builder | reviewer | ... | null",
  "fingerprint": "builder-fail:backend:ambiguous-acceptance-criteria",
  "title": "Backend builders fail when acceptance criteria are not testable",
  "observation": "4 of 6 backend builder failures in the last 30 days cite non-observable acceptance criteria; all 4 were later fixed only after the product stage re-specified them.",
  "evidence": [
    { "path": "tasks/issue-42/results/issue-42-builder-2.json", "excerpt": "[redacted summary] criterion 'feels fast' is not testable" }
  ],
  "recommendation": "Require the product stage to emit explicit acceptance tests before the architect stage. Add to requiredGates.",
  "confidence": "high | medium | low",
  "occurrences": 4,
  "taskIds": ["issue-42", "issue-51", "issue-58", "issue-63"],
  "raisedAt": "2026-09-03T20:15:00Z",
  "status": "open | promoted | dismissed | resolved"
}
```

This is the brief's own example, made concrete and evidence-backed.

## 7. Feedback loops

All four run outside the engine.

1. **Post-task loop** (per task, on terminal state).
   `factory-learn.mjs analyze --task <id>` extracts signals from that one task
   and reconciles them into the findings queue. Invoked when
   `openclaw-factory.mjs` returns `merge-ready` or `blocked` — by an OpenClaw
   cron entry or by the Chief of Staff opportunistically. **No engine hook**: it
   only reads `state.json`.

2. **Weekly synthesis loop.**
   `factory-learn.mjs synthesize` clusters open findings across all projects,
   promotes recurring ones to `Pattern`s, drafts proposed entries for the three
   knowledge files and for affected `factory/knowledge/agents/<role>.md` notes,
   and writes `data/factory/_learning/digest.md` — a one-screen founder view:
   new lessons, top recurring failure patterns, engineering improvements,
   process/prompt/eval recommendations, external-research notes awaiting review.

3. **Promotion loop** (founder-gated).
   The founder reads the digest and runs `factory-learn.mjs promote --id L-0007`.
   Promotion appends the accepted, redacted entry to the correct
   `factory/knowledge/*.md` file. If the finding targets a prompt, routing rule,
   or gate, promotion instead scaffolds a normal **low-risk factory task**
   (contract pre-filled) so the change to `factory/prompts/*` or
   `factory.config.json` goes through independent review and human merge like any
   other code change. Nothing strategic is auto-applied.

4. **Injection back to agents** (Phase 3).
   The knowledge reaches future agents through the existing handoff seam:
   - If the Intelligence Layer Context Pack exists: one added section, "Company
     knowledge", = digest of `factory/knowledge/*` + the current role's
     `agents/<role>.md` note. One line in `assemble.mjs`.
   - Otherwise: a guarded, flag-gated block in `factory/lib/handoff.mjs` (the
     markdown renderer, **not** the state machine) appends the role's knowledge
     note and a trimmed `LESSONS_LEARNED` digest after `## Role instructions`.
     Wrapped in try/catch, off unless `FACTORY_LEARNING_IN_HANDOFF=1` (or a
     `factory.config.json` flag), and it can never fail a dispatch. See open
     question 2.

Result: task completes → evidence analysed → lesson found → knowledge updated →
the next comparable handoff carries the lesson. The company gets more capable
every month without a human re-reading every log.

## 8. Organizational memory architecture

Extends SFD-2026-004. Same tiering as Intelligence Layer §9; this system is a
*writer via proposal* into the durable tiers and a *direct writer* into runtime
learning state.

| Tier | Lives in | Contents | Writer |
| --- | --- | --- | --- |
| **Global / company knowledge** | HQ repo (committed): `factory/knowledge/` — `LESSONS_LEARNED.md`, `ENGINEERING_IMPROVEMENTS.md`, `PROCESS_IMPROVEMENTS.md`, `research-agenda.md`, `README.md` | Lessons and improvements that apply to *every* company the factory runs | Learning Agent proposes; founder promotes |
| **Project knowledge** | The project's own repo: `context/MEMORY.md` / `context/DECISIONS.md` (or `docs/`) | Lessons true only for *that* project | Learning Agent proposes a scoped entry via that project's task PR; founder accepts |
| **Agent knowledge** | HQ repo (committed): `factory/knowledge/agents/<role>.md` | Role-specific improvement notes surfaced alongside `factory/prompts/<role>.md` | Learning Agent proposes; founder promotes |
| **Runtime learning state** | HQ, gitignored: `dashboard/backend/data/factory/_learning/` — `runs/<ts>.json`, `findings.json`, `proposals/`, `research/`, `digest.md` | Analysis runs, the live findings queue, draft proposals, raw research notes, dedupe fingerprints | Learning Agent (adapter) directly |
| **Agent runtime memory** | Private OpenClaw workspace (`~/.openclaw`) | Persona, session continuity, scratch reasoning | The agent runtime only — never read by this system |
| **Never persists** | nowhere | Secrets, tokens, credentials; raw / bulk PII or user data; model chain-of-thought and raw transcripts; un-sanitised customer content | — |

Promotion path: runtime finding → founder accepts → the **non-sensitive
conclusion** is distilled into the right committed file. Raw finding bodies and
run logs age out of `_learning/` on a retention window (open question 5).

`.gitignore` already excludes `dashboard/backend/data/`, so `_learning/` is
covered. The new `factory/knowledge/` files are plain docs and are not matched
by any existing ignore rule (the `memory/` rule matches a *directory* named
`memory`, not `LESSONS_LEARNED.md`).

## 9. Redaction guard

`factory/lib/learning/redact.mjs` (or the shared `factory/lib/common/redact.mjs`),
applied to every fragment before it enters a finding, a proposal, a knowledge
entry, a digest, or a research note:

- **Refuse** to read any path that resolves outside the factory state root or the
  target project's declared context/evidence directory.
- **Refuse** filenames matching `.env*`, `*.pem`, `*.key`, `id_rsa*`,
  `credentials*`, `secrets*`.
- **Scrub** value patterns: `AKIA…`, `sk-…`, `gh[pousr]_…`, `Bearer …`, PEM
  private-key blocks, `postgres://user:pass@…`. Replace with `[redacted: <name>]`.
- **Strip** blocks shaped like a raw reasoning trace or a pasted transcript
  (`<thinking>…`, `Chain of thought:`, long first-person deliberation) — the
  Learning Agent works from *summaries and outcomes*, never traces.
- On any hit: drop the fragment, record the reason, and raise a `risk`-flavoured
  finding so the founder learns a secret was where it should not be.

## 10. New / changed files

**New (committed):**

```
factory/prompts/learning-agent.md
factory/knowledge/README.md
factory/knowledge/LESSONS_LEARNED.md            (seeded: header + format + how entries are added)
factory/knowledge/ENGINEERING_IMPROVEMENTS.md   (seeded)
factory/knowledge/PROCESS_IMPROVEMENTS.md        (seeded)
factory/knowledge/research-agenda.md             (Phase 4)
factory/knowledge/agents/README.md               (Phase 3)
factory/lib/learning/evidence.mjs
factory/lib/learning/analyze.mjs
factory/lib/learning/fingerprint.mjs
factory/lib/learning/redact.mjs
factory/lib/learning/queue.mjs
factory/lib/learning/knowledge.mjs               (Phase 2)
factory/schemas/learning-finding.schema.json
factory/schemas/knowledge-entry.schema.json      (Phase 2)
scripts/factory-learn.mjs
factory/test/learning-evidence.test.mjs
factory/test/learning-analyze.test.mjs
factory/test/learning-redact.test.mjs
factory/test/learning-queue.test.mjs
factory/test/factory-learn-cli.test.mjs
```

**Changed (small, additive, all optional per phase):**

```
package.json                                   add "factory:learn" script
docs/software-factory/README.md                link this system in "What to build next"
docs/software-factory/DECISIONS.md             record the accepted decision (SFD-2026-006)
AGENTS.md                                       add factory/knowledge/ to "Memory and decisions"
factory/lib/handoff.mjs                         Phase 3 only: guarded, flag-gated knowledge block (open question 2)
factory/factory.config.json                    Phase 4 only: add openclawIntegration.agentIds.learning (additive)
```

**Explicitly NOT modified:** `factory/lib/task-workflow.mjs`,
`factory/lib/openclaw-protocol.mjs`, `factory/lib/openclaw-runner.mjs`,
`factory/lib/task-initializer.mjs`, `scripts/openclaw-factory.mjs`,
`factory/schemas/{openclaw-request,agent-result,founder-approval}.schema.json`,
the pipeline and the state-machine `roles` in `factory.config.json`.

## 11. `scripts/factory-learn.mjs` (JSON adapter)

Same I/O contract as `scripts/openclaw-factory.mjs`: one JSON request on stdin
(or `--request <file>`), one JSON response on stdout, exit 1 on error. `hqRoot`
derived from the script location.

| action | request fields | does | response |
| --- | --- | --- | --- |
| `analyze` | `project?`, `task?`, `since?` | collect terminal `TaskRecord`s, run `analyzeTasks`, reconcile the findings queue, write `runs/<ts>.json` | `{ version:1, analyzed:N, newFindings:[...], patterns:[...] }` |
| `list` | `kind?`, `scope?`, `status?` | current findings | `{ version:1, findings:[...] }` |
| `synthesize` | `since?` | cluster findings, draft proposed knowledge entries + agent notes, write `digest.md` | `{ version:1, digestPath, proposals:[...] }` |
| `promote` | `id`, `as?` (`entry` \| `task`) | append the redacted entry to the right knowledge file, or scaffold a low-risk factory task contract; mark the finding `promoted` | `{ version:1, promoted:"L-0007", wrote:"factory/knowledge/PROCESS_IMPROVEMENTS.md" }` |
| `dismiss` | `id`, `reason` | close a finding without action (recorded) | `{ version:1, dismissed:"L-0007" }` |
| `digest` | — | print the current founder digest markdown | `{ version:1, text }` |
| `research` | `topic` | **Phase 4.** bounded OpenClaw learning-agent pass, source-cited `ResearchNote` into `_learning/research/` | `{ version:1, note:{...} }` |

`package.json`: `"factory:learn": "node scripts/factory-learn.mjs"`.
Scheduling: founder adds `analyze --all` (per task or daily) and `synthesize`
(weekly) to OpenClaw cron or a systemd user timer. No daemon.

## 12. Phased delivery

Each phase is independently shippable and testable. `npm run test:factory` stays
green throughout; `npm run factory:smoke` still reaches `merge-ready`.

- **Phase 1 — Evidence & analysis core.** `evidence.mjs`, `analyze.mjs`,
  `fingerprint.mjs`, `redact.mjs`, `queue.mjs`, `learning-finding.schema.json`,
  `scripts/factory-learn.mjs` (`analyze` / `list` / `dismiss`), the three seeded
  knowledge files + `README.md`, `factory/prompts/learning-agent.md`, unit tests.
  *Outcome: `factory:learn analyze --all` produces a deduped, evidence-backed
  findings queue over real task history — zero model, zero network.*

- **Phase 2 — Synthesis, digest, promotion.** `knowledge.mjs`,
  `knowledge-entry.schema.json`, `synthesize` / `promote` / `digest` actions,
  the founder digest renderer. *Outcome: a weekly one-screen digest of proposed
  lessons and engineering / process improvements the founder promotes with one
  command.*

- **Phase 3 — Injection back to agents.** `factory/knowledge/agents/<role>.md`
  notes + the guarded, flag-gated knowledge block in `handoff.mjs` (or one line
  in the Intelligence Layer `assemble.mjs` if that shipped). *Outcome: the loop
  closes — future handoffs carry the lessons.*

- **Phase 4 — Model-assisted synthesis + external research.**
  `factory/prompts/learning-agent.md` promoted to an OpenClaw analyst, `research`
  action, `research-agenda.md`, optional narrative pass over Phase 2 clusters,
  `agentIds.learning` in config. *Outcome: "an employee attends a conference and
  brings knowledge back" — sourced, redacted, founder-promoted.*

## 13. Open decisions for the founder

Genuine strategic choices this proposal cannot make alone.

1. **Knowledge-file write path.** (a) The Learning Agent appends proposed entries
   to `factory/knowledge/*` on its own `learning/*` branch for a founder PR
   review (full git audit, needs a branch and a PR per synthesis run), or
   (b) proposals stay in `_learning/` runtime state and `promote` appends on the
   founder's local checkout for the founder to commit. *Recommendation: (b) for
   Phases 1–2; offer (a) in Phase 3.*

2. **The one engine-adjacent change.** Is the guarded, `try/catch`, flag-gated
   knowledge block in `factory/lib/handoff.mjs` (the markdown renderer, not the
   state machine) acceptable in Phase 3, or must `handoff.mjs` stay byte-for-byte
   unchanged — making knowledge injection depend entirely on the Intelligence
   Layer Context Pack landing first? *Recommendation: allow it; it is the same
   sanctioned seam, off by default, and cannot fail a dispatch.*

3. **Shared primitives with the Intelligence Layer.** Build `redact.mjs`, the
   finding fingerprint, and the memory-tier doc **once** under
   `factory/lib/common/` and have both systems import them? *Recommendation:
   yes.*

4. **External-research autonomy ceiling (Phase 4).** Confirm the Learning Agent
   may only produce read-only, source-cited notes and may **not** auto-create
   GitHub issues or factory tasks — every promotion stays founder-initiated.
   *Recommendation: confirm the ceiling as stated.*

5. **Retention.** How long are raw `_learning/runs/*` and un-promoted finding
   bodies kept before pruning to just the promoted, sanitised conclusions?
   *Recommendation: 90 days for run logs, indefinite for the findings queue
   index (titles + fingerprints + status), raw excerpts dropped on dismiss.*

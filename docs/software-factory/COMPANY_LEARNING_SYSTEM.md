# Company Learning System

The learning layer makes OpenClaw HQ improve after every task. It is the
feedback half of the factory: the Intelligence Layer tells an agent what it
needs to know *before* a task; the Learning System distils what the company
learned *after*. Design rationale and alternatives are in
[`COMPANY_LEARNING_SYSTEM_PROPOSAL.md`](COMPANY_LEARNING_SYSTEM_PROPOSAL.md);
the accepted decision is SFD-2026-006.

## The Learning / R&D Agent

A company-level role (`factory/prompts/learning-agent.md`), not assigned to any
project. It reads completed-task evidence and external knowledge, and returns
improvements. It is **read-only** over project repos and never starts, resumes,
routes, or completes a factory task. The workflow engine is untouched.

## What it does

| Responsibility | Where |
| --- | --- |
| Analyze failures — failed builds, rejected reviews, QA/security failures, retry burn, decision friction, repeated mistakes | `factory/lib/learning/analyze.mjs` over `state.json` evidence |
| Analyze successes — clean first-pass deliveries, fast cycles, known-good shapes | same |
| Improve other agents — prompts, roles, workflows, tools, evaluation criteria | `agent-improvement` findings → scaffolded low-risk factory task |
| Research external knowledge | `factory-learn.mjs research` → source-cited `ResearchNote` |
| Organizational memory | `factory/knowledge/` (global), project `context/` (project), `factory/knowledge/agents/<role>.md` (agent) |

## The adapter

`scripts/factory-learn.mjs` — JSON in / JSON out, same contract as
`scripts/openclaw-factory.mjs`. Also accepts `--flags`.

```bash
# 1. Analyze all terminal tasks and fill the findings queue
npm run factory:learn -- analyze

# 2. See what was found
npm run factory:learn -- list

# 3. Draft the founder digest + proposed knowledge entries (dry run)
npm run factory:learn -- synthesize

# 4. Open the learning/* branch + PR with those entries
npm run factory:learn -- synthesize --publish

# Promote or close one finding
npm run factory:learn -- promote --id L-0007          # entry PR, or a scaffolded task for prompt/gate changes
npm run factory:learn -- dismiss --id L-0007 --reason "already tracked in EI-2026-002"

# External research
npm run factory:learn -- research --topic "acceptance-test-first agent workflows"
```

| Action | Effect |
| --- | --- |
| `analyze` | Walk terminal `state.json` files, classify, reconcile the findings queue, write `_learning/runs/<ts>.json`. Deterministic, no model, no network. |
| `list` | Current findings (filter by `--kind`, `--scope`, `--status`, `--project`). |
| `synthesize` | Draft knowledge-file entries + the founder digest. Writes candidates to `_learning/proposals/`. Opens a `learning/*` branch + PR **only** with `--publish`. |
| `promote` | One finding → an entry PR (`--publish`), or a pre-filled low-risk factory task contract when a prompt / routing / gate must change. |
| `dismiss` | Close a finding with a recorded reason; raw excerpts are dropped, the index stays. |
| `prune` | Drop raw excerpts from open findings older than `--days` (default 90). |
| `research` | Bounded OpenClaw learning-agent pass → redacted, source-cited `ResearchNote` in `_learning/research/`. |

## Safety boundaries

- **Proposals, not edits.** The only repo writes are `learning/*` branches opened
  as PRs, and they are opt-in (`--publish`). Prompt / `factory.config.json` /
  `OPERATING_RULES.md` changes go through a normal low-risk factory task with
  independent review and human merge.
- **Redaction guard** (`factory/lib/common/redact.mjs`) runs on every fragment:
  secret filenames and values, path-escape, and reasoning-trace / transcript
  blocks are refused or scrubbed. A secret found where it should not be raises
  its own finding.
- **Never persisted anywhere:** secrets, credentials, bulk or raw private user
  data, model chain-of-thought, raw transcripts.
- Runtime state (`dashboard/backend/data/factory/_learning/`) is gitignored.

## Feedback loop

```
task reaches merge-ready / blocked
        │
        ▼
factory-learn analyze         (cron per task or daily)
        │
        ▼
findings queue  ──►  factory-learn synthesize   (weekly)
        │                     │
        │                     ▼
        │              founder digest + learning/* PR
        │                     │
        ▼                     ▼
factory-learn promote  ──►  factory/knowledge/*  (+ low-risk task for prompt/gate)
                              │
                              ▼
        buildKnowledgeBlock() appends accepted lessons to the next handoff
        (opt-in: FACTORY_LEARNING_IN_HANDOFF=1 or factory.config.json learning.injectIntoHandoff)
```

## Scheduling

No daemon. The founder adds `analyze` (per task or daily) and `synthesize --publish`
(weekly) to OpenClaw cron or a systemd user timer, the same way the
Intelligence-Layer sensors are scheduled.

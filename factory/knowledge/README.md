# Company Knowledge

Durable, company-wide learning for OpenClaw HQ. Maintained by the Learning / R&D
Agent (`factory/prompts/learning-agent.md`) and promoted by the founder.

## Files

| File | Holds |
| --- | --- |
| `LESSONS_LEARNED.md` | Narrative lessons from failures and successes across all projects. |
| `ENGINEERING_IMPROVEMENTS.md` | Concrete technical recommendations: architectures, testing, tooling, known-good shapes. |
| `PROCESS_IMPROVEMENTS.md` | Workflow, role, prompt, routing, and evaluation-criteria recommendations. |
| `research-agenda.md` | Standing external-research topics the founder wants tracked. |
| `agents/<role>.md` | Role-specific notes surfaced alongside `factory/prompts/<role>.md`. |

## How entries get here

1. `npm run factory:learn -- analyze --all` reads terminal task `state.json`
   files and fills the findings queue (`dashboard/backend/data/factory/_learning/`,
   gitignored).
2. `npm run factory:learn -- synthesize` drafts entries and opens a `learning/*`
   branch + PR. The founder reviews and merges.
3. `npm run factory:learn -- promote --id L-000N` promotes one finding: either an
   entry PR here, or a scaffolded low-risk factory task when a role prompt,
   routing rule, or gate must change (those changes get independent review, they
   are never applied by the Learning Agent).

## Memory tiers (SFD-2026-004, SFD-2026-006)

- **Global** — these files. Apply to every company the factory runs.
- **Project** — that project's own `context/MEMORY.md` / `context/DECISIONS.md`.
  The Learning Agent proposes scoped entries via that project's task PR.
- **Agent** — `agents/<role>.md` here.
- **Runtime** — `dashboard/backend/data/factory/_learning/` (gitignored): the
  findings queue, analysis runs, drafts, research notes.
- **Never persisted anywhere** — secrets, credentials, bulk or raw private user
  data, model chain-of-thought, raw transcripts. The redaction guard
  (`factory/lib/common/redact.mjs`) enforces this on every fragment.

## Entry format

```
## LL-2026-001 — Short title

- Date: 2026-09-03
- Scope: global | project:<key> | agent:<role>
- Source findings: L-0007
- Confidence: low | medium | high
- Evidence tasks: issue-42, issue-51
- Status: proposed | accepted

**Observation:** what the evidence shows.

**Recommendation:** what to change.
```

`Status: proposed` on a fresh PR; set to `accepted` on merge. Only `accepted`
entries are surfaced back into handoffs (Phase 3, opt-in).

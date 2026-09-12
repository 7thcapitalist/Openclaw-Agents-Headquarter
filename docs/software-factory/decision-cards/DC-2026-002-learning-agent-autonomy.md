# Decision Required

> **Resolved 2026-09-07 — Option A accepted by the founder**, then overtaken by
> events and REOPENED. The implementing branch `factory/learning-mastery-cycle`
> never opened a PR and never merged, so its `DECISIONS.md` entry never landed
> and the number SFD-2026-008 was reassigned on 2026-09-08 to "Repository is
> main-only; every change lands via a PR".
>
> That later decision, together with SFD-2026-003 (V1 human-merge mode),
> prohibits exactly the autonomous merge this card authorized. Both were
> accepted *after* this card, so they govern.
>
> The capability was recovered and merged on 2026-09-10 in an inert state:
> `learning.autonomy.enabled: false`, no systemd timer installed, and the
> decision re-recorded as SFD-2026-011 with status **Proposed**. The retrospective
> and mastery passes can be run by hand at any time; nothing merges on its own.
>
> **Founder decision still required:** re-affirm Option A (and consciously
> supersede SFD-2026-003 / SFD-2026-008 for the `knowledge-append` class), or
> confirm proposal-only and drop the auto-merge clause.

## Decision
Whether to let the Learning / R&D Agent **implement** a narrow, founder-defined
class of improvements on its own after each analysis cycle — superseding the
"proposals, not edits" rule in `SFD-2026-006` for that class only — or keep it
strictly proposal-only and just add the 3-day cadence and richer analysis.

## Why this needs the founder
`SFD-2026-006` and `factory/prompts/learning-agent.md` both hard-constrain this
agent to *recommend*, never *act*. Giving any agent standing authority to change
committed factory files (prompts, knowledge, skills) without a per-change human
merge is an autonomy-posture change and is explicitly a Decision Card per
`AGENTS.md` and the agent's own prompt.

## Background
Today the Learning Agent is unscheduled (it has run twice, ever), has no task
history to analyze (nothing has completed through `scripts/openclaw-factory.mjs`),
and is proposal-only. The founder wants it to:
1. run **every 3 days**;
2. analyze everything the other agents did — factory throughput, per-stage
   speed, retry burn, first-pass rate, result quality, and what to improve;
3. **proactively make each agent better even when nothing is wrong** — every
   cycle, study a role's craft (e.g. the backend builder), research how that
   job is done well, and propose concrete upgrades so the agents become
   masters of their roles over time. This pass is *not* conditional on a
   failure being found;
4. do **allowlisted** web research (domain allowlist + per-run call budget)
   into OpenClaw usage, autonomous-agent practice, and concrete code/prompt
   improvements, as source-cited notes — driven by both the analysis in (2)
   and the mastery pass in (3);
5. after founder approval, **actually implement** the enhancement.

Founder pre-answers (2026-09-06):
- Implement scope: **auto-merge a safe class** (prompt wording, `factory/knowledge/*`,
  skill files) after approval; engine / `factory.config.json` / gate / risk
  changes stay PR-you-merge.
- Approval model: **standing approval for a founder-set whitelist**; anything
  outside it waits for an explicit decision.
- Web research: **allowlist + per-run budget**, source-cited, read-only.

## Option A — Adopt the conditional-autonomy operating model (recommended)
Add a `cycle` action on a 3-day schedule with two passes, governed by
`factory.config.json → learning.autonomy`:

- **Retrospective pass** — the metrics + failure/success analysis over recent
  terminal task states (Option B content).
- **Mastery pass (always runs)** — a light craft review of every role plus one
  rotating **deep-dive role** per cycle (round-robin: product → architect →
  backend-builder → frontend-builder → reviewer → qa → security → release, a
  full loop every ~24 days). The deep-dive gets the research budget: study that
  role's recent dispatches, research how the craft is done well, and produce
  concrete upgrades — prompt edits, a new skill, a checklist item, sharper
  evidence requirements, a routing/tool tweak. Each cycle appends a dated
  **Mastery log** entry to `factory/knowledge/agents/<role>.md` (what was
  learned, what changed, what's next), so each agent accrues a visible
  competence history. A standing per-role agenda in
  `factory/knowledge/agents/<role>.agenda.md` lists craft areas still to work
  through.

Both passes feed the same synthesize → implement path below:

- `enabled` (master kill switch; `false` = revert to proposal-only instantly).
- `whitelist` — the only categories that may proceed without a per-run click.
  Proposed default: (a) wording/clarity edits to `factory/prompts/*.md` and
  `factory/knowledge/agents/*.md`; (b) appended entries in `factory/knowledge/*.md`;
  (c) new skill files under the skills dir.
- Everything else — `factory/factory.config.json` routing/gates/risk,
  `OPERATING_RULES.md`, `AGENTS.md`, `run.sh`, any project repo, branch
  protection, spend, `DECISIONS.md` — is **never** whitelistable; it becomes a
  PR the founder merges, or a Decision Card.
- "Auto-merge" still means the change opens a branch + PR and runs the **full
  factory pipeline** (independent review + QA + security). A bot merges **only
  if every gate passes**. No gate is skipped.
- Caps: `maxAutoMergesPerRun` (default 2); a run that would exceed it stops and
  escalates the remainder.
- Audit: every autonomous change is linked `finding-id → proposal → PR → merge
  SHA` in `digest.md` and a new `_learning/autonomy-log.jsonl`; the founder gets
  a diff summary after each run. Each merge is one squashed commit →
  `git revert <sha>` undoes it.
- Research: `learning.autonomy.research.allowlist` + `maxCallsPerRun` (default
  10); `ResearchNote` only, redacted, never posted anywhere. The mastery pass
  spends this budget every cycle even when the retrospective pass is clean —
  "no problems found" is not a reason to skip improvement.
- Mastery: `learning.autonomy.mastery` — `{ rotation: [role order],
  dossierDir: "factory/knowledge/agents", deepDiveRolesPerCycle: 1 }`.

- Benefit: the improvement loop actually closes on a cadence; low-risk, high-
  volume polish (prompt clarity, banked lessons, new skills) lands without
  founder toil; risky changes still get full human review; instantly
  reversible by flag or `git revert`.
- Cost/risk: a whitelisted bad edit can merge before the founder sees it
  (bounded by: pipeline gates must pass, ≤2/run, full audit log, revert). The
  whitelist must be kept conservative. Web egress every 3 days (allowlisted).

## Option B — Cadence + analysis + mastery, still proposal-only
Add the 3-day schedule, the performance-metrics analysis, the always-on mastery
pass, and the allowlisted research, but keep `SFD-2026-006` intact: every change
(including every mastery upgrade) stays a proposal the founder promotes/merges.

- Benefit: no autonomy-posture change; zero risk of an unreviewed merge.
- Cost/risk: the loop still needs founder action on every cycle to produce any
  change; the "measurably better month over month" goal stays gated on founder
  attention, which is the thing that has kept this agent idle.

## Recommendation
**A**, with the conservative default whitelist above and `maxAutoMergesPerRun: 2`.
It is what the founder asked for, the blast radius is contained (pipeline gates
unchanged, tiny file class, capped, audited, one-command revert), and B leaves
the same attention bottleneck that has kept the agent dormant.

## Default if no decision
**B.** Build the schedule + metrics + mastery pass + research now; leave
`learning.autonomy.enabled: false` so nothing merges autonomously until this card
is answered. The mastery pass still runs every cycle and files proposals — the
flag only gates auto-merge, not the improvement work itself. Nothing else pauses.

## Reply format
`A`, `A with changes to the whitelist/caps`, `B`, or `discuss`.

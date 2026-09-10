# Paperclip Native Capability Expansion

> **Closed.** The final source-level comparison of the pinned Paperclip tree
> against HQ is `docs/software-factory/PAPERCLIP_FINAL_COMPARISON.md`. It records
> what was adopted, what was excluded and why, what still needs a founder
> Decision Card, and the four remaining capabilities worth their own issues.

- Authorization: explicit founder direction on 2026-09-09
- Upstream source: `paperclipai/paperclip` at
  `6abeb67334348dcb6fde2d591a27ffc7efc7118d` (MIT)
- Shared base: `8bc1862b0a400880b1a067fa348285515c567e7f`
- Integration owner: Codex
- Target: `main`, one short-lived branch/worktree and PR per capability
- Expiry: issues #116–#126 merged, cancelled, or superseded by a founder decision
- Topology: native HQ capabilities; no live Paperclip service or authority migration

## Why these capabilities

Paperclip contains several strong company-operations concepts that complement
HQ's GitHub-centric factory. The expansion ports the concepts that reduce
operator attention, duplicate work, hidden cost, and ambiguous ownership. It
does not import Paperclip's PostgreSQL/PGlite stack, web application, generic
issue authority, authentication system, or deployment topology.

## Ordered PR train

| Order | Issue | Capability | Upstream reference | Dependencies |
| --- | --- | --- | --- | --- |
| 1 | #116 | Hierarchical goals and progress rollups | `services/goals.ts`, runner goals | Activation telemetry/API |
| 2 | #117 | Dependency wakeups and graph diagnostics | dependency wakeups, graph liveness | #106, #116 |
| 3 | #118 | Budget policies and alerts | `services/budgets.ts` | #105, #116 |
| 4 | #119 | Scoped agent permissions | `services/agent-permissions.ts` | #116–#118 |
| 5 | #120 | Durable approval/decision history | approvals, issue approvals, retention | #119 |
| 6 | #121 | Comments, mentions, and interaction wakeups | issue thread interactions, queued comments | #117, #119 |
| 7 | #122 | Unified run timeline and evidence UI | activity, issue liveness, telemetry routes | #105, #107, #108, #121 |
| 8 | #123 | Outcome-based agent scorecards | runtime metrics, project metrics | #118, #122 |
| 9 | #124 | Company package import preview/diff | Agent Companies specification | #97, #98, #119 |
| 10 | #125 | Connector outbox and reconciliation | execution reconciliation, change receipts | #119–#121 |
| 11 | #126 | Retention, backup health, recovery checks | decision retention, backup health | #105, #120, #125 |

Every PR declares its exact predecessors. Later PRs may be prepared before
predecessors merge only through explicit interfaces or as dependency-blocked
drafts; predecessor code is not copied silently. Immediately before founder
merge, refresh from current `main` and rerun focused, provenance, and applicable
factory checks.

## Capability contracts

### 1. Goals

Add stable company/project/objective goal nodes and parent relationships.
Progress is derived from canonical objective/task state, never edited as a
competing status. Reject cycles and cross-project references. Show rollups and
stalled/blocked descendants in the dashboard.

### 2. Dependency automation

When a canonical dependency becomes satisfied, enqueue one idempotent wakeup.
Diagnose orphan references, impossible cycles, stale active nodes, and blocked
subtrees. Never create a branch or run directly from a dependency event.

### 3. Budgets

Support company, project, and agent visibility thresholds using the normalized
ledger. Report consumption, forecast, threshold crossings, missing pricing,
and stale data. Initial enforcement is alert-only. A hard stop requires a
separate founder Decision Card and fault-injection proof.

### 4. Permissions

Define explicit capabilities and scopes for local mutation entrypoints. Founder
authority and existing signed approvals remain superior. Denials are audited;
read-only projections remain broadly available to the authenticated dashboard.

### 5. Approval history

Record requested, approved, rejected, expired, consumed, and revoked events
with actor and decision correlation. Existing cryptographic approval remains
the authorization gate; this is history and projection, not a second approval.

### 6. Interactions

Add structured comments and mentions to canonical task context, with redaction,
bounded size, attribution, idempotency, and mention/dependency wakeups. External
text remains untrusted data and cannot carry commands.

### 7. Run detail

Build one timeline from workflow state, audit, liveness, interactions, retries,
evidence references, and cost. Exclude raw prompts/private conversations and
show unavailable/degraded sources honestly.

### 8. Scorecards

Measure accepted outcomes, gate failures, recovery frequency, review findings,
latency, and cost per accepted outcome. Always expose sample size and data
quality. Never use activity count or cheapness alone as a performance score.

### 9. Import preview

Lint and parse a package into an inert proposed diff against projects, agents,
roles, and skills. No file or registry mutation occurs in preview. Application
of a proposal is future work requiring normal scoped PRs and approvals.

### 10. Connector reliability

Add a local append-only outbox, idempotency keys, replay detection, retry and
dead-letter bounds, cursors, circuit state, and read-only drift reports. No
network endpoint is enabled. A live Paperclip companion remains subject to the
existing Decision Card requirement.

### 11. Retention and backup health

Add allow-listed retention classes for private projections, dry-run pruning,
backup freshness/hash reporting, and recovery verification. Default operations
are non-destructive. Actual deletion or backup destination configuration is an
operator action outside Git.

## Cross-cutting acceptance

- GitHub remains durable authority for software work and `main` stays human-merge.
- OpenClaw remains the orchestrator; registered agent execution remains `./run.sh`.
- All adapted/inspired artifacts are recorded in the provenance manifest.
- Runtime data, secrets, prompts, credentials, and personal content stay out of Git.
- Every mutation is scoped, attributable, idempotent where replayable, and tested.
- Every projection has explicit empty, unavailable, malformed, and recovery behavior.
- Each PR includes focused tests, documentation, rollback, and unresolved risks.

## Deferred by design

The campaign does not adopt Paperclip as the primary control plane, run its
database/UI, enable a live connector, enforce hard budget stops, auto-merge,
auto-deploy, or ingest private Paperclip/OpenClaw data. Each changes strategic,
privacy, spend, or production authority and therefore needs separate founder
approval after the native campaign produces operational evidence.

# Paperclip Integration Plan for OpenClaw Startup HQ

Status: Proposed

## Executive recommendation

Paperclip is highly relevant to OpenClaw Startup HQ, but it should not be merged
wholesale into the current codebase. Both systems are control planes. Allowing
both to own tasks, approvals, agent lifecycle, worktrees, or workflow state would
create split-brain behavior and weaken the HQ's strongest guarantees: GitHub as
the durable software-work record, one writer per ephemeral branch/worktree,
independent review and QA, signed high-risk approval, human-only merge, and the
constrained `./run.sh` execution boundary.

The recommended strategy is:

1. **Adopt Paperclip's proven concepts and protocols selectively.** Add atomic
   task leases, heartbeat/wakeup semantics, richer run/cost events, an explicit
   org model, and portable company-package import/export to the existing HQ.
2. **Build a read-mostly Paperclip bridge.** Let Paperclip display HQ agents,
   goals, activity, and costs without becoming authoritative for software task
   state or execution.
3. **Pilot one-way delegated work.** A Paperclip issue may request a bounded HQ
   objective; the HQ creates the GitHub issue and owns the complete factory run.
   HQ status is mirrored back to Paperclip with idempotency and reconciliation.
4. **Defer control-plane replacement.** Only after a measured pilot should the
   founder choose whether Paperclip becomes the portfolio/agent control plane,
   remains an optional companion, or contributes only ideas and code patterns.

The immediate target is therefore a **federated architecture**:

```text
Founder
  |
  +-- HQ Today / Founder Inbox -------- operator authority
  |
  +-- GitHub --------------------------- canonical software task + PR record
  |
  +-- OpenClaw ------------------------- execution/orchestration runtime
  |      |
  |      +-- factory protocol ---------- deterministic staged delivery
  |      +-- ./run.sh workers ---------- constrained non-factory execution
  |
  +-- optional Paperclip companion ----- org, goals, heartbeat, cost visibility
         |
         +-- HQ bridge ----------------- IDs, events, commands, reconciliation
```

Paperclip is MIT-licensed, so code can legally be reused with the copyright and
license notice preserved. Reuse should still favor small, attributed ports or
protocol compatibility over copying a fast-moving monorepo into this small
Node/Express/SQLite system.[^1]

## Research basis and scope

This assessment compares the current HQ architecture at `origin/main` with
Paperclip commit `6abeb67334348dcb6fde2d591a27ffc7efc7118d`, inspected on
2026-09-09. Paperclip describes itself as a control plane for teams of agents,
with goals, task coordination, budgets, governance, auditability, training, and
multiple execution adapters.[^2] Its current stack is React, Express,
PostgreSQL/PGlite, Drizzle, Better Auth, and adapter packages for agent
runtimes.[^3]

This is an integration design, not approval to install Paperclip, migrate data,
expose a new service, change authentication, or alter the factory's durable
authority. Those actions carry security, privacy, operational, and possibly
product-direction consequences and are isolated behind decision gates below.

## 1. Product and architecture fit

### 1.1 The systems share the same product thesis

Both products aim to make a group of agents understandable and governable as an
organization rather than a collection of scripts. The overlap is unusually
strong:

| Capability | OpenClaw Startup HQ today | Paperclip today | Assessment |
| --- | --- | --- | --- |
| Operator dashboard | Today view, projects, agents, tasks, reports, founder inbox | Board UI for companies, org, issues, approvals, runs, costs | Strong overlap |
| Runtime | OpenClaw is the orchestrator; worker folders expose `./run.sh` | External runtimes reached through adapters; OpenClaw Gateway is first-party | Complementary if HQ stays authoritative |
| Software task record | GitHub issue → branch → PR → review → QA → human merge | Paperclip issue, comments, documents, artifacts, workspace | Direct authority conflict |
| Workflow | Deterministic factory stages and gates | Issue lifecycle, heartbeats, approvals, routines/pipelines | Partial overlap; HQ is stricter for software delivery |
| Concurrency | One primary owner; isolated worktree; dispatch reservation | Atomic single-assignee checkout and execution workspaces | Concepts combine well |
| Agent model | Registry plus conceptual/runnable lifecycle and role routing | Employees, org chart, reporting lines, capabilities, adapters | Paperclip model is richer |
| Human control | Decision Cards, signed high-risk approvals, human merge | Board approvals, pause/resume/terminate, strategy/hire approval | Complementary, but semantics differ |
| Cost controls | Provider usage and plan-limit projections | Per-company/agent/project cost events, soft warnings, hard auto-pause | Paperclip is more mature |
| Context | Repository project context + deterministic handoff packs | Goal ancestry + issue context + runtime skill injection | Complementary |
| Audit | Factory state, evidence, GitHub, activity projections | Actor-attributed activity log and run events | Paperclip pattern is richer |
| Portability | JSON registries, templates, agent folders | Markdown-first Agent Companies spec with optional vendor config | Paperclip spec is reusable |
| Multi-company isolation | Project registry; private single-operator deployment | Company-scoped entities and multi-organization deployment | Only needed if HQ becomes multi-tenant |

### 1.2 The central conflict: two control planes

Paperclip explicitly positions itself as the command, communication, and
control plane. Its agent heartbeat checks assignments, atomically checks out an
issue, reads context, performs work, updates status, and delegates child
issues.[^4] HQ's factory already owns intake, task state, dispatch reservation,
stage progression, recovery, evidence verification, worktree creation, review,
QA, security, and release recommendation.

If connected naively, one unit of work could have:

- a Paperclip issue status and an HQ factory status;
- a Paperclip checkout owner and an HQ dispatch owner;
- a Paperclip execution workspace and an HQ Git worktree;
- a Paperclip approval and an HQ Decision Card or signed assertion;
- a Paperclip agent pause and an OpenClaw/HQ lifecycle state;
- Paperclip task comments, HQ state/evidence, and GitHub comments that disagree.

The integration must assign exactly one authority per domain and treat every
other representation as a projection.

### 1.3 Recommended authority matrix

| Domain | Authority during Phases 0–5 | Projection / consumer |
| --- | --- | --- |
| Founder identity and final merge | Human founder | HQ, GitHub, Paperclip |
| Software objective and delivery | GitHub + HQ factory state | Paperclip issue mirror |
| Branch/worktree ownership | HQ factory | Paperclip read-only workspace link |
| Stage routing/recovery/gates | HQ factory config and state machine | Paperclip activity/status cards |
| Agent execution | OpenClaw through existing HQ boundary | Paperclip receives run telemetry |
| High-risk approval | HQ signed assertion | Paperclip approval mirror, never an unlock token |
| Normal task decisions | HQ Decision Card | Optional mirrored interaction |
| General company goals/org chart | HQ repository context initially | Paperclip mirror; ownership reconsidered later |
| Cost ledger | HQ append-only normalized cost events | Both dashboards aggregate the same events |
| Credentials/private runtime state | Private host stores | Never synchronized as payload data |
| Software completion | Merged GitHub PR | HQ and Paperclip derive status |

This matrix preserves the project's current machine-readable configuration. A
change of authority requires an accepted entry in `DECISIONS.md`, migration and
rollback plans, and a founder-approved Decision Card.

## 2. What to reuse from Paperclip

### 2.1 Reuse now: architecture and protocol patterns

#### Atomic task leases

Paperclip requires an agent to check out a task and returns a conflict if
another agent owns it.[^4] HQ already reserves dispatches and prevents shared
writable branches, but a generic lease primitive would cover non-factory
workers, scheduled jobs, and bridge deliveries consistently.

Port the behavior, not necessarily the database code:

- stable `leaseId`, `taskId`, `actorId`, `runId`, `acquiredAt`, `expiresAt`;
- compare-and-set acquisition;
- idempotent reacquisition by the same run;
- explicit release and board-only force release;
- heartbeat renewal with a bounded TTL;
- immutable acquisition/conflict/release audit events;
- never retry a genuine ownership conflict automatically.

#### Wakeup and heartbeat protocol

Paperclip separates persistent issue status from run liveness and records
outcomes such as completed, advanced, blocked, failed, plan-only, and empty
response.[^4] HQ can use the same distinction to improve overnight recovery:
task state remains durable while wakeups describe why an agent should run.

Adopt a normalized wakeup envelope:

```json
{
  "version": 1,
  "wakeupId": "uuid",
  "source": "schedule|assignment|mention|dependency|recovery|manual",
  "taskRef": "hq-task-or-agent-run-id",
  "actorId": "openclaw-agent-id",
  "idempotencyKey": "stable-key",
  "notBefore": "ISO-8601",
  "attempt": 1,
  "contextRef": "path-or-opaque-reference"
}
```

Do not make every HQ role poll a Paperclip inbox. OpenClaw remains the dispatcher;
the envelope standardizes triggers and audit records.

#### Run event and cost ledger

Paperclip records provider, model, input/output tokens, cost, agent, issue, and
time, then aggregates by company, agent, and project. It warns at a threshold
and pauses at a hard limit.[^5] HQ should adopt an append-only normalized ledger
with stable source-event IDs and explicit estimation status.

Add fields needed by this factory:

- objective, task, stage, dispatch, recovery chain, and PR identifiers;
- provider-reported versus estimated cost;
- cache/reasoning token fields where available;
- model policy route and plan/seat attribution;
- currency and pricing-table version;
- accepted, duplicate, corrected, or reversed event state.

Start with visibility and alerts. Hard budget stops can strand worktrees and
must be integrated with the factory's safe pause/checkpoint behavior before
enforcement is enabled.

#### Actor-attributed audit events

Paperclip's model attributes mutations to board users, agents, or runs. HQ
should standardize its existing activity into an append-only envelope:

```json
{
  "eventId": "uuid",
  "occurredAt": "ISO-8601",
  "actor": { "type": "human|agent|system", "id": "..." },
  "action": "task.stage.completed",
  "subject": { "type": "task", "id": "..." },
  "correlation": { "objectiveId": "...", "dispatchId": "...", "pr": 123 },
  "data": {},
  "schemaVersion": 1
}
```

Sensitive values must be redacted before persistence. Audit payloads should
contain references or hashes for evidence, never secrets or raw private agent
memory.

#### Agent Companies package compatibility

Paperclip's draft Agent Companies specification uses Git- and Markdown-native
`COMPANY.md`, `TEAM.md`, `AGENTS.md`, `PROJECT.md`, `TASK.md`, and `SKILL.md`
packages. It explicitly treats Markdown as canonical, registries as optional,
immutable refs as preferable, and license/attribution preservation as
mandatory.[^6] This closely matches HQ's repository-memory philosophy.

Implement an importer/exporter rather than replacing current files:

- map HQ project context to `PROJECT.md` and company metadata;
- map `factory/agents.json` plus role prompts to agent/team package views;
- map agent folders without exporting absolute paths or runtime secrets;
- preserve source URL, commit SHA, license, attribution, and vendored/reference
  mode;
- generate a lock file for resolved external refs;
- require a reviewable diff before import writes repository files;
- never import `SOUL.md`, private memory, tokens, or machine-specific config.

#### OpenClaw Gateway test patterns

Paperclip has a first-party WebSocket OpenClaw Gateway adapter. It supports
challenge/response connection, bearer/shared authentication, signed device
identity, pairing, stable issue/run/fixed session keys, idempotent run IDs, wait
timeouts, and structured event streaming.[^7] Its onboarding checklist tests
task completion, comments, outbound messaging, and behavior across a new
OpenClaw session.[^8]

Reuse these as interoperability tests. Do **not** copy tokens or private keys
into repository config, and do not bypass HQ's `./run.sh` boundary for registered
workers. For the factory, any gateway invocation must still enter through
`scripts/openclaw-factory.mjs` or a narrowly scoped adapter around it.

### 2.2 Reuse later: product capabilities

#### Org chart and delegation

Add explicit reporting lines, capabilities, availability, runtime adapter, and
budget policy to the HQ agent registry. Treat the org chart as routing advice,
not an access-control substitute. Authorization must be enforced centrally and
cannot be inferred only from `reportsTo`.

#### Approval inbox UX

Paperclip supports pending, approved, rejected, revision-requested, and
resubmitted approval states, with linked issues and operator overrides.[^9]
HQ can improve its Founder Inbox with revision cycles and linked evidence while
retaining its narrower escalation policy and signed high-risk gate.

#### Run viewer and durable conversations

Paperclip's streaming adapter events and run records are useful references for
an HQ run detail page. Store structured events, render redacted summaries, and
link to evidence and GitHub. Avoid turning model transcripts into canonical
project memory.

#### Skills, evaluation, and performance review

Paperclip's current product direction includes shared skills, evals, saved test
runs, active learning, and quality metrics.[^2] HQ's learning system can ingest
verification outcomes and recurring findings into scorecards, but agents must
not autonomously promote learned behavior into policy.

### 2.3 Do not reuse without a separate decision

- **The complete React/Express/Postgres application.** It would create a second
  product and operational stack beside the existing dashboard.
- **Paperclip issues as the software source of truth.** Current policy assigns
  that role to GitHub.
- **Paperclip-managed workspaces for factory coding.** HQ already enforces the
  required ephemeral branch/worktree lifecycle.
- **Automatic agent termination.** Termination can be irreversible; prefer
  pause, checkpoint, and operator review.
- **Board approval as a substitute for signed high-risk approval.** A database
  flag is not equivalent to a signature created by a key unavailable to the
  orchestrator.
- **Company-wide task visibility as authorization.** Visibility, routing, and
  permission are different concerns.
- **Hosted or public exposure.** The HQ is designed for private-network access;
  new exposure requires explicit threat modeling and founder approval.
- **Inline secrets in adapter configuration.** Use references to a private
  secret store and audit access, never repository values or routine API output.

## 3. Target integration architecture

### 3.1 Anti-corruption layer

Create `factory/lib/integrations/paperclip/` as a protocol boundary. No core
factory module should import Paperclip-specific HTTP shapes directly.

```text
factory/lib/integrations/paperclip/
  client.mjs             authenticated, timeout-bounded HTTP client
  config.mjs             disabled-by-default config + validation
  ids.mjs                external-ID mappings and correlation keys
  map-inbound.mjs        Paperclip issue -> bounded HQ objective request
  map-outbound.mjs       HQ projection -> Paperclip update
  policy.mjs             allowed commands and field-level redaction
  reconcile.mjs          drift detection, no blind last-write-wins
  signatures.mjs         webhook verification and replay defense
  store.mjs              cursors, idempotency keys, dead letters
  telemetry.mjs          sanitized bridge metrics
```

The bridge should expose a versioned internal interface:

```js
export function ingestExternalCommand(envelope)
export function projectCompanyState(companyState)
export function publishFactoryEvent(event)
export function reconcileExternalState(snapshot)
```

Paperclip-specific IDs remain aliases. HQ task IDs, GitHub issue/PR identifiers,
and OpenClaw agent IDs are never replaced by foreign database UUIDs.

### 3.2 Data flow

```text
Paperclip issue created/assigned
  -> signed webhook or cursor poll
  -> verify, deduplicate, policy-check
  -> create bounded HQ objective
  -> HQ creates/links GitHub issue
  -> factory owns worktree, stages, recovery, evidence and PR
  -> normalized HQ events enter outbox
  -> bridge mirrors summary/status/links to Paperclip
  -> reconciliation detects drift and opens an operator-visible incident
```

Inbound commands initially allow only:

- request a new low/medium-risk objective;
- request wakeup of an allowlisted non-factory worker;
- add a non-authoritative comment/reference;
- request pause, which enters HQ's safe-pause path.

Inbound commands must never directly merge, deploy, delete data, rotate secrets,
approve high-risk work, mutate factory policy, choose a worktree, or execute an
arbitrary command.

### 3.3 Transaction and delivery model

Use at-least-once delivery with idempotent consumers:

- every inbound event has source, source event ID, schema version, issued time,
  signature metadata, and payload hash;
- accepted commands persist before acknowledgment;
- state changes and outbound events use a transactional outbox where the local
  store supports it;
- retries use bounded exponential backoff with jitter;
- poison events enter a dead-letter queue visible in Today;
- reconciliation compares versioned snapshots and never overwrites a newer
  authoritative state;
- clocks are informative only; monotonic versions/idempotency keys decide
  ordering;
- replay of an already completed command returns the stored result.

### 3.4 Identity and authentication

Use separate identities for:

- Paperclip board/operator;
- Paperclip service-to-HQ bridge;
- each Paperclip/OpenClaw agent;
- each HQ dispatch/run;
- the human founder approval signer.

Minimum controls:

- loopback/private-network binding by default;
- TLS for any non-loopback hop;
- scoped, rotatable credentials stored outside Git;
- hashed API keys at rest where possible;
- short-lived run tokens instead of broad persistent agent keys;
- signature verification, timestamp window, nonce/replay cache for webhooks;
- explicit company/project/agent allowlists;
- no credential in query strings, logs, evidence, screenshots, or task text;
- security events for failed auth, replay, scope denial, and secret access;
- emergency bridge disable switch that leaves core HQ operation intact.

### 3.5 Availability and failure isolation

Paperclip must be optional. If it is offline:

- HQ intake, OpenClaw dispatch, factory progression, GitHub delivery, approvals,
  and dashboard operation continue;
- outbound projections queue within a bounded retention limit;
- Today shows connector health and last successful synchronization;
- no factory stage waits synchronously for a Paperclip update;
- reconnect triggers reconciliation before new commands are accepted.

## 4. Data mapping

| HQ concept | Paperclip concept | Direction | Notes |
| --- | --- | --- | --- |
| Portfolio / HQ | Company | HQ → Paperclip initially | One private company for the pilot |
| Project registry entry | Project | HQ → Paperclip | Slug is portable identity; preserve repo URL/ref |
| Mission/vision/roadmap | Goal hierarchy | HQ → Paperclip | Repository docs remain canonical |
| Agent registry entry | Agent/employee | HQ → Paperclip | Map role, capabilities, reporting line, lifecycle |
| OpenClaw agent ID | Adapter config reference | HQ → Paperclip | Never export gateway secrets |
| Founder objective | Parent issue/goal | Paperclip → HQ request | Accepted request creates HQ/GitHub identity |
| Factory task | Issue | HQ → Paperclip mirror | Include canonical GitHub and state references |
| Pipeline stage | Status card/activity | HQ → Paperclip | Do not force seven stages into issue status |
| Dispatch | Heartbeat run | HQ → Paperclip | Share correlation and outcome, not raw secrets |
| Decision Card | Approval/interaction | Bidirectional projection | HQ is authoritative; signed gate stays local |
| Evidence file | Document/attachment link | HQ → Paperclip | Link or sanitized copy; hash and provenance |
| Cost event | Cost event | Bidirectional ingestion | Deduplicate by source event ID |
| PR and review | Work product/link/comment | GitHub/HQ → Paperclip | GitHub remains durable delivery record |
| Agent pause | Agent status | Controlled bidirectional | Safe checkpoint before enforcement |

## 5. Phased implementation roadmap

Each item below should be its own short-lived branch and PR from the latest
`main`. Independent items must not be accumulated on a shared integration
branch. Every PR needs appropriate tests/evidence, independent review, QA, and
human merge.

### Phase 0 — Decision-quality spike (1–2 weeks)

Goal: validate compatibility without running Paperclip against real HQ data.

1. **PC-001 — Record the integration architecture decision.** Add an accepted
   decision only after founder approval: companion bridge, concept-only reuse,
   or future replacement evaluation.
2. **PC-002 — Create a threat model.** Cover service exposure, credentials,
   webhook spoofing/replay, agent impersonation, confused-deputy risks, prompt
   injection through task text, cross-company leakage, attachment handling,
   and denial-of-wallet.
3. **PC-003 — Build a disposable lab.** Pin Paperclip by commit or release in a
   separate checkout/container; use synthetic company/agent/task data and no
   production credentials.
4. **PC-004 — Run OpenClaw interoperability smoke tests.** Adapt Paperclip's
   onboarding cases: connect/pair, assigned task, comment, outbound message,
   new session, timeout, duplicate wakeup, and revoked credential.
5. **PC-005 — Produce a schema crosswalk fixture.** Checked-in sanitized JSON
   examples for company, project, agent, task, run, approval, cost event, and
   audit event.
6. **PC-006 — Benchmark footprint.** Measure idle/active CPU, memory, disk,
   database growth, startup/recovery time, and mini-PC impact.
7. **PC-007 — License/provenance inventory.** Record the pinned Paperclip SHA,
   MIT notice, files considered for porting, and transitive asset licenses.

Exit gate:

- no real secrets or personal data used;
- threat model reviewed independently;
- connector modes and authority matrix accepted;
- measured mini-PC resource budget exists;
- founder chooses whether to proceed to Phase 1.

### Phase 1 — Native HQ foundations inspired by Paperclip (2–4 weeks)

Goal: capture high-value capabilities without a runtime dependency.

8. **PC-101 — Normalized actor IDs.** Add human/agent/system actor types and
   correlation IDs to new events while preserving compatibility.
9. **PC-102 — Append-only audit envelope.** Centralize sanitized event writes,
   schema validation, and event versioning.
10. **PC-103 — Generic task lease primitive.** Implement compare-and-set,
    renewal, expiration, idempotent reacquisition, and force-release audit.
11. **PC-104 — Wakeup request schema and queue.** Support schedule, assignment,
    mention, dependency, recovery, and manual reasons.
12. **PC-105 — Run-liveness taxonomy.** Separate durable task stage from latest
    execution outcome and bounded continuation attempts.
13. **PC-106 — Cost-event ledger.** Append-only normalized usage/cost ingestion
    with provider/estimated flags and deduplication.
14. **PC-107 — Budget visibility.** Company/project/agent/task/stage rollups,
    alert thresholds, and forecasting; no hard enforcement yet.
15. **PC-108 — Agent registry v2 proposal.** Add reporting line, capabilities,
    adapter reference, lifecycle authority, and budget policy through a
    backward-compatible schema migration.
16. **PC-109 — Today audit/cost views.** Show summaries and drill-down links,
    with responsive and visual QA.

Exit gate:

- existing factory and dashboard tests remain green;
- event replay produces deterministic projections;
- lease race tests prove only one owner;
- cost duplicates do not double count;
- no change to GitHub, human-merge, signature, or `./run.sh` invariants.

### Phase 2 — Portable company packages (2–3 weeks)

Goal: make HQ roles and context portable without exposing runtime state.

17. **PC-201 — Package mapping specification.** Define lossless/lossy mappings
    between HQ context/registries and Agent Companies files.
18. **PC-202 — Read-only package linter.** Validate paths, slugs, refs, hashes,
    license metadata, forbidden private files, and secret-like content.
19. **PC-203 — HQ exporter.** Generate a sanitized package into a temporary
    directory and manifest every omission/transformation.
20. **PC-204 — Dry-run importer.** Resolve pinned sources and produce a diff,
    conflicts, warnings, and planned writes without mutation.
21. **PC-205 — Transactional importer.** Apply an approved import on a task
    branch with backup/rollback metadata; never write private OpenClaw state.
22. **PC-206 — Provenance lock.** Store immutable source refs, content hashes,
    license, attribution, and vendored/reference status.
23. **PC-207 — Round-trip fixtures.** Verify stable export/import for company,
    team, agent, project, task, and skill examples.

Exit gate:

- exports contain no secret, absolute local path, personal memory, or generated
  private data;
- unknown/restrictive licensing blocks vendoring;
- every import is reviewable as a normal PR;
- round-trip loss is explicitly reported.

### Phase 3 — Read-only Paperclip companion (2–4 weeks)

Goal: prove observability integration while Paperclip has zero command authority.

24. **PC-301 — Connector config/schema.** Disabled by default; private URL,
    company mapping, credential reference, timeouts, scopes, and kill switch.
25. **PC-302 — Paperclip client.** Bounded retries, redacted errors, health
    checks, pagination, schema-version handling, and circuit breaker.
26. **PC-303 — Stable ID map.** Persist HQ ↔ Paperclip aliases with collision
    detection and tombstones.
27. **PC-304 — Company/project/agent projection.** Create or update mirrors from
    sanitized HQ state; never export adapter secrets.
28. **PC-305 — Task/run projection.** Mirror factory progress, GitHub links,
    summaries, liveness, and evidence references.
29. **PC-306 — Cost projection.** Publish normalized events with idempotency.
30. **PC-307 — Transactional outbox.** Retry safely and expose backlog/dead
    letters in the HQ dashboard.
31. **PC-308 — Reconciler.** Detect missing, stale, conflicting, and orphaned
    mirrors; suggest repair without overwriting HQ authority.
32. **PC-309 — Connector operations page.** Health, latency, last sync, queue
    depth, drift, credential expiry status, and disable control.

Exit gate:

- disconnecting Paperclip cannot block HQ;
- Paperclip mutation attempts cannot change canonical HQ state;
- duplicate/out-of-order events converge correctly;
- a full rebuild from HQ produces the same Paperclip projection;
- security and privacy review pass.

### Phase 4 — Controlled inbound delegation pilot (3–5 weeks)

Goal: accept a narrow request from Paperclip without ceding workflow authority.

33. **PC-401 — Signed inbound envelope.** Authenticate source, validate time and
    nonce, prevent replay, and persist before acknowledgment.
34. **PC-402 — Command policy engine.** Allow only objective requests and safe
    pause/wakeup actions for allowlisted company/project/agent combinations.
35. **PC-403 — Paperclip issue intake.** Convert an assigned issue into a
    proposed HQ task contract; classify risk and reject unsupported payloads.
36. **PC-404 — GitHub linkage.** Create/link the canonical GitHub issue through
    existing HQ intake and mirror its identifier back.
37. **PC-405 — End-to-end status sync.** Map requested → accepted → building →
    review/QA → merge-ready → merged/closed without implying that Paperclip can
    merge.
38. **PC-406 — Comment sanitation.** Treat all external text as untrusted;
    redact secrets and prevent instructions from overriding repository policy.
39. **PC-407 — Safe pause handshake.** Request checkpoint, wait for a bounded
    acknowledgment, then stop new dispatch; surface uncertain state.
40. **PC-408 — Drift incident workflow.** Create an operator incident when
    states cannot be reconciled; do not resolve by last-write-wins.
41. **PC-409 — Chaos and replay suite.** Test duplicate, delayed, reordered,
    forged, malformed, oversized, and partially applied events plus service and
    network restarts.
42. **PC-410 — Limited pilot.** One project, low-risk tasks, allowlisted agents,
    explicit cost ceiling, daily review, and documented rollback.

Exit gate:

- at least 20 synthetic and 5 real low-risk pilot tasks complete without
  authority drift, duplicate work, lost decisions, or leaked data;
- all work still ends in a PR to `main` and human merge;
- mean recovery time and operator burden are measured;
- founder reviews the pilot scorecard.

### Phase 5 — Governance, budgets, and richer UX (4–8 weeks)

Goal: add mature operator controls after the bridge is reliable.

43. **PC-501 — Approval projection.** Mirror Decision Cards into Paperclip while
    making authority and signature requirements unmistakable.
44. **PC-502 — Revision-request flow.** Let founder feedback return through the
    existing HQ decision/resume path with linked evidence revisions.
45. **PC-503 — Budget alert policy.** Configurable thresholds and escalation
    routing using the normalized ledger.
46. **PC-504 — Safe hard-stop design.** Architecture review for checkpointing,
    lease release, worktree preservation, recovery, and founder override.
47. **PC-505 — Safe hard-stop implementation.** Enable only after fault-injection
    tests prove no corruption or gate bypass.
48. **PC-506 — Org chart routing hints.** Use capabilities/reporting lines in
    Chief-of-Staff recommendations while retaining explicit factory routing.
49. **PC-507 — Run detail view.** Structured transcript events, evidence,
    timeline, cost, retries, and redaction; raw private conversation excluded.
50. **PC-508 — Agent scorecards.** Reliability, acceptance pass rate, review
    findings, recovery frequency, cost/outcome, and confidence intervals.
51. **PC-509 — Learning integration.** Feed repeated verified patterns to the
    learning queue; require normal PR/review for policy or prompt changes.
52. **PC-510 — Retention and export controls.** Per-event retention, deletion
    workflow, portable audit export, and privacy review.

Exit gate:

- budget stops are safe and reversible;
- permission tests cover every mutating endpoint and company boundary;
- scorecards do not reward speed/cost at the expense of acceptance or safety;
- retention behavior is documented and tested.

### Phase 6 — Strategic convergence decision (after 8–12 weeks of operation)

Goal: select a long-term topology from evidence.

Choose one:

**A. Native HQ with Paperclip concepts.** Keep the bridge optional and continue
small attributed ports. Best when GitHub-centric software delivery and a lean
mini-PC footprint dominate.

**B. Federated companion.** HQ owns software delivery; Paperclip owns portfolio
org/goals/budget presentation. Best when non-coding agents and multiple ventures
need richer company operations.

**C. Paperclip primary control plane.** Paperclip owns company, agents, goals,
and general issues; the HQ factory becomes a specialized software-delivery
service invoked by a Paperclip adapter. Best only if Paperclip's UI/ecosystem
clearly reduces maintenance and its governance can preserve all HQ invariants.

Option C requires a separate high-risk migration program, including:

- a durable-authority decision and revised project context/config;
- mapping and migration of all IDs, tasks, decisions, costs, and audit history;
- integration of signed approvals and human merge;
- a factory adapter that cannot invoke arbitrary commands or bypass `./run.sh`;
- coexistence freeze, consistency checks, cutover, and tested rollback;
- backup/restore and disaster-recovery exercises;
- security review of auth, company isolation, secrets, plugins, and exposure;
- removal or archival of the superseded HQ workflow/UI to avoid permanent
  duplicate ownership.

Do not choose C merely because Paperclip has more features. Choose it only if
the pilot demonstrates lower operator effort, equal or stronger safety, stable
upstream maintenance, acceptable mini-PC resources, and a credible migration
and rollback path.

## 6. Test and evidence strategy

### Contract tests

- versioned fixtures for every inbound/outbound object;
- unknown-field and forward-version behavior;
- required-field, length, enum, timestamp, and identifier validation;
- deterministic mappings and stable idempotency keys;
- redaction tests with canary secrets.

### Concurrency and recovery tests

- 100 concurrent lease attempts yield one owner;
- same-run reacquisition is idempotent;
- expired lease recovery is audited;
- crash after local commit but before acknowledgment replays safely;
- crash after external success but before cursor update reconciles safely;
- out-of-order terminal and non-terminal updates cannot regress state;
- Paperclip outage and restart do not pause the factory;
- HQ restart reconstructs pending delivery from durable state.

### Security tests

- forged/missing/expired signatures;
- nonce replay and duplicate delivery;
- cross-company/project/agent scope violations;
- prompt injection in title, comment, attachment name, and document;
- SSRF through URLs and attachment references;
- oversized payload and event flooding;
- log/evidence/UI secret leakage;
- revoked key and emergency connector disable;
- permission matrix tests for every mutating action.

### Factory invariant tests

- no direct push to `main`;
- every code change gets a new branch/worktree and PR;
- only one writable agent owns a branch;
- Paperclip cannot select or reuse a worktree;
- author cannot be sole reviewer;
- acceptance, verification, review, QA, and decision gates remain required;
- high-risk action still needs a valid external founder signature;
- no connector action can merge or deploy;
- registered-agent execution remains `./run.sh` only.

### Pilot scorecard

Track:

- objective-to-merge-ready lead time;
- founder interventions per completed task;
- duplicate/lost/drift incidents;
- successful automatic recoveries and false recoveries;
- review/QA escape rate;
- cost per accepted outcome, not merely per run;
- connector availability and p95 synchronization latency;
- event backlog/dead letters;
- CPU, memory, storage growth, and backup time;
- time to disable connector and restore standalone HQ operation.

## 7. Operational design

### Deployment

For the first pilot, run Paperclip as a separately pinned service on the same
private host or isolated lab host. Bind to loopback or the private network only.
Use an explicit data directory, health check, resource limits, log rotation,
backup job, and service dependency that does **not** make HQ startup depend on
Paperclip.

Paperclip currently requires Node 24.11+ and pnpm 9 in its source tree and uses
PostgreSQL/PGlite rather than HQ's SQLite.[^3] Do not merge package managers,
databases, or migration histories. Operate it as an external component until a
convergence decision is made.

### Versioning and upgrades

- pin an immutable commit or released package/image digest;
- record API/schema capabilities discovered at startup;
- upgrade only through a dedicated PR and disposable smoke environment;
- preserve a known-good rollback artifact and database backup;
- run contract, OpenClaw gateway, auth, replay, and reconciliation tests before
  promotion;
- subscribe to upstream security/release notices;
- never track a moving `master` branch in production.

### Observability

Expose connector health without leaking payloads:

- enabled/disabled and mode;
- upstream version/commit and API compatibility;
- last inbound/outbound success;
- latency, retry count, circuit state, queue depth, oldest event age;
- reconciliation drift counts;
- auth/scope/replay denials;
- redaction counts;
- data/backup age and storage utilization.

### Backup and rollback

The bridge must be removable without data loss. Canonical HQ and GitHub state
must remain complete. Before each Paperclip upgrade or mapping migration:

1. stop inbound commands;
2. drain or snapshot the outbox;
3. back up Paperclip and connector state;
4. record versions and integrity hashes;
5. perform the change;
6. reconcile read-only;
7. re-enable commands only after checks pass.

Rollback disables inbound commands first, restores the pinned service/database
if necessary, resets only the projection cursor, and rebuilds Paperclip mirrors
from HQ. It must never roll canonical HQ/GitHub state backward to match a stale
projection.

## 8. Risks and mitigations

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Split-brain task/workflow ownership | Critical | Authority matrix, one-way phases, reconciliation, no last-write-wins |
| Approval bypass | Critical | HQ signatures remain authoritative; deny merge/deploy/high-risk commands |
| Secret/private-state leakage | Critical | References not values, redaction, private stores, canary tests, scoped identities |
| Prompt injection via external task data | High | Treat payloads as untrusted data, strict command schema, immutable system policy |
| Duplicate agent work | High | Atomic leases, idempotency, one writer/worktree, conflict is terminal for claimant |
| Cost hard-stop corrupts active work | High | Visibility first; checkpoint/pause design and fault tests before enforcement |
| Cross-company data leakage | High | Company/project scoping, permission matrix, negative tests, pilot with one company |
| Upstream churn/API incompatibility | High | Pin versions, anti-corruption layer, fixtures, capability negotiation |
| Mini-PC resource pressure | Medium | Benchmark, limits, retention, separate service, explicit capacity gate |
| Audit/transcript data growth | Medium | Structured summaries, retention, compaction, evidence references |
| UX confusion about authoritative status | Medium | Canonical links, badges, drift alerts, consistent state terminology |
| Maintenance burden of two dashboards | Medium | Score operator effort; Phase 6 converge or remove |
| License/attribution loss | Medium | Provenance manifest, preserve MIT notice, review vendored assets/dependencies |

## 9. Founder decisions required

No founder decision is needed to keep this document or run a synthetic,
credential-free local analysis. Before Phase 0 operates a Paperclip service,
present a Decision Card covering:

- whether the goal is concept reuse, companion operation, or evaluation for
  eventual replacement;
- whether Paperclip may receive any real project/task/cost data;
- allowed host/network exposure and data retention;
- maximum mini-PC resources and any acceptable spend.

Before Phase 4, obtain a separate approval for inbound command authority. Before
Phase 5 hard budget enforcement, approve pause/override semantics. Before Phase
6 Option C, approve the product-direction and migration decision.

## 10. Recommended first release train

The highest-value, lowest-regret sequence is:

1. PC-002 threat model.
2. PC-005 schema crosswalk fixtures.
3. PC-101/102 actor-attributed audit envelope.
4. PC-103 atomic task leases.
5. PC-104/105 wakeups and run liveness.
6. PC-106/107 cost ledger and visibility.
7. PC-201/202 package mapping and read-only linter.
8. PC-301–309 read-only connector only if the founder still wants Paperclip in
   the live topology.

This gives HQ most of Paperclip's operational value while preserving the option
to stop before adding another production service. It also creates clean seams
for an eventual Paperclip-primary architecture without committing to it now.

## 11. Definition of integration success

The integration succeeds when the founder can understand goals, active work,
agent ownership, cost, risk, decisions, and delivery evidence with less effort,
while the system retains one unambiguous authority for every state transition.
Feature count is not the success criterion.

The final acceptance conditions are:

- operator intervention per accepted outcome decreases;
- no loss of GitHub auditability or factory evidence;
- no weakening of the execution, approval, review, QA, merge, or privacy
  boundaries;
- connector failure cannot halt or corrupt HQ;
- every cross-system action is attributable, idempotent, and reconcilable;
- costs and resource use remain within explicit limits;
- the topology can be rolled back to standalone HQ;
- a Phase 6 decision is made from measured results rather than feature appeal.

## Sources

[^1]: Paperclip AI, [MIT License](https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/LICENSE), accessed 2026-09-09.
[^2]: Paperclip AI, [Paperclip README](https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/README.md), accessed 2026-09-09.
[^3]: Paperclip AI, [Architecture](https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/docs/start/architecture.md), accessed 2026-09-09.
[^4]: Paperclip AI, [Heartbeat Protocol](https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/docs/guides/agent-developer/heartbeat-protocol.md), accessed 2026-09-09.
[^5]: Paperclip AI, [Costs and Budgets](https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/docs/guides/board-operator/costs-and-budgets.md), accessed 2026-09-09.
[^6]: Paperclip AI, [Agent Companies Specification](https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/docs/companies/companies-spec.md), accessed 2026-09-09.
[^7]: Paperclip AI, [OpenClaw Gateway Adapter](https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/packages/adapters/openclaw-gateway/README.md), accessed 2026-09-09.
[^8]: Paperclip AI, [OpenClaw Onboarding Checklist](https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/doc/OPENCLAW_ONBOARDING.md), accessed 2026-09-09.
[^9]: Paperclip AI, [Approvals](https://github.com/paperclipai/paperclip/blob/6abeb67334348dcb6fde2d591a27ffc7efc7118d/docs/guides/board-operator/approvals.md), accessed 2026-09-09.


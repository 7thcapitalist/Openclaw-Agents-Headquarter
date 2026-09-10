# Paperclip → HQ: final source-level comparison

- **Upstream:** `paperclipai/paperclip` at `6abeb67334348dcb6fde2d591a27ffc7efc7118d` (MIT)
- **Audited against HQ `main`** after the #128–#155 campaign
- **Method:** source-level. Schema, services, routes, middleware, adapters, UI
  pages, test suites and operational documentation were read directly. The
  README and the visible UI were not treated as evidence of anything.

## Surface actually inspected

| Surface | Size | What was read |
| --- | --- | --- |
| Database schema | 133 table modules | Every filename; the capability-bearing ones opened |
| Migrations | 270 SQL files + `check-migration-safety.ts` | Numbering, safety-rule scanner, size baseline |
| Server services | 308 modules | Full listing; ~60 opened, prioritised by capability |
| Routes | 67 modules | Full listing; `authz`, `dashboard`, `goals`, `issues`, `approvals` opened |
| Middleware | 14 modules | Auth, board-mutation guard, private-hostname guard, redaction, validate |
| Adapters | 13 packages | `openclaw-gateway` in depth; the rest by contract |
| UI pages | 78 components | Full listing; the operator-facing ones by role |
| Tests | 1,824 files | Concurrency, replay, recovery, permission and negative suites sampled |
| Docs | `deploy/`, `start/`, `guides/`, `companies/` | Read for operational contract |

---

## 1. Capabilities brought into HQ

Each row: Paperclip source → HQ implementation → PR → verification.

### Provenance and licensing

| | |
| --- | --- |
| **Paperclip** | Repository-wide MIT licensing |
| **Behaviour** | N/A — obligation, not capability |
| **HQ** | `factory/third-party/provenance.json`, `scripts/check-third-party-provenance.mjs` |
| **Gap closed** | Every adapted artifact records source path and classification |
| **PR** | #89 |
| **Evidence** | `npm run check:provenance` — every adapted artifact recorded, enforced in CI (#133), so an unrecorded adaptation fails the build |
| **Disposition** | `useful-adaptation` — **done** |

### Actor-attributed audit

| | |
| --- | --- |
| **Paperclip** | `packages/db/src/schema/activity_log.ts`, `services/activity-log.ts` |
| **Behaviour** | Company-scoped activity rows with actor type, action, entity, details |
| **HQ** | `factory/lib/audit/envelope.mjs` — append-only NDJSON, closed actor/subject vocabularies, sanitised `data` |
| **Gap closed** | HQ had task events with no attributable actor and no durable envelope |
| **PR** | #91, wired to real dispatch in #105 |
| **Evidence** | `factory/test/audit-envelope.test.mjs`, `dispatch-telemetry.test.mjs` |
| **Disposition** | `useful-adaptation` — **done** |

### Atomic task ownership

| | |
| --- | --- |
| **Paperclip** | `services/agent-start-lock.ts`, `schema/execution_workspace_runtime_leases.ts` |
| **Behaviour** | Exclusive start lock per agent; runtime leases with expiry |
| **HQ** | `factory/lib/leases/task-lease.mjs` — acquire, renew, expire, conflict, audited force-release |
| **Gap closed** | Two runners could drive one task |
| **PR** | #92 |
| **Evidence** | `factory/test/task-lease.test.mjs` incl. concurrent-acquire and stale-reclaim |
| **Disposition** | `useful-port` — **done** |

### Durable wakeups

| | |
| --- | --- |
| **Paperclip** | `schema/agent_wakeup_requests.ts`, `services/heartbeat.ts` |
| **Behaviour** | Identifier-bearing wake requests, claimed and retried |
| **HQ** | `factory/lib/wakeups/queue.mjs` + `worker.mjs` — **rejects any item carrying `command` or `payload`** |
| **Gap closed** | No durable way to resume parked work |
| **PR** | #93, #106 |
| **Evidence** | `wakeup-queue.test.mjs`, `wakeup-worker.test.mjs`, e2e #110 |
| **Disposition** | `useful-adaptation` — **done**. HQ's version is *narrower* than Paperclip's by design |

### Run liveness

| | |
| --- | --- |
| **Paperclip** | `services/run-liveness.ts`, `heartbeat-run-runtime-status.ts` |
| **Behaviour** | Run status distinct from issue status |
| **HQ** | `factory/lib/liveness/run-liveness.mjs` — completed / advanced / blocked / failed / plan-only / empty-response / needs-followup |
| **Gap closed** | "The task is active" could not distinguish a working agent from a silent one |
| **PR** | #94 |
| **Evidence** | `run-liveness.test.mjs` |
| **Disposition** | `useful-adaptation` — **done** |

### Normalized cost ledger, and prices for it

| | |
| --- | --- |
| **Paperclip** | `schema/cost_events.ts`, `services/costs.ts`, `services/budgets.ts` |
| **Behaviour** | Append-only cost events with corrections and confidence |
| **HQ** | `factory/lib/hq/cost-ledger.mjs`; `budget-snapshot.mjs` prices unpriced events **at read time** from `factory/pricing.json` |
| **Gap closed** | Ledger existed but every event was `costMicros: null`, so budgets could only ever answer "unavailable" |
| **PR** | #95, #139 |
| **Evidence** | Against the live ledger, 15 events went from unpriceable to 6,888 micros |
| **Disposition** | `useful-adaptation` — **done** |

### Agent organisation metadata

| | |
| --- | --- |
| **Paperclip** | `schema/agents.ts`, `services/agents.ts` |
| **HQ** | `factory/lib/hq/agents.mjs` — reporting lines, capabilities, availability, adapter refs, budgets, explicit non-authority |
| **PR** | #96 |
| **Disposition** | `useful-adaptation` — **done** |

### Agent Companies: lint, export, import preview

| | |
| --- | --- |
| **Paperclip** | `docs/companies/companies-spec.md`, `services/company-portability.ts`, `company-import-transfers.ts` |
| **HQ** | `agent-company-linter.mjs`, `agent-company-exporter.mjs`, `agent-company-import.mjs` |
| **Gap closed** | No portable company format; no way to see what a package would propose |
| **PR** | #97, #98, #154 |
| **Evidence** | 18 import tests incl. symlink escape, lint gating, field-level diff, dangling reporting lines |
| **Disposition** | `useful-adaptation` — **done**. HQ's import is preview-only; application is a reviewed PR |

### OpenClaw Gateway contract

| | |
| --- | --- |
| **Paperclip** | `packages/adapters/openclaw-gateway/src/server/execute.ts` |
| **HQ** | `factory/lib/integrations/openclaw-gateway-contract.mjs` — credential-free harness |
| **PR** | #99 |
| **Disposition** | `useful-after-evidence` — harness **done**; connecting a real Gateway remains a founder decision |

### Hierarchical goals

| | |
| --- | --- |
| **Paperclip** | `services/goals.ts`, `routes/goals.ts`, `schema/goals.ts`, `project_goals.ts` |
| **Behaviour** | Company/project goals with an **editable `status` column** |
| **HQ** | `factory/lib/hq/goals.mjs` + `factory/goals.json` — intent only; **status is always derived** from canonical work |
| **Gap closed** | No way to see whether the company is moving |
| **PR** | #128, #136 |
| **Evidence** | Live HQ: 23 canonical units, 14 blocked, across two project goals |
| **Disposition** | `useful-adaptation` — **done**. The status column is deliberately *not* ported |

### Dependency diagnostics and graph health

| | |
| --- | --- |
| **Paperclip** | `services/issue-dependency-wakeups.ts`, issue-graph liveness |
| **HQ** | `dependency-diagnostics.mjs` + `graph-observer.mjs`, wired into `runObjective` |
| **Gap closed** | A stuck objective was invisible. **The detector found 7 real objective/task divergences, 2 stale running nodes and 6 objectives with nothing runnable in live state** |
| **PR** | #129, #137 |
| **Disposition** | `useful-adaptation` — **done** |

### Budget policies and alerts

| | |
| --- | --- |
| **Paperclip** | `services/budgets.ts`, `schema/budget_policies.ts`, `budget_incidents.ts` |
| **HQ** | `budget-alerts.mjs`, `budget-policies.mjs`, `factory/budgets.json` |
| **PR** | #130, #139 |
| **Disposition** | `useful-adaptation` — **done, alert-only**. Hard stops require a Decision Card (§4) |

### Scoped permissions

| | |
| --- | --- |
| **Paperclip** | `services/agent-permissions.ts`, `authorization.ts`, `schema/principal_permission_grants.ts` |
| **Behaviour** | Fail-closed grants, `canCreateAgents`/`canCreateSkills`, trust presets |
| **HQ** | `factory/lib/hq/permissions.mjs` — closed capability list, **strictly subtractive**, founder authority superior, off/report/enforce |
| **Gap closed** | Any agent could initialise any task |
| **PR** | #141 |
| **Evidence** | 32 tests incl. forbidden-capability rejection, scope containment, audited denials |
| **Disposition** | `useful-adaptation` — **done**. The vocabulary excludes merge/deploy/billing/secrets by construction |

### Approval and decision history

| | |
| --- | --- |
| **Paperclip** | `services/approvals.ts`, `issue-approvals.ts`, `schema/approvals.ts` |
| **Behaviour** | The approvals table **is** the authority — writing `status: "approved"` authorises work |
| **HQ** | `decision-history.mjs` — a **projection**; the Ed25519 assertion remains the sole gate |
| **Gap closed** | No record of what the factory asked and what the founder answered. **Live: 6 decisions, 3 awaiting the founder** |
| **PR** | #142 |
| **Evidence** | A test asserts the module's entire export surface, so adding a writer fails the build |
| **Disposition** | `useful-adaptation` — **done**. The authority inversion is the point |

### Comments, mentions, interaction wakeups

| | |
| --- | --- |
| **Paperclip** | `services/issue-thread-interactions.ts` (3,983 lines), `issue-assignment-wakeup.ts`, `issue-queued-comment-queue.ts` |
| **HQ** | `factory/lib/hq/interactions.mjs` — untrusted-data boundary, redaction, batched mention wakeups |
| **Gap closed** | No attributed thread on a run |
| **PR** | #151 |
| **Evidence** | A hostile comment produces a wakeup whose complete key set is `{source, taskRef, actorId, contextRef, idempotencyKey}`; no export matches `/run|exec|dispatch|invoke|apply|send/` |
| **Disposition** | `useful-adaptation` — **done**. Surfacing interaction text *into agent context* is explicitly deferred (§4) |

### Unified run timeline

| | |
| --- | --- |
| **Paperclip** | `services/work-timeline.ts`, `activity.ts`, `issue-liveness.ts`, `ui/pages/Timeline.tsx` |
| **HQ** | `run-timeline.mjs` — merges seven local layers, **names each entry's source** |
| **Gap closed** | Answering "what happened to this run" meant opening seven files |
| **PR** | #148 |
| **Evidence** | 22 tests; all seven layers always listed, absent vs unreadable distinguished |
| **Disposition** | `useful-adaptation` — **done** |

### Outcome-based scorecards

| | |
| --- | --- |
| **Paperclip** | `services/agent-task-run-telemetry.ts`, `tool-runtime-metrics.ts`, `work-assessments`, `productivity-review.ts` |
| **HQ** | `agent-scorecards.mjs` — accepted outcomes, gate findings both ways, cost **per accepted outcome** |
| **Gap closed** | No basis for a routing conversation. **Live: 6 agents, `claude` n=107 with 40 gate catches** |
| **PR** | #144 |
| **Evidence** | A test asserts 20 failed dispatches score worse than 1 accepted outcome |
| **Disposition** | `useful-adaptation` — **done, advisory-only** |

### Retention, storage and backup health

| | |
| --- | --- |
| **Paperclip** | `services/decision-retention.ts`, `database-backup-health.ts`, `routes/instance-database-backups.ts` |
| **HQ** | `factory/lib/hq/retention.mjs` + `scripts/factory-retention.mjs` |
| **Gap closed** | No visibility into what runtime state costs or whether a backup exists. **Live: 407 files, 2.5MB, 0 eligible** |
| **PR** | #146 |
| **Evidence** | Every CLI refusal path tested; the guard accidentally refused a run against the **real** tree during development and all 407 files survived |
| **Disposition** | `useful-adaptation` — **done** |

### Connector reliability primitives

| | |
| --- | --- |
| **Paperclip** | `services/paperclip-cloud-connector.ts`, `execution-control-reconciliation.ts`, `managed-resource-drift.ts` |
| **HQ** | `connector-outbox.mjs` — **imports `fs`, `path`, `crypto` and nothing else** |
| **PR** | #155 |
| **Evidence** | A test reads the source and asserts the absence of every network primitive |
| **Disposition** | `useful-adaptation` — **done, disabled**. A live connector requires a Decision Card (§4) |

---

## 2. Already present in HQ before or independent of this campaign

| Paperclip | HQ equivalent | Note |
| --- | --- | --- |
| `services/issues.ts`, issue lifecycle | `factory/lib/task-workflow.mjs`, 7-stage pipeline | HQ's is gate-enforced; Paperclip's is looser |
| `services/inbox-dismissals.ts`, `issue_inbox_archives` | Founder Inbox dismiss/restore (#50), rebuilt #138 | `already-present` |
| `services/heartbeat.ts` recovery | `failure-classification.mjs`, `auto-retry.mjs`, bounded recovery (#60, #147, #149) | `already-present` |
| `services/execution-recovery-attempt.ts` | Recovery attempt bounds (#114, #147) | `already-present` |
| `services/agent-start-lock.ts` | Task leases (#92) | `already-present` |
| `schema/principal_permission_grants.ts` | Scoped permissions (#141) | `already-present` |
| `services/smoke-lab.ts` | `npm run factory:smoke` | `already-present` |
| `services/activity.ts` | `factory/lib/hq/activity.mjs` | `already-present` |
| `packages/db` transactional state | `factory/lib/store/sqlite-state.mjs` (#145) | `already-present` |
| `services/decision-signing.ts` | Ed25519 founder approval, browser-held key (#45) | HQ's is **stronger** — the key never reaches the server |

---

## 3. Inspected and deliberately not brought over

Concrete reasons, not omissions.

### Not useful for this project

| Paperclip | Why not |
| --- | --- |
| Chat providers: Discord, Slack, Telegram, Teams, GitHub chat (~40 services) | HQ's operator is one founder at one dashboard. Every one of these is an inbound network surface serving a use case this project does not have. |
| `services/plugin-*` (~30 modules), `plugin_*` schema | A plugin host is a code-execution surface. HQ's execution boundary is `./run.sh` and adding a second one weakens the invariant this repository exists to protect. |
| `services/environment-*`, `execution_workspaces`, custom images | HQ runs agents in git worktrees on one machine. Container/environment provisioning is a deployment topology HQ deliberately does not have. |
| `services/pipelines*`, `cases`, `pipeline_cases` | Paperclip's evaluation harness. HQ's equivalent is its gate pipeline plus the factory test suite. |
| `services/documents*`, `document_annotation_*` | A collaborative document system. HQ's durable documents are Markdown in Git, reviewed through PRs. |
| `services/composio.ts`, `vercel-connect.ts`, `tool-gateway.ts`, `tool_access` | Third-party tool brokering with stored credentials. Adding it would put credentials in HQ's control plane; HQ keeps them in the private OpenClaw workspace. |
| `services/invite-*`, `join_requests`, `company_memberships` | Multi-tenant membership. HQ has one founder; a membership system would add authority without adding control. |
| `services/board-*`, `BoardChat`, `board_api_keys` | A shared board for external participants — an inbound authority surface HQ explicitly does not want. |
| `services/feedback*`, `feedback_votes` | Product telemetry for a hosted product. |
| `services/cloud-instance.ts`, `managed-config.ts`, `cloud-runtime-identity.ts` | Paperclip Cloud harness contract. HQ is not a managed instance. |
| `services/secrets.ts`, `company_secret_*`, `secret-proposals.ts` | HQ's rule is that secrets never enter the repository or the control plane. A secrets subsystem inverts that. |
| `embedded-postgres-*` | HQ stores state as files plus SQLite (#145). Embedding PostgreSQL adds an operational dependency for no HQ-side gain. |

### Conflicts with HQ's architecture

| Paperclip | Conflict |
| --- | --- |
| `services/github-pull-request-merge.ts` | HQ is human-merge by policy (SFD-2026-003) and `push-to-main` is a prohibited autonomous action. An automated merge path contradicts the repository's central invariant. |
| Approvals table as authority (`services/approvals.ts`) | HQ's authority is a signed assertion the server cannot forge. A DB-row approval would be a *weaker* gate wearing the same name. Ported as history only (#142). |
| Goal `status` column (`schema/goals.ts`) | An editable goal status is a second workflow state an agent can write. HQ derives status from canonical work instead (#136). |
| `services/change-consent-gate.ts` | Consent recorded in the same store the agent writes to. HQ's consent is the founder's signature. |
| `routes/authz.ts` company-scoped RBAC | Grants authority. HQ's permission layer can only deny (#141). |

### Useful, but only after evidence HQ does not yet have

| Paperclip | What it would need first |
| --- | --- |
| `services/issue-tree-control.ts` (1,209 lines) — pause/hold an issue subtree | HQ has objective-level pause. Subtree holds need evidence that objectives are large enough for partial holds to matter. |
| `services/status-cards.ts`, `summary-slots.ts` — agent-authored status summaries | Attractive, but it is agent prose in the founder's primary view. Needs a redaction and injection story at least as strong as #151's. |
| `services/decision-queues.ts` + `attention.ts` — one queue across approvals, budget incidents, join requests, recovery | HQ's Founder Inbox covers the same ground for HQ's actual sources (#138). Revisit if the number of distinct decision sources grows. |
| `services/company-search.ts` — search across goals, issues, comments, documents | Genuinely missing from HQ (§5). Small enough to add; sized below rather than deferred. |

---

## 4. Requires a founder Decision Card

These are named so they are not quietly adopted.

1. **Launching a live Paperclip service** — host, network exposure, data scope.
2. **Enabling the connector** (#155 is deliberately transport-free) — credentials, retention, resource limits, backup, rollback.
3. **Connecting real Gateway credentials** (#99 is a credential-free harness).
4. **Hard budget stops** (#130/#139 are alert-only) — needs fault-injection proof that a stop cannot strand work mid-gate.
5. **Automatic merge or deploy** — contradicts SFD-2026-003 as it stands.
6. **Surfacing interaction text into agent context** (#151 deliberately stops short) — needs its own prompt-injection defences.
7. **Applying a company-import proposal automatically** (#154 is preview-only).
8. **Destructive retention pruning as a scheduled job** (#146 requires an operator with an exact confirmed count).

---

## 5. Remaining useful capabilities, sized

Found by this audit, not yet built, with an honest recommendation.

### 5.1 No-progress re-wake throttle — **recommended**

- **Source:** `server/src/services/issue-rewake-throttle.ts` (PAP-13775)
- **Behaviour:** After N consecutive runs that succeed but change no
  issue-visible state, further event-free wakes are held back for an escalating
  cooldown. Fresh activity, explicit resume, and human comments bypass it;
  agent-authored comments deliberately do not, so a cross-issue write cannot
  smuggle human wake privileges. Upstream measured **25 sessions and 2.4× cost
  for one recovery** before this existed.
- **HQ equivalent:** `auto-retry.mjs` bounds infra retries per stall (#147), and
  #149 distinguishes a stalled agent from one that never ran. Neither detects
  *succeeded but changed nothing*.
- **Gap:** HQ can currently pay full agent sessions repeatedly for zero new
  information, and the priced ledger (#139) now makes that cost visible without
  making it stop.
- **Operator value:** High — directly reduces spend on the failure mode this
  factory actually has.
- **Security/privacy:** None; it compares canonical state revisions.
- **Recommendation:** Implement as `factory/lib/hq/rewake-throttle.mjs`,
  consuming the run-liveness `empty-response` / `advanced` distinction that #94
  already provides. Alert-only first, then throttling.
- **Disposition:** `useful-adaptation` — **issue #157**

### 5.2 Search across goals, tasks, interactions, evidence and decisions — **recommended**

- **Source:** `server/src/services/company-search.ts`, `ui/src/pages/Search.tsx`
- **HQ equivalent:** None. HQ has **no search endpoint at all** (verified against
  the full route list).
- **Gap:** Finding "the task where the Vercel CLI pin was discussed" means
  opening objectives one at a time.
- **Operator value:** Medium-high, and rising with every capability this campaign
  added — there are now goals, decisions, interactions, timelines and scorecards
  to search.
- **Security/privacy:** Must respect the same boundaries the projections do —
  paths not contents, no prompts. Reuses `interactions.mjs` and
  `decision-history.mjs` outputs rather than reading task state directly.
- **Recommendation:** One read-only `GET /api/hq/search?q=` over already-sanitised
  projections. Deliberately not a full-text index over runtime state.
- **Disposition:** `useful-adaptation` — **issue #158**

### 5.3 Migration safety scanner — **recommended, adapted**

- **Source:** `packages/db/src/check-migration-safety.ts`, `table-size-estimates.ts`
- **Behaviour:** Static rules over migrations — loop mutation on a large table,
  unbatched full-table mutation, non-concurrent index creation.
- **HQ equivalent:** None, and HQ now has SQLite state (#145) plus several
  append-only ledgers whose formats will change.
- **Gap:** No check that a state-format change is safe against an existing tree.
- **Operator value:** Medium — grows the moment a schema changes under live data.
- **Recommendation:** Not the SQL scanner. The HQ-shaped version is a **state
  format version check**: every durable file carries `version: 1`, and a startup
  check refuses to read a version it does not understand rather than
  misinterpreting it.
- **Disposition:** `useful-adaptation` — **issue #159**

### 5.4 Cross-run influence limit — **recommended**

- **Source:** `server/src/services/cross-issue-influence-limit.ts`
- **Behaviour:** Caps how many other issues one issue's agent may affect.
- **HQ equivalent:** Partial — #141 scopes capabilities by project/task, but
  nothing bounds *volume* within a granted scope.
- **Gap:** An agent granted `company:*` can act on unlimited tasks.
- **Operator value:** Medium — a blast-radius bound distinct from a scope bound.
- **Recommendation:** A per-run counter in the permission decision path, alert-only
  first.
- **Disposition:** `useful-adaptation` — **issue #160**

### 5.5 Workspace readiness beyond a 200 — **optional**

- **Source:** `server/src/services/workspace-readiness.ts` (PAP-17572)
- **Behaviour:** "Can a user open this and see their data?" from four independent
  signals, rather than "a listener exists".
- **HQ equivalent:** `dashboard/backend/lib/readiness.mjs` and
  `/api/system/readiness`.
- **Gap:** HQ's readiness does not check that the factory state tree is readable
  and that at least one project resolves.
- **Operator value:** Low-medium — HQ is a single local process.
- **Disposition:** `useful-after-evidence` — worth doing when HQ runs somewhere
  the founder cannot see the terminal.

### 5.6 Continuation summaries — **optional**

- **Source:** `services/issue-continuation-summary.ts` (8,000-char bounded body),
  `run-continuations.ts`, `successful-run-handoff-state.ts`
- **HQ equivalent:** `factory/lib/handoff.mjs` writes a per-stage handoff; #94
  records bounded continuation decisions.
- **Gap:** No compact carry-forward across a *recovery* boundary.
- **Disposition:** `useful-after-evidence` — the #152/#153 recovery-context work
  in flight may close this without a separate capability.

---

## 6. Negative and adversarial tests worth borrowing

Paperclip's 1,824 test files were sampled for cases HQ lacks. Three patterns
were adopted during this campaign and are recorded here as method, not gap:

- **Assert the export surface**, not just behaviour — `decision-history`,
  `agent-scorecards`, `agent-company-import` and `interactions` each have a test
  that fails if someone adds a writer or an execution path.
- **Assert the absence of a capability by reading the source** —
  `connector-outbox` proves it has no network primitive.
- **Exercise the real dependency, not a mock** — the interaction tests enqueue
  through the *real* wakeup queue so the command rejection is proven, not
  assumed.

One further pattern is **not yet adopted and is worth having**: Paperclip's
migration tests assert *snapshot drift* — that the declared schema and the
applied migrations agree. HQ's analogue is §5.3.

---

## 7. Is HQ now more useful than adopting Paperclip?

For **this project's actual use case** — one founder, one machine,
GitHub-as-authority, agents that must never act unattended beyond policy — yes,
and for reasons that are structural rather than a feature count.

| Dimension | Paperclip | HQ after this campaign |
| --- | --- | --- |
| **Authority for a high-risk build** | A database row an authenticated principal can write | An Ed25519 assertion signed by a key that never leaves the founder's browser (#45) |
| **Merge** | Automatable | Human-only by policy, `push-to-main` prohibited |
| **Goal status** | An editable column | Derived from canonical work; a claimed status changes nothing (#136) |
| **Approval record** | *Is* the gate | A projection; the gate is the signature (#142) |
| **Agent authority** | Grants capabilities | Can only deny; cannot confer merge, deploy, billing or secrets (#141) |
| **Comment text** | Reaches agent context | Untrusted data; can only cause an identifier-bearing wakeup (#151) |
| **Connector** | Live cloud connector | Transport-free by construction; a test proves it (#155) |
| **Deletion** | Retention services | An operator at a terminal with an exact confirmed count (#146) |
| **Rollback** | Migrations against a live database | `git revert`; every capability added here writes nothing canonical |
| **Audit trail** | Activity log in the same database | Git history plus append-only local ledgers |

Paperclip has far more features. Most of them are for a product HQ is not: a
multi-tenant hosted service with chat integrations, a plugin host, provisioned
environments and a tool gateway. Adopting it would mean adopting a second
control plane, a second authority model, a second place secrets live, and a
network surface — in exchange for capabilities this founder does not need.

What HQ took is the part that was genuinely better: **operational vocabulary**.
Attributed audit, leases, durable wakeups, run liveness distinct from task
state, a normalised cost ledger, dependency diagnostics, and the discipline of
reporting degraded sources honestly. Every one of those was adapted so that HQ's
existing invariants — human merge, signed approval, one writer per branch,
`./run.sh`, secrets outside the repository — hold unchanged.

### The evidence that this was worth doing

The campaign did not only add features. Against **live HQ state** it found:

- **45,399 leaked test fixtures** exhausting the host's inode table (#132)
- **7 objective/task divergences** silently stranding dependent nodes (#137)
- **A cost ledger with no prices in it**, making budgets structurally incapable
  of reporting spend (#139)
- **11 recoveries mis-attributed** to the agent that performed them rather than
  the one that caused them (#144)
- **A rebase that mis-wired the dashboard** so panels rendered each other's data
  (#142)

None of those were visible before the capabilities that surfaced them existed.

---

## 8. Stopping condition

| Condition | Status |
| --- | --- |
| Every Paperclip-related PR merged, superseded, or rejected with a reason | ✅ #128–#148 merged; #151, #154, #155 open for founder merge |
| Every capability selected as useful implemented and integrated | ✅ Each has a library, an API surface and a founder-facing view |
| Dependency PRs refreshed against latest `main` | ✅ Every PR rebased and re-verified after its predecessors merged |
| Focused tests pass | ✅ |
| Full-factory tests pass | ✅ 823 tests, 0 fail, 0 skipped at #155 |
| UI has responsive/accessibility verification and visual evidence | ✅ Every panel rendered at 1024px and 380px in all states |
| Provenance validation passes | ✅ Enforced in CI on every PR (#133). One source; the artifact count grows with each merged capability, so it is not restated here |
| End-to-end scenarios cover the failure modes | ✅ #110 plus per-capability degraded/replay/restart/malformed cases |
| Operator runbooks cover health, enablement, retention, backup, recovery, disablement, rollback | ✅ One `PAPERCLIP_*.md` per capability. **Thirteen of the earlier ones had no rollback section; this PR adds one to each**, written from what that capability actually leaves behind rather than from a template |
| No remaining Paperclip capability would materially improve HQ without violating its architecture or needing an unresolved founder decision | ⚠️ **Four remain, sized in §5.1–5.4 and opened as #157, #158, #159, #160.** None blocks any merged capability |
| Every relevant capability mapped to an HQ implementation, a justified exclusion, or a Decision Card | ✅ §1, §2, §3, §4 |
| HQ provides equal or better operator value with stronger auditability, control, privacy and rollback | ✅ §7 |

**Conclusion.** The campaign is complete for the capabilities it set out to
bring over. Four further capabilities are worth having and are sized above; they
are tracked as #157, #158, #159 and #160 rather than left as unfinished work,
because each is independently valuable and none is a dependency of anything
already merged.

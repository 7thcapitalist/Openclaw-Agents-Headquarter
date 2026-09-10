# Founder Control Plane

The Founder Control Plane is the dashboard view for operating the existing
OpenClaw software factory without constructing JSON requests by hand. Open the
dashboard and use **Today**.

## What the founder can do

- Create a project profile with an optional repository path.
- Enter a natural-language outcome and start the existing factory pipeline.
- See each project's mission, health score, top risk, and open decisions
  alongside its live task status — the portfolio reads like a company, not a
  job queue.
- See project status, current stage, assigned agent, blocker, and last activity.
- Pause a project so no new tasks can be launched, then resume it later.
- Archive a decomposed objective off the main Today view when it is no longer
  worth watching, and unarchive it later. Archiving changes only presentation —
  the objective's state, report, evidence, metrics, and GitHub history are kept.
- See live task dispatches and durable factory events.
- Ask a configured OpenClaw agent a question.
- Answer normal Decision Cards and resume the blocked task.
- Submit an externally signed assertion for high-risk build approval.

## Project intelligence

`GET /api/founder/overview` no longer returns tasks alone — it understands
projects. For every project registered in `factory/projects.json`, the control
plane loads that project's context layer (see
`PROJECT_INTELLIGENCE_SYSTEM.md`) and folds it into the response:

- **`projects[].intelligence`** — the structured brief: `mission`, `vision`
  (statement, bet, non-goals), `roadmap` (current / next / later / deferred),
  `decisions` (parsed from `DECISIONS.md`), `memory` (recent durable facts),
  `ownership` (success metrics, priorities, risks, open decisions, responsible
  agents), `risks` (normalised, each flagged `unmitigated`), and
  `contextFindings` (missing / thin / stale files). `null` for a project that
  is not registered.
- **`projects[].health`** — `{ score (0–100), level: healthy | needs-attention
  | at-risk, reasons[] }`, derived deterministically from blocked/failing
  tasks, unmitigated high risks, unresolved decisions, and context gaps.
- **`company`** — the portfolio view: `projects[]` (health + phase + metrics +
  top risk per project), `openDecisions` (task-blocker decisions **and**
  strategic decisions a project is still carrying in `ownership.json`),
  `risks` (all projects, severity-sorted), `opportunities` (idle priorities,
  metrics at target, milestones ready to advance), `recommendedActions` (a
  ranked list: answer blocked decisions, resolve strategic decisions, mitigate
  risks, fill missing context, then consider opportunities), and a `summary`
  count line.
- **`openDecisions`** — top-level convenience: the merged decision list.

Everything is additive. The prior keys (`projects`, `tasks`, `decisions`,
`questions`, `activity`, `jobs`) are unchanged, and the endpoint still succeeds
if `factory/projects.json` is absent or a context directory is unreadable —
intelligence just degrades to `null` for that project.

The same data is available offline:
`node scripts/project-intel.mjs '{"version":1,"action":"brief","project":"<key>"}'`
for one project, `{"action":"briefing"}` for the whole portfolio.

Agents are unaffected in mechanism but better informed: `writeHandoff()` (used
by the pipeline **and** by the control plane's `resolveFounderDecision`) already
prepends `factory context + project context + task context` to every handoff.

## Architecture boundary

The dashboard is an adapter and projection, not a workflow engine. Task truth
continues to live in the existing factory `state.json` files. Starting work calls
the `start` action in `scripts/openclaw-factory.mjs`; resolving a decision uses
the existing task resume transition; high-risk approval uses the existing
Ed25519 verification path.

The local `control-plane.json` file stores only dashboard concerns: project
pause flags, question history, launch-job status, and the founder's
objective-archive flags (`archivedObjectives`). It is runtime data under
`dashboard/backend/data/factory/` and is gitignored.

The Today objective portfolio is bucketed by a pure `objectiveLifecycle()`
projection: **Active** (the presenter's Running / Waiting for you / Blocked /
Recently completed), **History** (older or long-finished work — collapsed), and
**Archived** (explicitly dismissed by the founder — collapsed, fully
recoverable). Objectives that need the founder (`WAITING_FOR_FOUNDER`,
`BLOCKED`) stay Active until resolved or archived regardless of age;
running/pending/failed work falls to History once it has been silent past
`HQ_OBJECTIVE_ACTIVE_STALE_MS` (default 12h) with no pending recovery; completed
work stays Active for `HQ_OBJECTIVE_RECENT_COMPLETE_MS` (default 72h).

Pausing a project prevents new task launches. It does not terminate an agent
that is already running, because killing a live harness could leave a worktree
or evidence write in an unknown state.

## Founder inbox

When an agent returns `decision-required`, it should write evidence using
`factory/templates/decision-card.md`. The dashboard reads that evidence and
shows the decision, why it matters, options, and recommendation.

For low- and medium-risk decisions, the founder's response is persisted in the
task state and included in the next handoff before the normal resume transition.
For high-risk builder approval, create the signed assertion as documented in
`SETUP.md`, then submit the assertion path and worktree-relative evidence path
through the dashboard. The private key is never read by the dashboard.

### The inbox is a human interface — non-negotiable

The Founder Inbox is for the founder, not for an operator. It must never read
like an incident dashboard, a task log, or a factory state dump. Every item
answers exactly four questions, in this order, and a founder must be able to
answer them in under ten seconds:

1. **What do you need from me?** — the type (Approval / Decision / Blocker /
   Question / Recovery) and a short human title.
2. **Why?** — one or two sentences of context, in the founder's vocabulary.
3. **What happens if I do it?** — one sentence about what the factory does next.
4. **What should I click?** — the actions that actually exist.

`factory/lib/hq/founder-inbox.mjs` is the translation layer that produces this.
It is pure: it reads the inbox items `buildFounderInbox` already assembles,
derives a founder-readable card (`item.founder`), and collects the operator view
under `item.technical`. Raw fields (`kind`, `title`, `detail`, `action`,
`options`, `statePath`) are preserved untouched for existing readers.

What must stay **out of** the primary card, and live only behind
"View details": raw objective prompts, UUIDs and task ids, model or harness
names, stack traces, full agent reports, git commands, filesystem paths, task
contracts, raw JSON, evidence blobs, retry histories, and stage vocabulary
(`decision-required`, `builder blocked`, `release gate`). Ids may appear as
tiny secondary metadata for debugging, never as the heading.

Ordering is by what is actually holding the founder up — approval gates first,
then live work that is stopped, then failures the factory could not recover
from, then high-impact choices with nothing stalled behind them, then anything
informational. It is never ordered primarily by `updatedAt`, task creation time,
severity string, internal stage, or historical failure timestamp. When nothing
genuinely requires the founder, the inbox says "You're all caught up." — no
fake alerts, no stale failures, no historical noise.

`dashboard/backend/public/lib/founderInbox.mjs` renders the card and maps its
actions onto the dashboard's existing handlers, so presentation changes never
introduce new endpoints or new workflow. The contract is covered by
`factory/test/founder-inbox-translation.test.mjs`.

## HTTP endpoints

All endpoints require the normal authenticated dashboard session.

- `GET /api/founder/overview`
- `POST /api/founder/projects`
- `POST /api/founder/projects/:id/pause`
- `POST /api/founder/projects/:id/resume`
- `POST /api/founder/tasks`
- `POST /api/founder/questions`
- `POST /api/founder/decisions/resolve`
- `POST /api/founder/decisions/approve`

Launches are asynchronous. Their status survives dashboard restarts and appears
in the activity feed while the durable factory task is created and executed.

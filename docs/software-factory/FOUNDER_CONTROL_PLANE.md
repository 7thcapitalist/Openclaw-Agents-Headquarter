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
pause flags, question history, and launch-job status. It is runtime data under
`dashboard/backend/data/factory/` and is gitignored.

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
